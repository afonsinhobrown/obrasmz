import { and, count, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import type { Ctx } from '../db/tx.js';
import {
  contratosSubempreitada,
  medicoes,
  obras,
  pagamentos,
  subempreiteiros,
} from '../db/schema.js';
import { hojeISO } from '../lib/datas.js';
import { ErroConflito, ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../lib/erros.js';
import { arred2, paraNum } from '../lib/money.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';
import { lancarCustoInterno } from './custos.js';
import { proximoNumero } from './numeracao.js';

export const schemaSubempreiteiro = z.object({
  nome: z.string().min(2).max(160),
  nuit: z.string().max(32).nullable().optional(),
  telefone: z.string().max(20).nullable().optional(),
  especialidade: z.string().max(120).nullable().optional(),
});

export const schemaContrato = z.object({
  obraId: z.string().uuid(),
  subempreiteiroId: z.string().uuid(),
  descricao: z.string().min(3, 'Descreva o trabalho contratado').max(500),
  valorContratado: z.coerce.number().positive('O valor contratado tem de ser maior que zero'),
  moeda: z.string().length(3).optional(),
  dataInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  prazoDias: z.coerce.number().int().positive().nullable().optional(),
});

export const schemaMedicao = z.object({
  descricao: z.string().max(500).nullable().optional(),
  valor: z.coerce.number().positive('O valor da medicao tem de ser maior que zero'),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const schemaActualizarContrato = z.object({
  descricao: z.string().min(3).max(500).optional(),
  valorContratado: z.coerce.number().positive().optional(),
  prazoDias: z.coerce.number().int().positive().nullable().optional(),
  dataInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  estado: z.enum(['activo', 'concluido', 'cancelado']).optional(),
});

/* -------------------------------------------------------------------------
   Subempreiteiros
   ------------------------------------------------------------------------- */

export async function listarSubempreiteiros(db: Database, tenantId: string, texto?: string) {
  const cond = [eq(subempreiteiros.tenantId, tenantId), isNull(subempreiteiros.deletedAt)];
  if (texto) cond.push(sql`${subempreiteiros.nome} ILIKE ${`%${texto.trim()}%`}`);

  return db
    .select({
      id: subempreiteiros.id,
      nome: subempreiteiros.nome,
      nuit: subempreiteiros.nuit,
      telefone: subempreiteiros.telefone,
      especialidade: subempreiteiros.especialidade,
      nContratos: sql<number>`(SELECT count(*)::int FROM contratos_subempreitada c
                               WHERE c.subempreiteiro_id = ${subempreiteiros.id}
                                 AND c.deleted_at IS NULL)`,
      valorContratado: sql<string>`coalesce((SELECT sum(c.valor_contratado) FROM contratos_subempreitada c
                                            WHERE c.subempreiteiro_id = ${subempreiteiros.id}
                                              AND c.deleted_at IS NULL), 0)`,
    })
    .from(subempreiteiros)
    .where(and(...cond))
    .orderBy(subempreiteiros.nome);
}

export async function obterSubempreiteiro(db: Database, tenantId: string, id: string) {
  const [s] = await db
    .select()
    .from(subempreiteiros)
    .where(
      and(
        eq(subempreiteiros.id, id),
        eq(subempreiteiros.tenantId, tenantId),
        isNull(subempreiteiros.deletedAt),
      ),
    )
    .limit(1);
  if (!s) throw new ErroNaoEncontrado('Subempreiteiro', id);
  return s;
}

export async function criarSubempreiteiro(
  db: Database,
  tenantId: string,
  entrada: z.infer<typeof schemaSubempreiteiro>,
  ctx: Contexto,
) {
  const [s] = await db
    .insert(subempreiteiros)
    .values({
      tenantId,
      nome: entrada.nome.trim(),
      nuit: entrada.nuit ?? null,
      telefone: entrada.telefone ?? null,
      especialidade: entrada.especialidade ?? null,
    })
    .returning();

  if (!s) throw new ErroValidacao('Falha ao criar o subempreiteiro');

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'subempreiteiro.criado',
    entidade: 'subempreiteiro',
    entidadeId: s.id,
    dadosDepois: { nome: s.nome, nuit: s.nuit },
    ip: ctx.ip,
  });

  return s;
}

export async function actualizarSubempreiteiro(
  db: Database,
  tenantId: string,
  id: string,
  campos: Partial<z.infer<typeof schemaSubempreiteiro>>,
  ctx: Contexto,
) {
  const antes = await obterSubempreiteiro(db, tenantId, id);

  const [depois] = await db
    .update(subempreiteiros)
    .set({
      ...(campos.nome !== undefined ? { nome: campos.nome.trim() } : {}),
      ...(campos.nuit !== undefined ? { nuit: campos.nuit } : {}),
      ...(campos.telefone !== undefined ? { telefone: campos.telefone } : {}),
      ...(campos.especialidade !== undefined ? { especialidade: campos.especialidade } : {}),
      updatedAt: new Date(),
    })
    .where(eq(subempreiteiros.id, id))
    .returning();

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'subempreiteiro.actualizado',
    entidade: 'subempreiteiro',
    entidadeId: id,
    dadosAntes: { nome: antes.nome, nuit: antes.nuit },
    dadosDepois: { nome: depois?.nome, nuit: depois?.nuit },
    ip: ctx.ip,
  });

  return depois;
}

/** Com contratos ou medicoes, so desliga — apagar perderia o historico. */
export async function apagarSubempreiteiro(
  db: Database,
  tenantId: string,
  id: string,
  ctx: Contexto,
) {
  const s = await obterSubempreiteiro(db, tenantId, id);

  const [n] = await db
    .select({ n: count() })
    .from(contratosSubempreitada)
    .where(and(eq(contratosSubempreitada.subempreiteiroId, id), isNull(contratosSubempreitada.deletedAt)));

  if (Number(n?.n ?? 0) > 0) {
    throw new ErroConflito(`O subempreiteiro tem ${n?.n} contrato(s) registados.`);
  }

  await db
    .update(subempreiteiros)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(subempreiteiros.id, id));

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'subempreiteiro.apagado',
    entidade: 'subempreiteiro',
    entidadeId: id,
    dadosAntes: { nome: s.nome },
    ip: ctx.ip,
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------
   Contratos
   ------------------------------------------------------------------------- */

export async function criarContrato(
  db: Database,
  tenantId: string,
  entrada: z.infer<typeof schemaContrato>,
  ctx: Contexto,
) {
  const [obra] = await db
    .select({ id: obras.id, moeda: obras.moeda })
    .from(obras)
    .where(and(eq(obras.id, entrada.obraId), eq(obras.tenantId, tenantId), isNull(obras.deletedAt)))
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', entrada.obraId);

  await obterSubempreiteiro(db, tenantId, entrada.subempreiteiroId);

  return db.transaction(async (tx) => {
    const codigo = await proximoNumero(tx, tenantId, 'CTR');

    const [contrato] = await tx
      .insert(contratosSubempreitada)
      .values({
        tenantId,
        obraId: entrada.obraId,
        subempreiteiroId: entrada.subempreiteiroId,
        descricao: entrada.descricao.trim(),
        valorContratado: arred2(entrada.valorContratado).toFixed(2),
        moeda: (entrada.moeda ?? obra.moeda).toUpperCase(),
        dataInicio: entrada.dataInicio ?? null,
        prazoDias: entrada.prazoDias ?? null,
        codigo,
      })
      .returning();

    if (!contrato) throw new ErroValidacao('Falha ao criar o contrato');

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'contrato.criado',
      entidade: 'contrato_subempreitada',
      entidadeId: contrato.id,
      dadosDepois: { codigo, obraId: entrada.obraId, valor: contrato.valorContratado },
      ip: ctx.ip,
    });

    return contrato;
  });
}

/** Posicao completa do contrato — contratado, executado e pago. */
export async function obterContrato(db: Database, tenantId: string, id: string) {
  const [contrato] = await db
    .select({
      ...getTableColumns(contratosSubempreitada),
      obraNome: obras.nome,
      obraCodigo: obras.codigo,
      subempreiteiro: subempreiteiros.nome,
    })
    .from(contratosSubempreitada)
    .innerJoin(obras, eq(obras.id, contratosSubempreitada.obraId))
    .innerJoin(subempreiteiros, eq(subempreiteiros.id, contratosSubempreitada.subempreiteiroId))
    .where(
      and(
        eq(contratosSubempreitada.id, id),
        eq(contratosSubempreitada.tenantId, tenantId),
        isNull(contratosSubempreitada.deletedAt),
      ),
    )
    .limit(1);
  if (!contrato) throw new ErroNaoEncontrado('Contrato', id);

  const posicao = await posicaoContrato(db, tenantId, id);
  const lista = await listarMedicoes(db, tenantId, id);
  const pagamentosDoContrato = await db
    .select({
      id: pagamentos.id,
      valor: pagamentos.valor,
      moeda: pagamentos.moeda,
      metodo: pagamentos.metodo,
      referencia: pagamentos.referencia,
      estado: pagamentos.estado,
      pagoEm: pagamentos.pagoEm,
      comprovativoUrl: pagamentos.comprovativoUrl,
    })
    .from(pagamentos)
    .where(
      and(
        eq(pagamentos.tenantId, tenantId),
        eq(pagamentos.contratoId, id),
        isNull(pagamentos.deletedAt),
      ),
    )
    .orderBy(desc(pagamentos.pagoEm));

  return { ...contrato, ...posicao, medicoes: lista, pagamentos: pagamentosDoContrato };
}

/**
 * Contas do contrato. `executado` vem das medicoes aprovadas, que sao a base
 * do que se pode pagar: paga-se medido, nao contratado.
 */
export async function posicaoContrato(db: Ctx, tenantId: string, contratoId: string) {
  const [contrato] = await db
    .select({ valor: contratosSubempreitada.valorContratado, estado: contratosSubempreitada.estado })
    .from(contratosSubempreitada)
    .where(eq(contratosSubempreitada.id, contratoId))
    .limit(1);
  if (!contrato) throw new ErroNaoEncontrado('Contrato', contratoId);

  const [m] = await db
    .select({ soma: sql<string>`coalesce(sum(valor), 0)`, n: count() })
    .from(medicoes)
    .where(and(eq(medicoes.contratoId, contratoId), isNull(medicoes.deletedAt)));

  const [p] = await db
    .select({ soma: sql<string>`coalesce(sum(valor * taxa_cambio), 0)`, n: count() })
    .from(pagamentos)
    .where(
      and(
        eq(pagamentos.contratoId, contratoId),
        isNull(pagamentos.deletedAt),
        sql`${pagamentos.estado} <> 'anulado'`,
      ),
    );

  const contratado = paraNum(contrato.valor);
  const executado = paraNum(m?.soma);
  const pago = paraNum(p?.soma);

  return {
    estado: contrato.estado,
    contratado,
    executado,
    pago,
    saldoContratado: arred2(contratado - executado),
    saldoAPagar: arred2(executado - pago),
    podePagar: arred2(executado - pago),
    nMedicoes: Number(m?.n ?? 0),
    nPagamentos: Number(p?.n ?? 0),
    execucaoPct: contratado > 0 ? arred2((executado / contratado) * 100) : 0,
    estourado: executado > contratado,
  };
}

export async function actualizarContrato(
  db: Database,
  tenantId: string,
  id: string,
  campos: z.infer<typeof schemaActualizarContrato>,
  ctx: Contexto,
) {
  const [antes] = await db
    .select()
    .from(contratosSubempreitada)
    .where(
      and(
        eq(contratosSubempreitada.id, id),
        eq(contratosSubempreitada.tenantId, tenantId),
        isNull(contratosSubempreitada.deletedAt),
      ),
    )
    .limit(1);
  if (!antes) throw new ErroNaoEncontrado('Contrato', id);

  // Reduzir o contratado abaixo do ja medido deixaria um saldo negativo sem
  // explicacao — provavelmente um erro de digitacao.
  if (campos.valorContratado !== undefined) {
    const posicao = await posicaoContrato(db, tenantId, id);
    if (campos.valorContratado < posicao.executado) {
      throw new ErroRegraNegocio(
        `Ja esta medido ${posicao.executado} neste contrato. O valor contratado nao pode ` +
          `ficar abaixo disso.`,
        { contratado: campos.valorContratado, medido: posicao.executado },
      );
    }
  }

  if (campos.estado === 'cancelado' || campos.estado === 'concluido') {
    const posicao = await posicaoContrato(db, tenantId, id);
    if (posicao.saldoAPagar > 0 && campos.estado === 'concluido') {
      throw new ErroRegraNegocio(
        `Ainda ha ${posicao.saldoAPagar} por pagar neste contrato. Registe os pagamentos antes de o concluir.`,
      );
    }
  }

  const [depois] = await db
    .update(contratosSubempreitada)
    .set({
      ...(campos.descricao !== undefined ? { descricao: campos.descricao.trim() } : {}),
      ...(campos.valorContratado !== undefined
        ? { valorContratado: arred2(campos.valorContratado).toFixed(2) }
        : {}),
      ...(campos.prazoDias !== undefined ? { prazoDias: campos.prazoDias } : {}),
      ...(campos.dataInicio !== undefined ? { dataInicio: campos.dataInicio } : {}),
      ...(campos.estado !== undefined ? { estado: campos.estado } : {}),
      updatedAt: new Date(),
    })
    .where(eq(contratosSubempreitada.id, id))
    .returning();

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'contrato.actualizado',
    entidade: 'contrato_subempreitada',
    entidadeId: id,
    dadosAntes: {
      valorContratado: antes.valorContratado,
      estado: antes.estado,
      prazoDias: antes.prazoDias,
    },
    dadosDepois: {
      valorContratado: depois?.valorContratado,
      estado: depois?.estado,
      prazoDias: depois?.prazoDias,
    },
    ip: ctx.ip,
  });

  return depois;
}

export async function listarContratos(
  db: Database,
  tenantId: string,
  filtro: { obraId?: string; subempreiteiroId?: string; estado?: 'activo' | 'concluido' | 'cancelado' } = {},
) {
  const cond = [
    eq(contratosSubempreitada.tenantId, tenantId),
    isNull(contratosSubempreitada.deletedAt),
  ];
  if (filtro.obraId) cond.push(eq(contratosSubempreitada.obraId, filtro.obraId));
  if (filtro.subempreiteiroId)
    cond.push(eq(contratosSubempreitada.subempreiteiroId, filtro.subempreiteiroId));
  if (filtro.estado) cond.push(eq(contratosSubempreitada.estado, filtro.estado));

  return db
    .select({
      id: contratosSubempreitada.id,
      codigo: contratosSubempreitada.codigo,
      descricao: contratosSubempreitada.descricao,
      valorContratado: contratosSubempreitada.valorContratado,
      moeda: contratosSubempreitada.moeda,
      estado: contratosSubempreitada.estado,
      dataInicio: contratosSubempreitada.dataInicio,
      prazoDias: contratosSubempreitada.prazoDias,
      obraId: contratosSubempreitada.obraId,
      obraNome: obras.nome,
      obraCodigo: obras.codigo,
      subempreiteiroId: contratosSubempreitada.subempreiteiroId,
      subempreiteiro: subempreiteiros.nome,
      executado: sql<string>`coalesce((SELECT sum(m.valor) FROM medicoes m
                                        WHERE m.contrato_id = ${contratosSubempreitada.id}
                                          AND m.deleted_at IS NULL), 0)`,
      pago: sql<string>`coalesce((SELECT sum(p.valor * p.taxa_cambio) FROM pagamentos p
                                   WHERE p.contrato_id = ${contratosSubempreitada.id}
                                     AND p.deleted_at IS NULL
                                     AND p.estado <> 'anulado'), 0)`,
    })
    .from(contratosSubempreitada)
    .innerJoin(obras, eq(obras.id, contratosSubempreitada.obraId))
    .innerJoin(subempreiteiros, eq(subempreiteiros.id, contratosSubempreitada.subempreiteiroId))
    .where(and(...cond))
    // Mais recentes primeiro; o `id` desempata para a paginacao ser estavel.
    .orderBy(desc(contratosSubempreitada.criadoEm), desc(contratosSubempreitada.id));
}

/* -------------------------------------------------------------------------
   Medicoes
   ------------------------------------------------------------------------- */

/**
 * Regista uma medicao e lanca o custo correspondente na obra.
 *
 * O custo fica com `origem_tabela='medicoes'` e `origem_id = medicao.id`, o que
 * torna a medicao e o custo um par inseparavel: anular a medicao remove o custo.
 */
export async function registarMedicao(
  db: Database,
  tenantId: string,
  contratoId: string,
  entrada: z.infer<typeof schemaMedicao>,
  ctx: Contexto,
) {
  const [contrato] = await db
    .select({
      id: contratosSubempreitada.id,
      tenantId: contratosSubempreitada.tenantId,
      obraId: contratosSubempreitada.obraId,
      valorContratado: contratosSubempreitada.valorContratado,
      moeda: contratosSubempreitada.moeda,
      estado: contratosSubempreitada.estado,
      codigo: contratosSubempreitada.codigo,
    })
    .from(contratosSubempreitada)
    .where(
      and(
        eq(contratosSubempreitada.id, contratoId),
        eq(contratosSubempreitada.tenantId, tenantId),
        isNull(contratosSubempreitada.deletedAt),
      ),
    )
    .limit(1);
  if (!contrato) throw new ErroNaoEncontrado('Contrato', contratoId);
  if (contrato.estado !== 'activo') {
    throw new ErroRegraNegocio(
      `Nao se medem contratos em estado "${contrato.estado}".`,
    );
  }

  return db.transaction(async (tx) => {
    const [ultima] = await tx
      .select({ numero: medicoes.numero })
      .from(medicoes)
      .where(eq(medicoes.contratoId, contratoId))
      .orderBy(desc(medicoes.numero))
      .limit(1);

    const numero = (ultima?.numero ?? 0) + 1;

    const [medicao] = await tx
      .insert(medicoes)
      .values({
        tenantId,
        contratoId,
        numero,
        descricao: entrada.descricao ?? null,
        valor: arred2(entrada.valor).toFixed(2),
        data: entrada.data ?? hojeISO(),
        aprovadaEm: new Date(),
      })
      .returning();

    if (!medicao) throw new ErroValidacao('Falha ao registar a medicao');

    // A soma das medicoes nao pode passar do contratado.
    const [soma] = await tx
      .select({ soma: sql<string>`coalesce(sum(valor), 0)` })
      .from(medicoes)
      .where(and(eq(medicoes.contratoId, contratoId), isNull(medicoes.deletedAt)));

    const total = paraNum(soma?.soma);
    const contratado = paraNum(contrato.valorContratado);

    if (total > contratado) {
      throw new ErroRegraNegocio(
        `A soma das medicoes (${total}) excede o valor contratado (${contratado}). ` +
          'Aumente o valor do contrato ou anule uma medicao.',
        { contratado, medido: total },
      );
    }

    const { custo } = await lancarCustoInterno(tx, tenantId, {
      obraId: contrato.obraId,
      tipo: 'subempreitada',
      descricao:
        `Medicao ${numero} — contrato ${contrato.codigo ?? contratoId} — ` +
        `${entrada.descricao ?? 'execucao de obra'}`,
      valor: arred2(entrada.valor),
      moeda: contrato.moeda,
      data: entrada.data ?? hojeISO(),
      origemTabela: 'medicoes',
      origemId: medicao.id,
    });

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'medicao.registada',
      entidade: 'medicao',
      entidadeId: medicao.id,
      dadosAntes: { mediaDoContrato: total - arred2(entrada.valor) },
      dadosDepois: { numero, valor: medicao.valor, custoId: custo?.id ?? null },
      ip: ctx.ip,
    });

    return { medicao, custo };
  });
}

export async function listarMedicoes(db: Database, tenantId: string, contratoId: string) {
  return db
    .select()
    .from(medicoes)
    .where(and(eq(medicoes.contratoId, contratoId), isNull(medicoes.deletedAt)))
    .orderBy(medicoes.numero);
}

/** Anular medicao remove tambem o custo que ela gerou. */
export async function anularMedicao(
  db: Database,
  tenantId: string,
  medicaoId: string,
  motivo: string,
  ctx: Contexto,
) {
  const [medicao] = await db
    .select()
    .from(medicoes)
    .where(and(eq(medicoes.id, medicaoId), eq(medicoes.tenantId, tenantId)))
    .limit(1);
  if (!medicao) throw new ErroNaoEncontrado('Medicao', medicaoId);
  if (!motivo?.trim()) throw new ErroValidacao('Indique o motivo da anulacao');

  const [pago] = await db
    .select({ soma: sql<string>`coalesce(sum(valor * taxa_cambio), 0)` })
    .from(pagamentos)
    .where(
      and(
        eq(pagamentos.contratoId, medicao.contratoId),
        isNull(pagamentos.deletedAt),
        sql`${pagamentos.estado} <> 'anulado'`,
      ),
    );

  const [soma] = await db
    .select({ soma: sql<string>`coalesce(sum(valor), 0)` })
    .from(medicoes)
    .where(
      and(
        eq(medicoes.contratoId, medicao.contratoId),
        isNull(medicoes.deletedAt),
        sql`${medicoes.id} <> ${medicaoId}`,
      ),
    );

  if (paraNum(soma?.soma) < paraNum(pago?.soma)) {
    throw new ErroRegraNegocio(
      'Ja foi pago a este contrato mais do que o que resta medido apos anular esta medicao. ' +
        'Anule primeiro o pagamento em excesso.',
      { pago: paraNum(pago?.soma), restante: paraNum(soma?.soma) },
    );
  }

  return db.transaction(async (tx) => {
    await tx
      .update(medicoes)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(medicoes.id, medicaoId));

    const removidos = await tx.execute<{ id: string }>(sql`
      UPDATE custos
         SET deleted_at = now(), updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND origem_tabela = 'medicoes'
         AND origem_id = ${medicaoId}
         AND deleted_at IS NULL
      RETURNING id`);

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'medicao.anulada',
      entidade: 'medicao',
      entidadeId: medicaoId,
      dadosAntes: { numero: medicao.numero, valor: medicao.valor },
      dadosDepois: { motivo, custosRemovidos: removidos.rows.length },
      ip: ctx.ip,
    });

    return { ok: true, custosRemovidos: removidos.rows.length };
  });
}

/** Subempreitada por especialidade — para saber quem chamar. */
export async function especialidades(db: Database, tenantId: string) {
  return db
    .selectDistinct({ especialidade: subempreiteiros.especialidade })
    .from(subempreiteiros)
    .where(
      and(
        eq(subempreiteiros.tenantId, tenantId),
        isNull(subempreiteiros.deletedAt),
        isNull(subempreiteiros.especialidade),
      ),
    );
}