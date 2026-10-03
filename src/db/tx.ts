import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { Database } from './client.js';

/** Transacao corrente do drizzle. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Superficie que aceita tanto a ligacao directa como uma transacao. Os
 * servicos declaram `Ctx` para poder participar de uma transacao do chamador
 * sem perder a tipagem.
 */
export type Ctx = Database | Tx;

/** `select count(*)` — os aliases numericos chegam como string em alguns drivers. */
export function paraInteiro(v: unknown): number {
  return Number(v ?? 0);
}

/**
 * Primeira linha de um resultado, ou `undefined`.
 *
 * Existe porque `select` devolve sempre um array e o TypeScript nao sabe que um
 * `aggregate` devolve exactamente uma linha: escrever `const [x] = await ...`
 * deixa `x` como possivelmente `undefined` e obriga a `x!.campo` em todo o
 * sitio. Aqui o `undefined` fica explicito e unico.
 */
export function primeiro<T>(linhas: T[]): T | undefined {
  return linhas[0];
}

/**
 * Primeira linha de um resultado que se sabe ser unica. Para agregacoes
 * (`count`, `sum`) uma linha e sempre devolvida, por isso o `!` e seguro e o
 * tipo fica limpo sem `as`.
 */
export function unico<T>(linhas: T[]): T {
  return linhas[0] as T;
}