import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { taxasCambio } from '../db/schema.js';
import type { Ctx } from '../db/tx.js';
import { config } from '../config.js';
import { paraNum } from './money.js';

export type ResultadoCambio = {
  moeda: string;
  taxa: number;
  origem: 'base' | 'tabela' | 'envolvida';
  dataUsada: string | null;
};

/**
 * Resolve a taxa de cambio de `moeda` para a moeda base do tenant na data
 * pedida. Regra: usa a cotacao mais recente **igual ou anterior** a data; se
 * nao houver nenhuma anterior, usa a mais recente que existir.
 *
 * Convencao: `taxa` = quantas unidades da moeda base por 1 unidade da moeda
 * cotada. Ex.: 1 USD = 63,50 MZN -> 100 USD x 63,5 = 6 350,00 MZN.
 */
export async function resolverTaxa(
  db: Ctx,
  tenantId: string,
  moeda: string,
  data: Date,
  moedaBase = config.dominio.moedaBase,
): Promise<ResultadoCambio> {
  const m = moeda.toUpperCase();

  if (m === moedaBase.toUpperCase()) {
    return { moeda: m, taxa: 1, origem: 'base', dataUsada: null };
  }

  const dia = data.toISOString().slice(0, 10);

  const [anterior] = await db
    .select({ taxa: taxasCambio.taxa, data: taxasCambio.data })
    .from(taxasCambio)
    .where(
      and(
        eq(taxasCambio.tenantId, tenantId),
        eq(taxasCambio.moeda, m),
        lte(taxasCambio.data, dia),
      ),
    )
    .orderBy(desc(taxasCambio.data))
    .limit(1);

  if (anterior) {
    return { moeda: m, taxa: paraNum(anterior.taxa), origem: 'tabela', dataUsada: anterior.data };
  }

  const [qualquer] = await db
    .select({ taxa: taxasCambio.taxa, data: taxasCambio.data })
    .from(taxasCambio)
    .where(and(eq(taxasCambio.tenantId, tenantId), eq(taxasCambio.moeda, m)))
    .orderBy(desc(taxasCambio.data))
    .limit(1);

  if (qualquer) {
    return {
      moeda: m,
      taxa: paraNum(qualquer.taxa),
      origem: 'envolvida',
      dataUsada: qualquer.data,
    };
  }

  // Sem cotacao registada: assume-se paridade e avisa-se explicitamente
  // quando o valor e mesmo zero, para nao haver custo silenciosamente errado.
  return { moeda: m, taxa: 1, origem: 'envolvida', dataUsada: null };
}

/**
 * Converte para a moeda base. `valorNaMoeda` e um NUMERIC ja em string.
 * Devolve o valor convertido e a taxa aplicada, para o caller persistir os dois
 * (o custo guarda o valor original e a taxa, para historico auditavel).
 */
export async function paraMoedaBase(
  db: Ctx,
  tenantId: string,
  valorNaMoeda: string | number,
  moeda: string,
  data: Date,
  moedaBase = config.dominio.moedaBase,
): Promise<{ taxa: number; valorBase: number; cambio: ResultadoCambio }> {
  const r = await resolverTaxa(db, tenantId, moeda, data, moedaBase);
  return {
    taxa: r.taxa,
    valorBase: paraNum(valorNaMoeda) * r.taxa,
    cambio: r,
  };
}

/** Taxas conhecidas pelo tenant — usado pelo ecra de lancamento de custos. */
export async function listarMoedas(db: Ctx, tenantId: string, moedaBase: string) {
  const linhas = await db
    .selectDistinct({ moeda: taxasCambio.moeda })
    .from(taxasCambio)
    .where(eq(taxasCambio.tenantId, tenantId));

  return [{ moeda: moedaBase, taxa: 1 }, ...linhas.map((l) => ({ moeda: l.moeda, taxa: null }))];
}

/** Moedas com cotacao na data (para seletores do mobile). */
export async function cotacoesDoDia(db: Ctx, tenantId: string, data: Date) {
  const dia = data.toISOString().slice(0, 10);
  return db
    .select({
      moeda: taxasCambio.moeda,
      taxa: taxasCambio.taxa,
      data: taxasCambio.data,
      fonte: taxasCambio.fonte,
    })
    .from(taxasCambio)
    .where(
      and(
        eq(taxasCambio.tenantId, tenantId),
        sql`${taxasCambio.data} <= ${dia}`,
      ),
    )
    .orderBy(taxasCambio.moeda);
}