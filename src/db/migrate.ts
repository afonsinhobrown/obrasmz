/**
 * Corre as migrations antes de a aplicacao aceitar pedidos.
 *
 * Porquê um runner em vez de `drizzle-kit migrate` no arranque: o `drizzle-kit`
 * é uma dependencia de desenvolvimento e a aplicação em produção corre sem ela.
 * Além disso, o arranque tem de **falhar depressa** se a base não estiver no
 * estado esperado — é melhor um container que morre logo do que um serviço que
 * aceita pedidos e devolve "relation does not exist" a cada um deles.
 *
 * O `drizzle-orm/node-postgres/migrator` aplica os ficheiros de `drizzle/` por
 * ordem, cada um numa transação, registando o que aplicou em
 * `__drizzle_migrations`. Reexecutar é seguro: o que já foi aplicado é ignorado.
 */
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { config } from '../config.js';

export type ResultadoMigrations = {
  aplicadas: number;
  /** Ficheiros ja aplicados antes desta execucao. */
  jaAplicadas: number;
};

export async function correrMigrations(
  pastaMigrations = resolve(process.cwd(), 'drizzle'),
): Promise<ResultadoMigrations> {
  const pool = new pg.Pool({
    connectionString: config.db.url,
    max: 2,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const db = drizzle(pool);
    const antes = await contarAplicadas(pool);

    await migrate(db, { migrationsFolder: pastaMigrations });

    const depois = await contarAplicadas(pool);
    return { aplicadas: depois - antes, jaAplicadas: antes };
  } finally {
    await pool.end();
  }
}

async function contarAplicadas(pool: pg.Pool): Promise<number> {
  try {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`,
    );
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    // A primeira migration ainda nao correu: a tabela de controlo nao existe.
    return 0;
  }
}

/**
 * Verifica que a base responde e que as migrations estao em dia.
 * Usado no `/health` e no arranque.
 */
export async function verificarMigrations(
  pastaMigrations = resolve(process.cwd(), 'drizzle'),
): Promise<{ ok: boolean; motivo?: string }> {
  try {
    await correrMigrations(pastaMigrations);
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : String(err) };
  }
}

// Quando corrido diretamente (`npm run migrate`), aplica as migrations.
// Detectamos pelo argumento de arranque para nao executar quando o modulo e
// importado por outro ficheiro.
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  correrMigrations()
    .then((r) => {
      console.log(
        r.aplicadas > 0
          ? `[obramz] ${r.aplicadas} migration(s) aplicada(s).`
          : `[obramz] Base em dia (${r.jaAplicadas} aplicadas).`,
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error('[obramz] Falha nas migrations:', err);
      process.exit(1);
    });
}
