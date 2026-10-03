/** Utilitarios de data. Datas sao `DATE` no Postgres: sao comparadas como
 *  strings `YYYY-MM-DD` para evitar deslocamentos de fuso horario. */

export function hoje(): Date {
  return new Date();
}

export function hojeISO(): string {
  return toISO(new Date());
}

/** `YYYY-MM-DD` a partir de Date ou string (string e assumida ja neste formato). */
export function toISO(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  // toISOString converte para UTC, o que pode "andar um dia" em fusos como
  // Maputo (UTC+2) quando a data local e a meia-noite. Usamos as partes locais.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Converte `YYYY-MM-DD` para Date UTC (evita o bug do fuso a meia-noite). */
export function fromISO(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
}

export function somaDias(d: Date | string, dias: number): string {
  const base = typeof d === 'string' ? fromISO(d) : d;
  const r = new Date(base);
  r.setUTCDate(r.getUTCDate() + dias);
  return toISO(r);
}

export function somaMeses(d: Date | string, meses: number): string {
  const base = typeof d === 'string' ? fromISO(d) : d;
  const r = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + meses, 1));
  return toISO(r);
}

export function primeiroDiaDoMes(d: Date | string): string {
  const s = toISO(d);
  return `${s.slice(0, 7)}-01`;
}

export function ultimoDiaDoMes(d: Date | string): string {
  const s = toISO(d);
  const [ano, mes] = s.split('-');
  const ultimo = new Date(Date.UTC(Number(ano), Number(mes), 0)).getUTCDate();
  return `${ano}-${mes}-${String(ultimo).padStart(2, '0')}`;
}

/** `YYYY-MM` — usado nos cortes mensais dos relatorios. */
export function mes(d: Date | string): string {
  return toISO(d).slice(0, 7);
}

export function diffDias(a: Date | string, b: Date | string): number {
  const ms = fromISO(toISO(a)).getTime() - fromISO(toISO(b)).getTime();
  return Math.round(ms / 86_400_000);
}

/** `2026-03-01` .. `2026-03-31` */
export function intervaloDoMes(d: Date | string): { de: string; ate: string } {
  return { de: primeiroDiaDoMes(d), ate: ultimoDiaDoMes(d) };
}

export function isoTimestamp(d: Date | string): string {
  return (typeof d === 'string' ? fromISO(d) : d).toISOString();
}