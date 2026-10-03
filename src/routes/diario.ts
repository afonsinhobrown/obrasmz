import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  actualizarEntrada,
  anexarFoto,
  apagarEntrada,
  apagarFoto,
  estatisticasDiario,
  listarEntradas,
  obterEntrada,
  registarEntrada,
  schemaEntrada,
  schemaFoto,
  schemaListarDiario,
} from '../services/diario.js';
import { ctxReq } from './helpers.js';

export async function rotasDiario(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.get(
    '/',
    { preHandler: [app.exigir('diario:ler')] },
    async (req: FastifyRequest) => {
      const filtro = schemaListarDiario.parse(req.query);
      const limite = z.coerce.number().int().positive().max(500).default(100).parse((req.query as { limite?: unknown }).limite);
      return listarEntradas(app.db, req.tenantId!, filtro, limite);
    },
  );

  app.post(
    '/',
    { preHandler: [app.exigir('diario:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaEntrada.parse(req.body);
      const entrada = await registarEntrada(
        app.db,
        req.tenantId!,
        req.utilizadorId!,
        dados,
        ctxReq(req),
      );
      return reply.code(201).send(entrada);
    },
  );

  app.get('/estatisticas', async (req: FastifyRequest) => {
    const q = z
      .object({
        de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.query);
    return estatisticasDiario(app.db, req.tenantId!, q.de, q.ate);
  });

  app.get('/:id', async (req: FastifyRequest) => {
    return obterEntrada(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.patch(
    '/:id',
    { preHandler: [app.exigir('diario:escrever')] },
    async (req: FastifyRequest) => {
      const dados = schemaEntrada.partial().parse(req.body);
      return actualizarEntrada(app.db, req.tenantId!, (req.params as { id: string }).id, dados, ctxReq(req));
    },
  );

  app.delete(
    '/:id',
    { preHandler: [app.exigir('diario:escrever')] },
    async (req: FastifyRequest, reply) => {
      const body = (req.body ?? {}) as { motivo?: string };
      await apagarEntrada(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req), body.motivo);
      return reply.code(204).send();
    },
  );

  app.post(
    '/:id/fotos',
    { preHandler: [app.exigir('diario:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaFoto.parse(req.body);
      const foto = await anexarFoto(app.db, req.tenantId!, (req.params as { id: string }).id, dados, ctxReq(req));
      return reply.code(201).send(foto);
    },
  );

  app.delete(
    '/fotos/:id',
    { preHandler: [app.exigir('diario:escrever')] },
    async (req: FastifyRequest, reply) => {
      await apagarFoto(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req));
      return reply.code(204).send();
    },
  );
}
