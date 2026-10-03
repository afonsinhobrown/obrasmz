import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Database } from '../db/client.js';
import { criarDb } from '../db/client.js';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

/**
 * Liga o drizzle a instancia do Fastify. A pool e partilhada com o CLI de
 * migrations/seed para nao abrir duas pools em desenvolvimento.
 */
export const pluginBd = fp(async (app: FastifyInstance) => {
  const db = criarDb();

  app.decorate('db', db);

  app.addHook('onClose', async () => {
    await db.pool.end();
  });

  app.log.info(
    { poolMax: config.db.poolMax, nodeEnv: config.nodeEnv },
    'base de dados ligada',
  );
});