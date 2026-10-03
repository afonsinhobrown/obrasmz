import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  anularFatura,
  gerarFatura,
  listarFaturas,
  marcarFaturaPaga,
  obterFatura,
  preverNumeroFatura,
  schemaFatura,
} from '../services/faturacao.js';
import { ctxReq } from './helpers.js';

export async function rotasFaturas(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.get(
    '/',
    { preHandler: [app.exigir('faturas:ler')] },
    async (req: FastifyRequest) => {
      const filtro = z
        .object({
          obraId: z.string().uuid().optional(),
          estado: z.enum(['emitida', 'anulada', 'paga']).optional(),
          clienteNuit: z.string().max(30).optional(),
          de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          limite: z.coerce.number().int().positive().max(500).optional(),
        })
        .parse(req.query);
      return listarFaturas(app.db, req.tenantId!, filtro);
    },
  );

  /** Preve o proximo numero (e o emitente por omissao) sem o consumir. */
  app.get(
    '/proximo-numero',
    { preHandler: [app.exigir('faturas:ler')] },
    async (req: FastifyRequest) => {
      return preverNumeroFatura(app.db, req.tenantId!);
    },
  );

  app.post(
    '/',
    { preHandler: [app.exigir('faturas:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaFatura.parse(req.body);
      const fatura = await gerarFatura(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send(fatura);
    },
  );

  app.get(
    '/:id',
    { preHandler: [app.exigir('faturas:ler')] },
    async (req: FastifyRequest) => {
      return obterFatura(app.db, req.tenantId!, (req.params as { id: string }).id);
    },
  );

  app.post(
    '/:id/anular',
    { preHandler: [app.exigir('faturas:anular')] },
    async (req: FastifyRequest) => {
      const { motivo } = z
        .object({ motivo: z.string().min(1, 'Indique o motivo') })
        .parse(req.body);
      return anularFatura(app.db, req.tenantId!, (req.params as { id: string }).id, motivo, ctxReq(req));
    },
  );

  /** Marca como paga apos recebimento. */
  app.post(
    '/:id/pagar',
    { preHandler: [app.exigir('faturas:escrever')] },
    async (req: FastifyRequest) => {
      return marcarFaturaPaga(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req));
    },
  );
}
