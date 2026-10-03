import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  aprovarRequisicao,
  atenderRequisicao,
  criarRequisicao,
  estatisticasRequisicoes,
  listarRequisicoes,
  obterRequisicao,
  rejeitarRequisicao,
  schemaAtender,
  schemaCriarRequisicao,
  schemaDecisao,
} from '../services/requisicoes.js';
import { ctxReq } from './helpers.js';

export async function rotasRequisicoes(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.get(
    '/',
    { preHandler: [app.exigir('requisicoes:ler')] },
    async (req: FastifyRequest) => {
      const filtro = z
        .object({
          estado: z.enum(['pendente', 'aprovada', 'rejeitada', 'atendida']).optional(),
          obraId: z.string().uuid().optional(),
          solicitanteId: z.string().uuid().optional(),
          limite: z.coerce.number().int().positive().optional(),
        })
        .parse(req.query);
      return listarRequisicoes(app.db, req.tenantId!, filtro);
    },
  );

  app.post(
    '/',
    { preHandler: [app.exigir('requisicoes:criar')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaCriarRequisicao.parse(req.body);
      const requisicao = await criarRequisicao(
        app.db,
        req.tenantId!,
        req.utilizadorId!,
        dados,
        ctxReq(req),
      );
      return reply.code(201).send(requisicao);
    },
  );

  app.get('/estatisticas', async (req: FastifyRequest) => {
    return estatisticasRequisicoes(app.db, req.tenantId!);
  });

  app.get('/:id', async (req: FastifyRequest) => {
    return obterRequisicao(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.post(
    '/:id/aprovar',
    { preHandler: [app.exigir('requisicoes:aprovar')] },
    async (req: FastifyRequest) => {
      const body = schemaDecisao.parse(req.body ?? {});
      return aprovarRequisicao(
        app.db,
        req.tenantId!,
        (req.params as { id: string }).id,
        req.utilizadorId!,
        ctxReq(req),
        body.observacoes ?? null,
      );
    },
  );

  app.post(
    '/:id/rejeitar',
    { preHandler: [app.exigir('requisicoes:aprovar')] },
    async (req: FastifyRequest) => {
      const { motivo, observacoes } = z
        .object({ motivo: z.string().min(1, 'Indique o motivo da rejeicao'), observacoes: z.string().max(1000).nullable().optional() })
        .parse(req.body);
      return rejeitarRequisicao(
        app.db,
        req.tenantId!,
        (req.params as { id: string }).id,
        req.utilizadorId!,
        motivo,
        ctxReq(req),
      );
    },
  );

  app.post(
    '/:id/atender',
    { preHandler: [app.exigir('requisicoes:atender')] },
    async (req: FastifyRequest) => {
      const dados = schemaAtender.parse(req.body);
      return atenderRequisicao(app.db, req.tenantId!, (req.params as { id: string }).id, dados, ctxReq(req));
    },
  );
}
