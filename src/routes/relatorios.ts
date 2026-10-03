import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  alertasArmazem,
  contaCorrente,
  curvaS,
  custosPorMes,
  dashboard,
  materiaisMaisConsumidos,
  mapaPagamentos,
  orcemPorRubrica,
  orcadoVsReal,
  producaoMensal,
  presencasPorObra,
  produtividade,
  requisicoesParadas,
} from '../services/relatorios.js';

const periodoSchema = z
  .object({
    de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .default({});

export async function rotasRelatorios(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);
  app.addHook('preHandler', app.exigir('relatorios:ler'));

  app.get('/dashboard', async (req: FastifyRequest) => {
    return dashboard(app.db, req.tenantId!);
  });

  app.get('/orcado-vs-real', async (req: FastifyRequest) => {
    return orcadoVsReal(app.db, req.tenantId!, periodoSchema.parse(req.query));
  });

  app.get('/curva-s/:obraId', async (req: FastifyRequest) => {
    return curvaS(app.db, req.tenantId!, (req.params as { obraId: string }).obraId);
  });

  app.get('/conta-corrente/:obraId', async (req: FastifyRequest) => {
    return contaCorrente(app.db, req.tenantId!, (req.params as { obraId: string }).obraId, periodoSchema.parse(req.query));
  });

  app.get('/custos-por-mes', async (req: FastifyRequest) => {
    return custosPorMes(app.db, req.tenantId!, periodoSchema.parse(req.query));
  });

  app.get('/orcamento-por-rubrica/:obraId', async (req: FastifyRequest) => {
    return orcemPorRubrica(app.db, req.tenantId!, (req.params as { obraId: string }).obraId);
  });

  app.get('/produtividade', async (req: FastifyRequest) => {
    return produtividade(app.db, req.tenantId!, periodoSchema.parse(req.query));
  });

  app.get('/presencas-por-obra', async (req: FastifyRequest) => {
    return presencasPorObra(app.db, req.tenantId!, periodoSchema.parse(req.query));
  });

  app.get('/mapa-pagamentos', async (req: FastifyRequest) => {
    return mapaPagamentos(app.db, req.tenantId!, periodoSchema.parse(req.query));
  });

  app.get('/alertas-armazem', async (req: FastifyRequest) => {
    return alertasArmazem(app.db, req.tenantId!);
  });

  app.get('/requisicoes-paradas', async (req: FastifyRequest) => {
    return requisicoesParadas(app.db, req.tenantId!);
  });

  app.get('/producao-mensal', async (req: FastifyRequest) => {
    return producaoMensal(app.db, req.tenantId!, periodoSchema.parse(req.query));
  });

  app.get('/materiais-mais-consumidos', async (req: FastifyRequest) => {
    return materiaisMaisConsumidos(app.db, req.tenantId!, periodoSchema.parse(req.query));
  });
}
