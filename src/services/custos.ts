import { and, count, desc, eq, getTableColumns, gte, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import type { Ctx } from '../db/tx.js';
import { custos, obras, orcamentoItens, taxasCambio, tenants } from '../db/schema.js';
import { paraMoedaBase } from '../lib/cambio.js';
import { hojeISO } from '../lib/datas.js';
import { ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../lib/erros.js';
import { arred2, paraNum } from '../lib/money.js';
import { metaPagina, offsetDe, type Pagina } from '../lib/validadores.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';

export const schemaLancarCusto = z.object({
  obraId: z.string().uuid(),
  orcamentoItemId: z.string().uuid().nullable().optional(),
  tipo: z.enum(['material', 'mao_de_obra', 'subempreitada', 'equipamento', 'outro']),
  descricao: z.string().min(1, 'A descricao e obrigatoria').max(500),
  valor: z.coerce.number().positive('O valor tem de ser maior que zero'),
  moeda: z.string().length(3).optional(),
  taxaCambio: z.coerce.number().positive().optional(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  origemTabela: z.string().max(40).optional(),
  origemId: z.string().uuid().optional(),
});

export const schemaListarCustos = z.object({
  obraId: z.string().uuid().optional(),
  tipo: z.enum(['material', 'mao_de_obra', 'subempreitada', 'equipamento', 'outro']).optional(),
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  incluirApagados: z.coerce.boolean().default(false),
});

/**
 * Lanca um custo na obra.
 *
 * A taxa de cambio e resolvida sozinha a partir de `taxas_cambio` quando o
 * cliente nao a envia. O `valor` original e a `moeda` ficam guardados tal e
 * qual, para que daqui a um ano se perceba quanto se pagou de facto em USD,
 * mesmo que a cotacao mude. E o `valor * taxa` que alimenta o "orcado vs real".
 */
export async function lancarCusto(
  db: Database,
  tenantId: string,
  entrada: z.infer<typeof schemaLancarCusto>,
  ctx: Contexto,
) {
  const [obra] = await db
    .select()
    .from(obras)
    .where(and(eq(obras.id, entrada.obraId), eq(obras.tenantId, tenantId)))
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', entrada.obraId);

  if (entrada.orcamentoItemId) {
    const [item] = await db
      .select({ id: orcamentoItens.id })
      .from(orcamentoItens)
      .where(
        and(
          eq(orcamentoItens.id, entrada.orcamentoItemId),
          eq(orcamentoItens.obraId, entrada.obraId),
          isNull(orcamentoItens.deletedAt),
        ),
      )
      .limit(1);
    if (!item) {
      throw new ErroValidacao('O item de orcamento indicado nao pertence a esta obra');
    }
  }

  const [plano] = await db
    .select({ moedaBase: tenants.moedaBase })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const moeda = (entrada.moeda ?? obra.moeda).toUpperCase();
  const data = entrada.data ?? hojeISO();
  const dataComoDate = new Date(`${data}T12:00:00Z`);

  const cambio = entrada.taxaCambio
    ? { taxa: entrada.taxaCambio, origem: 'fornecida' as const, dataUsada: null }
    : await paraMoedaBase(db, tenantId, entrada.valor, moeda, dataComoDate, plano?.moedaBase);

  // Idempotencia por origem: um custo que ja nasceu de um movimento de stock,
  // de uma folha ou de uma medicao nao pode ser lancado outra vez a mao.
  if (entrada.origemTabela && entrada.origemId) {
    const [jaExiste] = await db
      .select({ id: custos.id })
      .from(custos)
      .where(
        and(
          eq(custos.tenantId, tenantId),
          eq(custos.origemTabela, entrada.origemTabela),
          eq(custos.origemId, entrada.origemId),
        ),
      )
      .limit(1);
    if (jaExiste) {
      const [existente] = await db
        .select()
        .from(custos)
        .where(eq(custos.id, jaExiste.id))
        .limit(1);
      return { custo: existente, jaLancado: true as const };
    }
  }

  return db.transaction(async (tx) => {
    const [custo] = await tx
      .insert(custos)
      .values({
        tenantId,
        obraId: entrada.obraId,
        orcamentoItemId: entrada.orcamentoItemId ?? null,
        tipo: entrada.tipo,
        descricao: entrada.descricao.trim(),
        valor: arred2(entrada.valor).toFixed(2),
        moeda,
        taxaCambio: String(cambio.taxa),
        data,
        origemTabela: entrada.origemTabela ?? null,
        origemId: entrada.origemId ?? null,
      })
      .returning();

    if (!custo) throw new ErroValidacao('Falha ao lancar o custo');

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'custo.lancado',
      entidade: 'custo',
      entidadeId: custo.id,
      dadosDepois: {
        obraId: entrada.obraId,
        tipo: entrada.tipo,
        valor: custo.valor,
        moeda,
        taxa: custo.taxaCambio,
        origem: entrada.origemTabela ?? null,
      },
      ip: ctx.ip,
    });

    return { custo, jaLancado: false as const };
  });
}

/**
 * Actualiza um custo. So se mexem campos descritivos e o valor **na mesma
 * moeda e na mesma data** que o lancamento original: mudar moeda ou data
 * invalidaria a taxa aplicada e o historico deixaria de cuadrar.
 */
export async function actualizarCusto(
  db: Database,
  tenantId: string,
  id: string,
  campos: Partial<z.infer<typeof schemaLancarCusto>>,
  ctx: Contexto,
) {
  const antes = await obterCusto(db, tenantId, id);

  if (campos.moeda && campos.moeda.toUpperCase() !== antes.moeda) {
    throw new ErroRegraNegocio(
      'Nao e possivel mudar a moeda de um custo. Anule-o e lance um novo.',
    );
  }
  if (campos.data && campos.data !== antes.data) {
    throw new ErroRegraNegocio(
      'Nao e possivel mudar a data de um custo. Anule-o e lance um novo, para o historico ficar exacto.',
    );
  }

  let taxa = antes.taxaCambio;
  if (campos.taxaCambio) taxa = String(campos.taxaCambio);

  const [depois] = await db
    .update(custos)
    .set({
      ...(campos.descricao !== undefined ? { descricao: campos.descricao.trim() } : {}),
      ...(campos.valor !== undefined ? { valor: arred2(campos.valor).toFixed(2) } : {}),
      ...(campos.tipo !== undefined ? { tipo: campos.tipo } : {}),
      ...(campos.orcamentoItemId !== undefined
        ? { orcamentoItemId: campos.orcamentoItemId }
        : {}),
      taxaCambio: taxa,
      updatedAt: new Date(),
    })
    .where(and(eq(custos.id, id), eq(custos.tenantId, tenantId)))
    .returning();

  if (!depois) throw new ErroNaoEncontrado('Custo', id);

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'custo.actualizado',
    entidade: 'custo',
    entidadeId: id,
    dadosAntes: { valor: antes.valor, tipo: antes.tipo, descricao: antes.descricao },
    dadosDepois: { valor: depois.valor, tipo: depois.tipo, descricao: depois.descricao },
    ip: ctx.ip,
  });

  return depois;
}

export async function obterCusto(db: Database, tenantId: string, id: string) {
  const [c] = await db
    .select()
    .from(custos)
    .where(and(eq(custos.id, id), eq(custos.tenantId, tenantId)))
    .limit(1);
  if (!c) throw new ErroNaoEncontrado('Custo', id);
  return c;
}

/**
 * Apagar um custo e sempre um soft delete. Quem lanca custos sao servicos
 * internos (fiscal, armazem, payroll) e o registo do que aconteceu faz parte
 * da auditoria da obra.
 */
export async function apagarCusto(
  db: Database,
  tenantId: string,
  id: string,
  ctx: Contexto,
  motivo: string,
) {
  const antes = await obterCusto(db, tenantId, id);

  // Custo gerado por stock/folha/medicao tem de ser revertido na origem, nao
  // aqui: apagar aqui deixaria a folha lancada sem custo correspondente.
  if (antes.origemTabela) {
    throw new ErroRegraNegocio(
      `Este custo foi gerado por "${antes.origemTabela}" e so pode ser anulado na origem, ` +
        'para o stock e as folhas continuarem coerentes.',
    );
  }

  await db
    .update(custos)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(custos.id, id), eq(custos.tenantId, tenantId)));

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'custo.apagado',
    entidade: 'custo',
    entidadeId: id,
    dadosAntes: { valor: antes.valor, descricao: antes.descricao, tipo: antes.tipo },
    dadosDepois: { motivo },
    ip: ctx.ip,
  });

  return { ok: true };
}

export async function listarCustos(
  db: Database,
  tenantId: string,
  filtros: z.infer<typeof schemaListarCustos>,
  pagina: Pagina,
) {
  const condicoes = [eq(custos.tenantId, tenantId)];
  if (!filtros.incluirApagados) condicoes.push(isNull(custos.deletedAt));
  if (filtros.obraId) condicoes.push(eq(custos.obraId, filtros.obraId));
  if (filtros.tipo) condicoes.push(eq(custos.tipo, filtros.tipo));
  if (filtros.de) condicoes.push(gte(custos.data, filtros.de));
  if (filtros.ate) condicoes.push(lte(custos.data, filtros.ate));

  const [totais] = await db
    .select({
      n: count(),
      soma: sql<string>`coalesce(sum(${custos.valor} * ${custos.taxaCambio}), 0)`,
    })
    .from(custos)
    .where(and(...condicoes));

  const dados = await db
    .select({
      ...getTableColumns(custos),
      valorBase: sql<string>`${custos.valor} * ${custos.taxaCambio}`,
      obraNome: obras.nome,
      obraCodigo: obras.codigo,
    })
    .from(custos)
    .innerJoin(obras, eq(obras.id, custos.obraId))
    .where(and(...condicoes))
    .orderBy(desc(custos.data), desc(custos.id))
    .limit(pagina.porPagina)
    .offset(offsetDe(pagina));

  return {
    dados: dados.map((d) => ({ ...d, valorBase: arred2(paraNum(d.valorBase)).toFixed(2) })),
    meta: { ...metaPagina(pagina, Number(totais?.n ?? 0)), somaTotal: arred2(paraNum(totais?.soma)).toFixed(2) },
  };
}

/** Custo agregado por tipo — a leitura principal do "orcado vs real". */
export async function custosPorTipo(db: Database, tenantId: string, obraId: string) {
  const linhas = await db
    .select({
      tipo: custos.tipo,
      soma: sql<string>`coalesce(sum(${custos.valor} * ${custos.taxaCambio}), 0)`,
      n: count(),
    })
    .from(custos)
    .where(
      and(eq(custos.tenantId, tenantId), eq(custos.obraId, obraId), isNull(custos.deletedAt)),
    )
    .groupBy(custos.tipo);

  return linhas
    .map((l) => ({ tipo: l.tipo, total: arred2(paraNum(l.soma)), lancamentos: Number(l.n) }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Custo por mes, para a curva S e o fluxo de custo. Devolve todos os meses do
 * intervalo, mesmo os que nao tiveram custo (para o grafico nao ter saltos).
 */
export async function custosPorMes(
  db: Database,
  tenantId: string,
  filtro: { obraId?: string; de?: string; ate?: string } = {},
) {
  const condicoes = [eq(custos.tenantId, tenantId), isNull(custos.deletedAt)];
  if (filtro.obraId) condicoes.push(eq(custos.obraId, filtro.obraId));
  if (filtro.de) condicoes.push(gte(custos.data, filtro.de));
  if (filtro.ate) condicoes.push(lte(custos.data, filtro.ate));

  const linhas = await db
    .select({
      mes: sql<string>`to_char(${custos.data}, 'YYYY-MM')`,
      tipo: custos.tipo,
      soma: sql<string>`coalesce(sum(${custos.valor} * ${custos.taxaCambio}), 0)`,
    })
    .from(custos)
    .where(and(...condicoes))
    .groupBy(sql`to_char(${custos.data}, 'YYYY-MM')`, custos.tipo)
    .orderBy(sql`to_char(${custos.data}, 'YYYY-MM')`);

  return linhas.map((l) => ({ mes: l.mes, tipo: l.tipo, total: arred2(paraNum(l.soma)) }));
}

/* -------------------------------------------------------------------------
   Taxas de cambio
   ------------------------------------------------------------------------- */

export const schemaTaxa = z.object({
  moeda: z.string().length(3),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  taxa: z.coerce.number().positive('A taxa tem de ser maior que zero'),
  fonte: z.string().max(80).optional(),
});

export async function registarTaxa(
  db: Database,
  tenantId: string,
  entrada: z.infer<typeof schemaTaxa>,
  ctx: Contexto,
) {
  const moeda = entrada.moeda.toUpperCase();

  const [plano] = await db
    .select({ moedaBase: tenants.moedaBase })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (moeda === plano?.moedaBase?.toUpperCase()) {
    throw new ErroRegraNegocio('A moeda base da empresa nao precisa de cotacao');
  }

  const [existente] = await db
    .select({ id: taxasCambio.id })
    .from(taxasCambio)
    .where(
      and(
        eq(taxasCambio.tenantId, tenantId),
        eq(taxasCambio.moeda, moeda),
        eq(taxasCambio.data, entrada.data),
      ),
    )
    .limit(1);

  if (existente) {
    const [actualizado] = await db
      .update(taxasCambio)
      .set({ taxa: String(entrada.taxa), fonte: entrada.fonte ?? null })
      .where(eq(taxasCambio.id, existente.id))
      .returning();
    return { taxa: actualizado, actualizada: true };
  }

  const [nova] = await db
    .insert(taxasCambio)
    .values({
      tenantId,
      moeda,
      data: entrada.data,
      taxa: String(entrada.taxa),
      fonte: entrada.fonte ?? null,
    })
    .returning();

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'cambio.registado',
    entidade: 'taxa_cambio',
    entidadeId: nova?.id ?? null,
    dadosDepois: { moeda, data: entrada.data, taxa: entrada.taxa, fonte: entrada.fonte ?? null },
    ip: ctx.ip,
  });

  return { taxa: nova, actualizada: false };
}

export async function listarTaxas(db: Database, tenantId: string, data: string) {
  // Ultima cotacao de cada moeda ate `data`.
  const linhas = await db
    .select({
      moeda: taxasCambio.moeda,
      taxa: taxasCambio.taxa,
      data: taxasCambio.data,
      fonte: taxasCambio.fonte,
    })
    .from(taxasCambio)
    .where(and(eq(taxasCambio.tenantId, tenantId), lte(taxasCambio.data, data)))
    .orderBy(desc(taxasCambio.moeda), desc(taxasCambio.data));

  const vistos = new Set<string>();
  return linhas.filter((l) => {
    if (vistos.has(l.moeda)) return false;
    vistos.add(l.moeda);
    return true;
  });
}

/** Converte um valor para a moeda base — usado pelo ecra antes de gravar. */
export async function previsualizar(
  db: Database,
  tenantId: string,
  valor: number,
  moeda: string,
  data: string,
) {
  const [plano] = await db
    .select({ moedaBase: tenants.moedaBase })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const r = await paraMoedaBase(
    db,
    tenantId,
    valor,
    moeda,
    new Date(`${data}T12:00:00Z`),
    plano?.moedaBase,
  );

  return {
    valor,
    moeda: moeda.toUpperCase(),
    moedaBase: plano?.moedaBase ?? 'MZN',
    taxa: r.taxa,
    valorBase: arred2(r.valorBase).toFixed(2),
    origem: r.cambio.origem,
    cotacaoUsada: r.cambio.dataUsada,
  };
}

/**
 * Lanca o custo que nasce de um documento interno (movimento de stock, folha de
 * salario, medicao), sem passar pela camada HTTP.
 *
 * Idempotente por `(origem_tabela, origem_id)`: se o custo ja existe, devolve-o
 * tal como esta. E o que permite reexecutar a geracao de folhas sem duplicar
 * dinheiro na obra.
 */
export async function lancarCustoInterno(
  db: Ctx,
  tenantId: string,
  entrada: Omit<z.infer<typeof schemaLancarCusto>, 'taxaCambio' | 'moeda'> & {
    moeda?: string;
    taxaCambio?: number;
  },
) {
  const [obra] = await db
    .select({ moeda: obras.moeda })
    .from(obras)
    .where(eq(obras.id, entrada.obraId))
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', entrada.obraId);

  if (entrada.origemTabela && entrada.origemId) {
    const [jaExiste] = await db
      .select()
      .from(custos)
      .where(
        and(
          eq(custos.tenantId, tenantId),
          eq(custos.origemTabela, entrada.origemTabela),
          eq(custos.origemId, entrada.origemId),
        ),
      )
      .limit(1);
    if (jaExiste) return { custo: jaExiste, criado: false as const };
  }

  const moeda = (entrada.moeda ?? obra.moeda).toUpperCase();
  const data = entrada.data ?? hojeISO();

  let taxa = 1;
  if (entrada.taxaCambio) {
    taxa = entrada.taxaCambio;
  } else if (moeda !== (await moedaBaseDe(db, tenantId)).toUpperCase()) {
    const r = await paraMoedaBase(db, tenantId, 1, moeda, new Date(`${data}T12:00:00Z`));
    taxa = r.taxa;
  }

  const [custo] = await db
    .insert(custos)
    .values({
      tenantId,
      obraId: entrada.obraId,
      orcamentoItemId: entrada.orcamentoItemId ?? null,
      tipo: entrada.tipo,
      descricao: entrada.descricao,
      valor: arred2(entrada.valor).toFixed(2),
      moeda,
      taxaCambio: String(taxa),
      data,
      origemTabela: entrada.origemTabela ?? null,
      origemId: entrada.origemId ?? null,
    })
    .returning();

  return { custo, criado: true as const };
}

async function moedaBaseDe(db: Ctx, tenantId: string): Promise<string> {
  const [t] = await db
    .select({ moedaBase: tenants.moedaBase })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return t?.moedaBase ?? 'MZN';
}