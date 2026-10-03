import { and, count, desc, eq, getTableColumns, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Database } from '../db/client.js';
import type { Ctx } from '../db/tx.js';
import { unico } from '../db/tx.js';
import { obraMembros, obras, orcamentoItens, tenants } from '../db/schema.js';
import {
  ErroConflito,
  ErroLimitePlano,
  ErroNaoEncontrado,
  ErroRegraNegocio,
  ErroValidacao,
} from '../lib/erros.js';
import { arred2, clamp, divisaoSegura, paraNum } from '../lib/money.js';
import { metaPagina, offsetDe, type Pagina } from '../lib/validadores.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';
import { proximoNumero, preverNumero } from './numeracao.js';

export type EstadoObra = 'planeada' | 'em_curso' | 'suspensa' | 'concluida';

/**
 * Transicoes validas. Uma obra nao salta de `planeada` para `concluida`.
 * `concluida` nao e terminal: permite-se reabrir porque na obra real uma obra
 * "concluida" que reabre por ordem do cliente e comum, e nao queremos obrigar
 * a duplicar todo o historico.
 */
const TRANSICOES: Record<EstadoObra, readonly EstadoObra[]> = {
  planeada: ['em_curso', 'suspensa'],
  em_curso: ['suspensa', 'concluida'],
  suspensa: ['em_curso', 'planeada', 'concluida'],
  concluida: ['em_curso'],
};

export function transicaoValida(de: EstadoObra, para: EstadoObra): boolean {
  return de === para || TRANSICOES[de].includes(para);
}

const dataISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data invalida (YYYY-MM-DD)');

export const schemaCriarObra = z.object({
  codigo: z.string().min(2).max(40).optional(),
  nome: z.string().min(3, 'O nome da obra deve ter pelo menos 3 caracteres').max(160),
  cliente: z.string().max(200).nullable().optional(),
  localizacao: z.string().max(240).nullable().optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  moeda: z.string().length(3).default(config.dominio.moedaBase),
  orcamentoTotal: z.coerce.number().min(0).default(0),
  dataInicio: dataISO.nullable().optional(),
  dataFimPrevista: dataISO.nullable().optional(),
  estado: z.enum(['planeada', 'em_curso', 'suspensa', 'concluida']).default('planeada'),
  descricao: z.string().max(4000).nullable().optional(),
  membros: z.array(z.string().uuid()).max(100).default([]),
});

export const schemaActualizarObra = z.object({
  codigo: z.string().min(2).max(40).optional(),
  nome: z.string().min(3).max(160).optional(),
  cliente: z.string().max(200).nullable().optional(),
  localizacao: z.string().max(240).nullable().optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  moeda: z.string().length(3).optional(),
  orcamentoTotal: z.coerce.number().min(0).optional(),
  dataInicio: dataISO.nullable().optional(),
  dataFimPrevista: dataISO.nullable().optional(),
  estado: z.enum(['planeada', 'em_curso', 'suspensa', 'concluida']).optional(),
  progressoPct: z.coerce.number().min(0).max(100).optional(),
  descricao: z.string().max(4000).nullable().optional(),
});

export const schemaListarObras = z.object({
  estado: z.enum(['planeada', 'em_curso', 'suspensa', 'concluida']).optional(),
  texto: z.string().max(120).optional(),
  incluirApagadas: z.coerce.boolean().default(false),
});

export async function criarObra(
  db: Database,
  tenantId: string,
  entrada: z.infer<typeof schemaCriarObra>,
  ctx: Contexto,
) {
  validarDatas(entrada.dataInicio, entrada.dataFimPrevista);

  const codigo = (entrada.codigo?.trim() || (await proximoNumero(db, tenantId, 'OBR'))).toUpperCase();

  return db.transaction(async (tx) => {
    await exigirEspaco(tx, tenantId);

    const dup = await tx
      .select({ id: obras.id })
      .from(obras)
      .where(and(eq(obras.tenantId, tenantId), eq(obras.codigo, codigo)))
      .limit(1);
    if (dup.length) throw new ErroConflito(`Ja existe uma obra com o codigo ${codigo}`);

    const [obra] = await tx
      .insert(obras)
      .values({
        tenantId,
        codigo,
        nome: entrada.nome.trim(),
        cliente: entrada.cliente ?? null,
        localizacao: entrada.localizacao ?? null,
        latitude: entrada.latitude != null ? String(entrada.latitude) : null,
        longitude: entrada.longitude != null ? String(entrada.longitude) : null,
        moeda: entrada.moeda.toUpperCase(),
        orcamentoTotal: String(entrada.orcamentoTotal),
        dataInicio: entrada.dataInicio ?? null,
        dataFimPrevista: entrada.dataFimPrevista ?? null,
        estado: entrada.estado,
        // `ck_obras_concluida` exige 100%: criar ja como concluida so faz
        // sentido se o cliente assim o indicar.
        progressoPct: entrada.estado === 'concluida' ? '100' : '0',
        descricao: entrada.descricao ?? null,
      })
      .returning();

    if (!obra) throw new ErroValidacao('Falha ao criar a obra');

    if (entrada.membros.length) {
      await tx
        .insert(obraMembros)
        .values(entrada.membros.map((utilizadorId) => ({ obraId: obra.id, utilizadorId })));
    }

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'obra.criada',
      entidade: 'obra',
      entidadeId: obra.id,
      dadosDepois: { codigo, nome: obra.nome, orcamentoTotal: obra.orcamentoTotal },
      ip: ctx.ip,
    });

    return obra;
  });
}

/** Teto de obras do plano. Contado dentro da transacao do INSERT. */
async function exigirEspaco(db: Ctx, tenantId: string) {
  const [plano] = await db
    .select({ max: tenants.maxObras, plano: tenants.plano })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!plano) throw new ErroNaoEncontrado('Empresa', tenantId);

  const { total } = unico(
    await db
      .select({ total: count() })
      .from(obras)
      .where(and(eq(obras.tenantId, tenantId), isNull(obras.deletedAt))),
  );

  if (total >= plano.max) {
    throw new ErroLimitePlano('obras', plano.max, plano.plano);
  }
}

function validarDatas(inicio?: string | null, fim?: string | null) {
  if (inicio && fim && fim < inicio) {
    throw new ErroValidacao('A data de fim prevista e anterior a data de inicio');
  }
}

export async function listarObras(
  db: Database,
  tenantId: string,
  filtros: z.infer<typeof schemaListarObras>,
  pagina: Pagina,
) {
  const condicoes = [eq(obras.tenantId, tenantId)];
  if (!filtros.incluirApagadas) condicoes.push(isNull(obras.deletedAt));
  if (filtros.estado) condicoes.push(eq(obras.estado, filtros.estado));
  if (filtros.texto) {
    const alvo = `%${filtros.texto.trim()}%`;
    condicoes.push(
      or(ilike(obras.nome, alvo), ilike(obras.codigo, alvo), ilike(obras.cliente, alvo))!,
    );
  }

  const linhas = await db
    .select({
      total: count(),
    })
    .from(obras)
    .where(and(...condicoes));

  const dados = await db
    .select()
    .from(obras)
    .where(and(...condicoes))
    // Ordenacao estavel: sem um desempate unico, dois registos com o mesmo
    // `criado_em` podem trocar de pagina a cada pedido.
    .orderBy(desc(obras.criadoEm), desc(obras.id))
    .limit(pagina.porPagina)
    .offset(offsetDe(pagina));

  return { dados, meta: metaPagina(pagina, linhas[0]?.total ?? 0) };
}

export async function obterObra(db: Ctx, tenantId: string, id: string) {
  const [obra] = await db
    .select()
    .from(obras)
    .where(and(eq(obras.id, id), eq(obras.tenantId, tenantId)))
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', id);
  return obra;
}

export async function actualizarObra(
  db: Database,
  tenantId: string,
  id: string,
  campos: z.infer<typeof schemaActualizarObra>,
  ctx: Contexto,
) {
  const antes = await obterObra(db, tenantId, id);

  if (campos.estado && !transicaoValida(antes.estado as EstadoObra, campos.estado)) {
    throw new ErroRegraNegocio(
      `Nao e possivel mudar de "${antes.estado}" para "${campos.estado}". ` +
        `Transicoes validas a partir de "${antes.estado}": ${
          TRANSICOES[antes.estado as EstadoObra].join(', ')
        }`,
    );
  }

  const inicio = campos.dataInicio !== undefined ? campos.dataInicio : antes.dataInicio;
  const fim = campos.dataFimPrevista !== undefined ? campos.dataFimPrevista : antes.dataFimPrevista;
  validarDatas(inicio, fim);

  const codigo = campos.codigo?.trim().toUpperCase();
  if (codigo && codigo !== antes.codigo) {
    const dup = await db
      .select({ id: obras.id })
      .from(obras)
      .where(and(eq(obras.tenantId, tenantId), eq(obras.codigo, codigo)))
      .limit(1);
    if (dup.length) throw new ErroConflito(`Ja existe uma obra com o codigo ${codigo}`);
  }

  let progresso =
    campos.progressoPct !== undefined ? arred2(campos.progressoPct) : paraNum(antes.progressoPct);
  if (campos.estado === 'concluida') progresso = 100;

  return db.transaction(async (tx) => {
    const [depois] = await tx
      .update(obras)
      .set({
        ...(codigo ? { codigo } : {}),
        ...(campos.nome !== undefined ? { nome: campos.nome.trim() } : {}),
        ...(campos.cliente !== undefined ? { cliente: campos.cliente } : {}),
        ...(campos.localizacao !== undefined ? { localizacao: campos.localizacao } : {}),
        ...(campos.latitude !== undefined
          ? { latitude: campos.latitude != null ? String(campos.latitude) : null }
          : {}),
        ...(campos.longitude !== undefined
          ? { longitude: campos.longitude != null ? String(campos.longitude) : null }
          : {}),
        ...(campos.moeda !== undefined ? { moeda: campos.moeda.toUpperCase() } : {}),
        ...(campos.orcamentoTotal !== undefined
          ? { orcamentoTotal: String(campos.orcamentoTotal) }
          : {}),
        ...(campos.dataInicio !== undefined ? { dataInicio: campos.dataInicio } : {}),
        ...(campos.dataFimPrevista !== undefined ? { dataFimPrevista: campos.dataFimPrevista } : {}),
        ...(campos.estado !== undefined ? { estado: campos.estado } : {}),
        ...(campos.descricao !== undefined ? { descricao: campos.descricao } : {}),
        progressoPct: String(progresso),
        updatedAt: new Date(),
      })
      .where(and(eq(obras.id, id), eq(obras.tenantId, tenantId)))
      .returning();

    if (!depois) throw new ErroNaoEncontrado('Obra', id);

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'obra.actualizada',
      entidade: 'obra',
      entidadeId: id,
      dadosAntes: {
        nome: antes.nome,
        estado: antes.estado,
        orcamentoTotal: antes.orcamentoTotal,
        progressoPct: antes.progressoPct,
      },
      dadosDepois: {
        nome: depois.nome,
        estado: depois.estado,
        orcamentoTotal: depois.orcamentoTotal,
        progressoPct: depois.progressoPct,
      },
      ip: ctx.ip,
    });

    return depois;
  });
}

/**
 * Apagar e recusado quando ha historico financeiro ligado. Um soft delete
 * esconderia custos e pagamentos de quem audita a obra; o caminho correto e
 * arquivar (`estado = suspensa`).
 */
export async function apagarObra(
  db: Database,
  tenantId: string,
  id: string,
  ctx: Contexto,
) {
  const obra = await obterObra(db, tenantId, id);

  const [cus] = await db
    .select({ n: count() })
    .from(sql`custos`)
    .where(and(sql`obra_id = ${id}`, sql`deleted_at is null`));

  const [pag] = await db
    .select({ n: count() })
    .from(sql`pagamentos`)
    .where(and(sql`obra_id = ${id}`, sql`deleted_at is null`));

  if (Number(cus?.n ?? 0) > 0 || Number(pag?.n ?? 0) > 0) {
    throw new ErroRegraNegocio(
      `A obra tem ${cus?.n ?? 0} custo(s) e ${pag?.n ?? 0} pagamento(s) registados. ` +
        'Arquive-a (estado = suspensa) em vez de a apagar.',
    );
  }

  return db.transaction(async (tx) => {
    const [depois] = await tx
      .update(obras)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(obras.id, id), eq(obras.tenantId, tenantId)))
      .returning();

    await tx.delete(obraMembros).where(eq(obraMembros.obraId, id));

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'obra.apagada',
      entidade: 'obra',
      entidadeId: id,
      dadosAntes: { codigo: obra.codigo, nome: obra.nome },
      ip: ctx.ip,
    });

    return depois;
  });
}

/* -------------------------------------------------------------------------
   Membros
   ------------------------------------------------------------------------- */

export async function definirMembros(db: Database, tenantId: string, obraId: string, ids: string[]) {
  await obterObra(db, tenantId, obraId);

  return db.transaction(async (tx) => {
    await tx.delete(obraMembros).where(eq(obraMembros.obraId, obraId));
    if (ids.length) {
      await tx.insert(obraMembros).values(ids.map((utilizadorId) => ({ obraId, utilizadorId })));
    }
    return tx
      .select({
        utilizadorId: obraMembros.utilizadorId,
        criadoEm: obraMembros.criadoEm,
      })
      .from(obraMembros)
      .where(eq(obraMembros.obraId, obraId));
  });
}

export async function listarMembros(db: Database, obraId: string) {
  return db
    .select({ utilizadorId: obraMembros.utilizadorId, criadoEm: obraMembros.criadoEm })
    .from(obraMembros)
    .where(eq(obraMembros.obraId, obraId));
}

/* -------------------------------------------------------------------------
   Progresso
   ------------------------------------------------------------------------- */

/**
 * Progresso ponderado pelo peso de cada item no orcamento: um item que vale
 * 60% do orcamento move o progresso da obra muito mais do que um de 1%.
 *
 * Se nenhum item tem quantidade executada, mantemos o progresso registado
 * (tipicamente vindo do diario de obra) em vez de o zerar sem querer.
 */
export async function recalcularProgresso(db: Ctx, obraId: string): Promise<number> {
  const [obra] = await db
    .select({ estado: obras.estado, progressoPct: obras.progressoPct })
    .from(obras)
    .where(eq(obras.id, obraId))
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', obraId);

  const [r] = await db
    .select({
      orcado: sql<string>`coalesce(sum(quantidade * preco_unitario), 0)`,
      executado: sql<string>`coalesce(sum(qtd_executada * preco_unitario), 0)`,
    })
    .from(orcamentoItens)
    .where(and(eq(orcamentoItens.obraId, obraId), isNull(orcamentoItens.deletedAt)));

  const orcado = paraNum(r?.orcado);
  const executado = paraNum(r?.executado);

  const final =
    obra.estado === 'concluida'
      ? 100
      : orcado > 0
        ? arred2(clamp(divisaoSegura(executado, orcado) * 100, 0, 100))
        : paraNum(obra.progressoPct);

  if (final !== paraNum(obra.progressoPct)) {
    await db.update(obras).set({ progressoPct: String(final) }).where(eq(obras.id, obraId));
  }
  return final;
}

/** Soma orcada e soma executada dos itens — para validar contra o contratual. */
export async function totaisOrcamento(db: Database, obraId: string) {
  const [r] = await db
    .select({
      orcado: sql<string>`coalesce(sum(quantidade * preco_unitario), 0)`,
      executado: sql<string>`coalesce(sum(qtd_executada * preco_unitario), 0)`,
      nItens: count(),
    })
    .from(orcamentoItens)
    .where(and(eq(orcamentoItens.obraId, obraId), isNull(orcamentoItens.deletedAt)));

  return {
    itens: Number(r?.nItens ?? 0),
    orcado: paraNum(r?.orcado),
    executado: paraNum(r?.executado),
    saldo: arred2(paraNum(r?.orcado) - paraNum(r?.executado)),
  };
}

export function diasDePrazo(obra: { dataInicio: string | null; dataFimPrevista: string | null }) {
  if (!obra.dataInicio || !obra.dataFimPrevista) return null;
  const ms =
    new Date(`${obra.dataFimPrevista}T00:00:00Z`).getTime() -
    new Date(`${obra.dataInicio}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/** Resumo consolidado da obra — alimenta o ecra de detalhe e os relatorios. */
export async function resumoObra(db: Database, tenantId: string, id: string) {
  const obra = await obterObra(db, tenantId, id);
  const orc = await totaisOrcamento(db, id);

  const [cus] = await db
    .select({
      real: sql<string>`coalesce(sum(valor * taxa_cambio), 0)`,
      n: count(),
    })
    .from(sql`custos`)
    .where(and(sql`obra_id = ${id}`, sql`deleted_at is null`));

  const [pag] = await db
    .select({
      pago: sql<string>`coalesce(sum(valor * taxa_cambio), 0)`,
      n: count(),
    })
    .from(sql`pagamentos`)
    .where(and(sql`obra_id = ${id}`, sql`deleted_at is null`, sql`estado <> 'anulado'`));

  const [diag] = await db
    .select({ n: count() })
    .from(sql`diario_obra`)
    .where(and(sql`obra_id = ${id}`, sql`deleted_at is null`));

  const orcamento = paraNum(obra.orcamentoTotal);
  const real = paraNum(cus?.real);
  const pago = paraNum(pag?.pago);

  return {
    ...obra,
    diasPrazo: diasDePrazo(obra),
    orcamento: {
      ...orc,
      contratual: orcamento,
      // Soma dos itens acima do valor contratual significa orcamento revisto
      // sem ajuste do total da obra: sinalizamos em vez de bloquear.
      divergencia: arred2(orc.orcado - orcamento),
      dentroDoOrcamento: orcamento === 0 || orc.orcado <= orcamento,
    },
    custos: {
      real,
      lancamentos: Number(cus?.n ?? 0),
      saldo: arred2(orcamento - real),
      desvioPct: orcamento > 0 ? arred2((real / orcamento) * 100) : 0,
      estourado: orcamento > 0 && real > orcamento,
    },
    pagamentos: {
      pago,
      lancamentos: Number(pag?.n ?? 0),
      porLiquidar: arred2(real - pago),
    },
    diario: { entradas: Number(diag?.n ?? 0) },
  };
}

/** Preve o proximo codigo sem o consumir. */
export function proximoCodigo(db: Database, tenantId: string) {
  return preverNumero(db, tenantId, 'OBR');
}