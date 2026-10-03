import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof criarDb>;

/**
 * NUMERIC chega como string para nao perder precisao. `pg.types` mantem esse
 * comportamento por omissao; so forçamos int8->string explicito porque o
 * driver devolve BIGINT como string noutros drivers.
 */
pg.types.setTypeParser(1700, (v) => v); // numeric
pg.types.setTypeParser(20, (v) => v); // int8

export function criarDb(url: string = config.db.url) {
  const pool = new pg.Pool({
    connectionString: url,
    max: config.db.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  const db = drizzle(pool, { schema, logger: config.nodeEnv === 'development' });
  return Object.assign(db, { pool });
}

export { schema };
export * from './schema.js';