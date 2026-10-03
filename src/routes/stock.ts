import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  estornarMovimento,
  listarMovimentos,
  registarMovimento,
  resumoStock,
  schemaMovimento,
} from '../services/stock.js';
import { ctxReq } from './helpers.js';

export async function rotasStock(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.post(
    '/movimentos',
    { preHandler: [app.exigir('stock:movimentar')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaMovimento.parse(req.body);
      const movimento = await registarMovimento(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send(movimento);
    },
  );

  app.get(
    '/movimentos',
    { preHandler: [app.exigir('stock:ler')] },
    async (req: FastifyRequest) => {
      const filtro = z
        .object({
          obraId: z.string().uuid().optional(),
          materialId: z.string().uuid().optional(),
          tipo: z.enum(['entrada', 'saida', 'ajuste', 'transferencia']).optional(),
          de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          limite: z.coerce.number().int().positive().optional(),
        })
        .parse(req.query);
      return listarMovimentos(app.db, req.tenantId!, filtro);
    },
  );

  app.post(
    '/movimentos/:id/estornar',
    { preHandler: [app.exigir('stock:movimentar')] },
    async (req: FastifyRequest) => {
      const { motivo } = z.object({ motivo: z.string().min(1, 'Indique o motivo') }).parse(req.body);
      return estornarMovimento(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req), motivo);
    },
  );

  app.get(
    '/resumo',
    { preHandler: [app.exigir('stock:ler')] },
    async (req: FastifyRequest) => {
      const { obraId } = z
        .object({ obraId: z.string().uuid().optional() })
        .parse(req.query);
      return resumoStock(app.db, req.tenantId!, obraId);
    },
  );
}
