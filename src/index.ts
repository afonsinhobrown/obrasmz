import { config } from './config.js';
import { correrMigrations } from './db/migrate.js';
import { criarServidor } from './server.js';

async function main() {
  // 1. Executa migrations pendentes antes de iniciar o listener
  try {
    const res = await correrMigrations();
    if (res.aplicadas > 0) {
      console.log(`[obramz] ${res.aplicadas} migration(s) aplicada(s) com sucesso.`);
    }
  } catch (err) {
    console.error('[obramz] Falha critica ao executar migrations:', err);
    process.exit(1);
  }

  // 2. Instancia o servidor Fastify
  const app = await criarServidor();

  // 3. Graceful shutdown
  const fechar = async (sinal: string) => {
    app.log.info({ sinal }, 'A encerrar servidor graciosa e seguramente...');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Erro ao encerrar servidor');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => fechar('SIGINT'));
  process.on('SIGTERM', () => fechar('SIGTERM'));

  // 4. Inicia escuta HTTP
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`[obramz] Servidor a correr em http://${config.host}:${config.port}`);
    console.log(`[obramz] Documentacao Swagger disponivel em http://${config.host}:${config.port}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  main();
}
