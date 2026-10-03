import { and, count, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  materiais,
  obras,
  requisicaoItens,
  requisicoes,
  utilizadores,
} from '../db/schema.js';
import { hojeISO } from '../lib/datas.js';
import { ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../lib/erros.js';
import { arred3, paraNum } from '../lib/money.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';
import { proximoNumero } from './numeracao.js';
import { registarMovimento, type Movimento } from './stock.js';

/**
 * Fluxo da requisicao:
 *
 *   pendente --aprovar--> aprovada --atender--> atendida
 *      |                      |
 *      +----rejeitar-----------+----rejeitar
 *
 * Aprovar e um acto administrativo; atender e o que mexe no stock (cria as
 * saidas) e e o unico ponto onde isso acontece. Por isso atender so e
 * possivel a partir de `aprovada` — caso contrario um armazem poderia
 * entregar material que ninguem autorizou.
 */
export const schemaCriarRequisicao = z.object({
  obraId: z.string().uuid(),
  observacoes: z.string().max(1000).nullable().optional(),
  itens: z
    .array(
      z.object({
        materialId: z.string().uuid(),
        quantidade: z.coerce.number().positive('A quantidade tem de ser maior que zero'),
      }),
    )
    .min(1, 'A requisicao precisa de pelo menos um item'),
});

export const schemaDecisao = z.object({
  observacoes: z.string().max(1000).nullable().optional(),
});

export const schemaAtender = z.object({
  observacoes: z.string().max(1000).nullable().optional(),
  itens: z
    .array(
      z.object({
        materialId: z.string().uuid(),
        quantidade: z.coerce.number().positive(),
      }),
    )
    .optional()
    .describe('Omitir para atender tudo o que foi pedido'),
});

export async function criarRequisicao(
  db: Database,
  tenantId: string,
  solicitanteId: string,
  entrada: z.infer<typeof schemaCriarRequisicao>,
  ctx: Contexto,
) {
  const [obra] = await db
    .select({ id: obras.id })
    .from(obras)
    .where(and(eq(obras.id, entrada.obraId), eq(obras.tenantId, tenantId), isNull(obras.deletedAt)))
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', entrada.obraId);

  // Materiais repetidos na mesma requisicao somariam duas linhas em vez de uma.
  const consolidado = new Map<string, number>();
  for (const item of entrada.itens) {
    consolidado.set(
      item.materialId,
      arred3((consolidado.get(item.materialId) ?? 0) + item.quantidade),
    );
  }

  const ids = [...consolidado.keys()];
  const existentes = await db
    .select({ id: materiais.id })
    .from(materiais)
    .where(
      and(
        eq(materiais.tenantId, tenantId),
        isNull(materiais.deletedAt),
        inArray(materiais.id, ids),
      ),
    );
  if (existentes.length !== ids.length) {
    throw new ErroValidacao('Ha materiais na lista que nao existem ou estao inactivos');
  }

  return db.transaction(async (tx) => {
    const codigo = await proximoNumero(tx, tenantId, 'REQ');

    const [requisicao] = await tx
      .insert(requisicoes)
      .values({
        tenantId,
        obraId: entrada.obraId,
        solicitanteId,
        estado: 'pendente',
        observacoes: entrada.observacoes ?? null,
        codigo,
      })
      .returning();

    if (!requisicao) throw new ErroValidacao('Falha ao criar a requisicao');

    await tx.insert(requisicaoItens).values(
      [...consolidado.entries()].map(([materialId, quantidade]) => ({
        requisicaoId: requisicao.id,
        materialId,
        quantidade: quantidade.toFixed(3),
      })),
    );

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'requisicao.criada',
      entidade: 'requisicao',
      entidadeId: requisicao.id,
      dadosDepois: { codigo, itens: [...consolidado.entries()] },
      ip: ctx.ip,
    });

    return requisicao;
  });
}

export async function obterRequisicao(db: Database, tenantId: string, id: string) {
  const [requisicao] = await db
    .select()
    .from(requisicoes)
    .where(and(eq(requisicoes.id, id), eq(requisicoes.tenantId, tenantId)))
    .limit(1);
  if (!requisicao) throw new ErroNaoEncontrado('Requisicao', id);

  const itens = await db
    .select({
      id: requisicaoItens.id,
      materialId: requisicaoItens.materialId,
      material: materiais.nome,
      unidade: materiais.unidade,
      quantidade: requisicaoItens.quantidade,
      quantidadeAtendida: requisicaoItens.quantidadeAtendida,
      // Saldo actual na obra: o armazem ve o que tem antes de comprometer.
      saldoObra: sql<string>`coalesce((SELECT saldo FROM v_stock_actual v
                                        WHERE v.obra_id = ${requisicoes.obraId}
                                          AND v.material_id = ${requisicaoItens.materialId}), 0)`,
    })
    .from(requisicaoItens)
    .innerJoin(materiais, eq(materiais.id, requisicaoItens.materialId))
    .where(eq(requisicaoItens.requisicaoId, id));

  return {
    ...requisicao,
    itens: itens.map((i) => {
      const saldo = paraNum(i.saldoObra);
      const pedido = paraNum(i.quantidade);
      return {
        ...i,
        saldoObra: arred3(saldo),
        pendente: arred3(pedido - paraNum(i.quantidadeAtendida)),
        suficiente: saldo >= pedido - paraNum(i.quantidadeAtendida),
      };
    }),
  };
}

export async function listarRequisicoes(
  db: Database,
  tenantId: string,
  filtro: {
    estado?: 'pendente' | 'aprovada' | 'rejeitada' | 'atendida';
    obraId?: string;
    solicitanteId?: string;
    limite?: number;
  },
) {
  const cond = [eq(requisicoes.tenantId, tenantId), isNull(requisicoes.deletedAt)];
  if (filtro.estado) cond.push(eq(requisicoes.estado, filtro.estado));
  if (filtro.obraId) cond.push(eq(requisicoes.obraId, filtro.obraId));
  if (filtro.solicitanteId) cond.push(eq(requisicoes.solicitanteId, filtro.solicitanteId));

  return db
    .select({
      id: requisicoes.id,
      codigo: requisicoes.codigo,
      estado: requisicoes.estado,
      obraId: requisicoes.obraId,
      obraNome: obras.nome,
      obraCodigo: obras.codigo,
      solicitanteId: requisicoes.solicitanteId,
      solicitante: utilizadores.nome,
      observacoes: requisicoes.observacoes,
      criadoEm: requisicoes.criadoEm,
      aprovadaEm: requisicoes.aprovadaEm,
      nItens: sql<number>`(SELECT count(*)::int FROM requisicao_itens ri WHERE ri.requisicao_id = ${requisicoes.id})`,
    })
    .from(requisicoes)
    .innerJoin(obras, eq(obras.id, requisicoes.obraId))
    .innerJoin(utilizadores, eq(utilizadores.id, requisicoes.solicitanteId))
    .where(and(...cond))
    .orderBy(desc(requisicoes.criadoEm))
    .limit(filtro.limite ?? 100);
}

/**
 * Aprova. Quem pede nao pode aprovar: um encarregado que requisita e aprova
 * o proprio pedido nao tem ninguem a responder a ele.
 */
export async function aprovarRequisicao(
  db: Database,
  tenantId: string,
  id: string,
  aprovadorId: string,
  ctx: Contexto,
  observacoes?: string | null,
) {
  const requisicao = await obterRequisicao(db, tenantId, id);

  if (requisicao.estado !== 'pendente') {
    throw new ErroRegraNegocio(
      `So se approve requisicoes pendentes. Esta esta "${requisicao.estado}".`,
    );
  }
  if (requisicao.solicitanteId === aprovadorId) {
    throw new ErroRegraNegocio('Nao pode aprovar uma requisicao que fez voce mesmo');
  }

  const [depois] = await db
    .update(requisicoes)
    .set({
      estado: 'aprovada',
      aprovadorId,
      aprovadaEm: new Date(),
      observacoes: observacoes ?? requisicao.observacoes,
      updatedAt: new Date(),
    })
    .where(eq(requisicoes.id, id))
    .returning();

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'requisicao.aprovada',
    entidade: 'requisicao',
    entidadeId: id,
    dadosAntes: { estado: 'pendente' },
    dadosDepois: { estado: 'aprovada', aprovadorId },
    ip: ctx.ip,
  });

  return depois;
}

export async function rejeitarRequisicao(
  db: Database,
  tenantId: string,
  id: string,
  aprovadorId: string,
  motivo: string,
  ctx: Contexto,
) {
  const requisicao = await obterRequisicao(db, tenantId, id);

  if (!['pendente', 'aprovada'].includes(requisicao.estado)) {
    throw new ErroRegraNegocio(
      `Uma requisicao "${requisicao.estado}" ja nao pode ser rejeitada.`,
    );
  }
  if (requisicao.solicitanteId === aprovadorId) {
    throw new ErroRegraNegocio('Nao pode rejeitar uma requisicao que fez voce mesmo');
  }
  if (!motivo?.trim()) {
    throw new ErroValidacao('Indique o motivo da rejeicao — quem pediu precisa de saber porque');
  }

  const [depois] = await db
    .update(requisicoes)
    .set({
      estado: 'rejeitada',
      aprovadorId,
      motivoRejeicao: motivo.trim(),
      updatedAt: new Date(),
    })
    .where(eq(requisicoes.id, id))
    .returning();

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'requisicao.rejeitada',
    entidade: 'requisicao',
    entidadeId: id,
    dadosAntes: { estado: requisicao.estado },
    dadosDepois: { estado: 'rejeitada', motivo },
    ip: ctx.ip,
  });

  return depois;
}

/**
 * Atende a requisicao: gera as saidas de stock.
 *
 * O atendimento e parcial por material (o armazem nem sempre tem tudo), por
 * isso a requisicao so passa a `atendida` quando `quantidade_atendida` alcanca
 * `quantidade` em todos os itens. enquanto isso fica `aprovada`, para o
 * armazem poder voltar a ela mais tarde.
 *
 * Tudo numa transacao: ou saem todas as saidas ou nenhuma. Um atendimento
 * parcial de stock sem registo seria saldo errado sem rasto.
 */
export async function atenderRequisicao(
  db: Database,
  tenantId: string,
  id: string,
  entrada: z.infer<typeof schemaAtender> | undefined,
  ctx: Contexto,
) {
  const requisicao = await obterRequisicao(db, tenantId, id);

  if (requisicao.estado !== 'aprovada') {
    throw new ErroRegraNegocio(
      `So se atendem requisicoes aprovadas. Esta esta "${requisicao.estado}".`,
    );
  }

  const itens = entrada?.itens ?? requisicao.itens.map((i) => ({
    materialId: i.materialId,
    quantidade: paraNum(i.quantidade) - paraNum(i.quantidadeAtendida),
  }));

  const aAtender = itens.filter((i) => i.quantidade > 0);
  if (!aAtender.length) {
    throw new ErroValidacao('Nao ha quantidades por atender nesta requisicao');
  }

  // Converte para movimentos e valida saldo antes de escrever qualquer coisa.
  const movimentos: Movimento[] = aAtender.map((i) => ({
    obraId: requisicao.obraId,
    materialId: i.materialId,
    tipo: 'saida' as const,
    quantidade: arred3(i.quantidade),
    precoUnitario: null,
    requisicaoId: id,
    observacoes: `Requisicao ${requisicao.codigo ?? id}`,
    data: hojeISO(),
    lancarCusto: false,
  }));

  return db.transaction(async (tx) => {
    const criados = [];
    for (const m of movimentos) {
      const r = await registarMovimento(tx, tenantId, m, ctx);
      criados.push(r.movimento);
    }

    for (const i of aAtender) {
      await tx
        .update(requisicaoItens)
        .set({
          quantidadeAtendida: sql`${requisicaoItens.quantidadeAtendida} + ${arred3(i.quantidade).toFixed(3)}`,
        })
        .where(
          and(
            eq(requisicaoItens.requisicaoId, id),
            eq(requisicaoItens.materialId, i.materialId),
          ),
        );
    }

    // Reavalia o estado: so passa a `atendida` se cobre tudo.
    const restantes = await tx
      .select({
        n: count(),
        pendentes: sql<number>`count(*) FILTER (WHERE quantidade_atendida + 0.0001 < quantidade)::int`,
      })
      .from(requisicaoItens)
      .where(eq(requisicaoItens.requisicaoId, id));

    const completa = Number(restantes[0]?.pendentes ?? 0) === 0;

    const [depois] = await tx
      .update(requisicoes)
      .set({
        estado: completa ? 'atendida' : 'aprovada',
        observacoes: entrada?.observacoes ?? requisicao.observacoes,
        updatedAt: new Date(),
      })
      .where(eq(requisicoes.id, id))
      .returning();

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'requisicao.atendida',
      entidade: 'requisicao',
      entidadeId: id,
      dadosAntes: { estado: 'aprovada' },
      dadosDepois: {
        estado: depois?.estado,
        movimentos: criados.length,
        quantidades: aAtender.map((i) => ({ materialId: i.materialId, quantidade: i.quantidade })),
      },
      ip: ctx.ip,
    });

    return { requisicao: depois, movimentos: criados, completa };
  });
}

/** Numeros de stock para o painel do armazem. */
export async function estatisticasRequisicoes(db: Database, tenantId: string) {
  const linhas = await db
    .select({ estado: requisicoes.estado, n: count() })
    .from(requisicoes)
    .where(and(eq(requisicoes.tenantId, tenantId), isNull(requisicoes.deletedAt)))
    .groupBy(requisicoes.estado);

  const base: Record<string, number> = {
    pendente: 0,
    aprovada: 0,
    rejeitada: 0,
    atendida: 0,
  };
  for (const l of linhas) base[l.estado] = Number(l.n);
  return base;
}