import { mkdirSync } from 'node:fs';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { pluginAuth } from './plugins/auth.js';
import { pluginBd } from './plugins/bd.js';
import { pluginErros } from './plugins/erros.js';
import { rotasAuth, rotasUtilizadores } from './routes/auth.js';
import { rotasCustos } from './routes/custos.js';
import { rotasDiario } from './routes/diario.js';
import { rotasEquipa } from './routes/equipa.js';
import { rotasMateriais } from './routes/materiais.js';
import { rotasObras } from './routes/obras.js';
import { rotasOrcamento } from './routes/orcamento.js';
import { rotasPagamentos } from './routes/pagamentos.js';
import { rotasPaySuite } from './routes/paysuite.js';
import { rotasRelatorios } from './routes/relatorios.js';
import { rotasRequisicoes } from './routes/requisicoes.js';
import { rotasStock } from './routes/stock.js';
import { rotasSubempreitada } from './routes/subempreitada.js';
import { rotasSync } from './routes/sync.js';
import { rotasWebhookPaySuite } from './routes/webhooks/paysuite.js';

export async function criarServidor(): Promise<FastifyInstance> {
  const app = fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : {
            level: config.nodeEnv === 'production' ? 'info' : 'debug',
            transport:
              config.nodeEnv === 'development'
                ? {
                    target: 'pino/file',
                  }
                : undefined,
          },
    trustProxy: true,
  });

  // 1. Plugins de Seguranca e Transporte
  await app.register(helmet, {
    contentSecurityPolicy: config.nodeEnv === 'production',
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: config.nodeEnv === 'test' ? 10_000 : 300,
    timeWindow: '1 minute',
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.uploads.maxBytes,
      files: 5,
    },
  });

  // Assegura diretorio de uploads antes de servir ficheiros estaticos
  mkdirSync(config.uploads.dir, { recursive: true });

  await app.register(fastifyStatic, {
    root: config.uploads.dir,
    prefix: '/uploads/',
    decorateReply: false,
  });

  // 2. Documentacao OpenAPI/Swagger
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'ObraMZ API',
        description: 'Backend SaaS de gestao de obras em Mocambique (multi-tenant, offline-first)',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
          description: 'Servidor atual',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // 3. Plugins Centrais: BD, Erros e Auth
  await app.register(pluginBd);
  await app.register(pluginErros);
  await app.register(pluginAuth);

  // 4. Health Check / Status
  app.get('/health', async () => {
    return {
      status: 'ok',
      servico: 'obramz-api',
      versao: '1.0.0',
      timestamp: new Date().toISOString(),
      ambiente: config.nodeEnv,
    };
  });

  // 5. Registo de Rotas de Dominio sob prefixo /api/v1
  await app.register(
    async (api) => {
      await api.register(rotasAuth, { prefix: '/auth' });
      await api.register(rotasUtilizadores, { prefix: '/utilizadores' });
      await api.register(rotasObras, { prefix: '/obras' });
      await api.register(rotasOrcamento, { prefix: '/orcamento' });
      await api.register(rotasCustos, { prefix: '/custos' });
      await api.register(rotasMateriais, { prefix: '/materiais' });
      await api.register(rotasStock, { prefix: '/stock' });
      await api.register(rotasRequisicoes, { prefix: '/requisicoes' });
      await api.register(rotasDiario, { prefix: '/diario' });
      await api.register(rotasEquipa, { prefix: '/equipa' });
      await api.register(rotasSubempreitada, { prefix: '/subempreitada' });
      await api.register(rotasPagamentos, { prefix: '/pagamentos' });
      await api.register(rotasPaySuite, { prefix: '/paysuite' });
      await api.register(rotasRelatorios, { prefix: '/relatorios' });
      await api.register(rotasSync, { prefix: '/sync' });
    },
    { prefix: '/api/v1' },
  );

  // 6. Webhooks externos (publicos, sem JWT — autenticam por assinatura)
  await app.register(rotasWebhookPaySuite);

  return app;
}
