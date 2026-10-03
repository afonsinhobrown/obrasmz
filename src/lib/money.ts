/**
 * Helpers para valores monetarios e quantidades.
 *
 * NUMERIC vem do PostgreSQL como string e sai daqui como string: nunca
 * convertemos dinheiro para `number` antes de persistir, senao perdemos
 * precisao silenciosamente. A aritmetica fica no SQL.
 */

/** Converte a string do NUMERIC em Number para calculos na aplicacao. */
export function paraNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Arredonda a 2 casas (dinheiro). */
export function arred2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Arredonda a 3 casas (quantidades). */
export function arred3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/** Converte para o formato de entrada do NUMERIC. */
export function decimal(v: number, casas = 2): string {
  return arred(casas)(v).toFixed(casas);
}

export function arred(casas: number): (n: number) => number {
  const f = 10 ** casas;
  return (n) => Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Converte um valor na moeda `de` para a moeda `para`.
 * `taxa` = unidades da moeda base por 1 unidade da moeda de origem.
 */
export function converter(valor: number, de: string, para: string, taxa: number): number {
  if (de.toUpperCase() === para.toUpperCase()) return arred2(valor);
  return arred2(valor * taxa);
}

/** Formata para apresentacao: 1 250 000,00 MZN (sem moeda -> so o numero). */
export function formatarMoeda(valor: number, moeda = 'MZN', locale = 'pt-MZ'): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(valor);
}

/**
 * Divisao segura: devolve `fallback` em vez de Infinity/NaN quando o
 * denominador e zero (obra sem orcamento definido, por exemplo).
 */
export function divisaoSegura(numerador: number, denominador: number, fallback = 0): number {
  if (!denominador) return fallback;
  const r = numerador / denominador;
  return Number.isFinite(r) ? r : fallback;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}