import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  actualizarCusto,
  apagarCusto,
  custosPorMes,
  custosPorTipo,
  lancarCusto,
  listarCustos,
  listarTaxas,
  obterCusto,
  previsualizar,
  registarTaxa,
  schemaLancarCusto,
  schemaListarCustos,
  schemaTaxa,
} from '../services/custos.js';
import { paginaSchema } from '../lib/validadores.js';
import { ctxReq } from './helpers.js';

export async function rotasCustos(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.get(
    '/',
    { preHandler: [app.exigir('custos:ler')] },
    async (req: FastifyRequest) => {
      const filtros = schemaListarCustos.parse(req.query);
      const pagina = paginaSchema.parse(req.query);
      return listarCustos(app.db, req.tenantId!, filtros, pagina);
    },
  );

  app.post(
    '/',
    { preHandler: [app.exigir('custos:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaLancarCusto.parse(req.body);
      const custo = await lancarCusto(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send(custo);
    },
  );

  app.get('/:id', async (req: FastifyRequest) => {
    return obterCusto(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.patch(
    '/:id',
    { preHandler: [app.exigir('custos:escrever')] },
    async (req: FastifyRequest) => {
      const campos = schemaLancarCusto.partial().parse(req.body);
      return actualizarCusto(app.db, req.tenantId!, (req.params as { id: string }).id, campos, ctxReq(req));
    },
  );

  app.delete(
    '/:id',
    { preHandler: [app.exigir('custos:apagar')] },
    async (req: FastifyRequest, reply) => {
      const { motivo } = z.object({ motivo: z.string().min(1, 'Indique o motivo') }).parse(req.body);
      await apagarCusto(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req), motivo);
      return reply.code(204).send();
    },
  );

  app.get('/obra/:obraId/por-tipo', async (req: FastifyRequest) => {
    return custosPorTipo(app.db, req.tenantId!, (req.params as { obraId: string }).obraId);
  });

  app.get('/por-mes', async (req: FastifyRequest) => {
    const q = z
      .object({
        obraId: z.string().uuid().optional(),
        de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.query);
    return custosPorMes(app.db, req.tenantId!, q);
  });

  // Cambio
  app.post(
    '/taxas',
    { preHandler: [app.exigir('cambio:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaTaxa.parse(req.body);
      const t = await registarTaxa(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send(t);
    },
  );

  app.get('/taxas', async (req: FastifyRequest) => {
    const { data } = z
      .object({ data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(req.query);
    return listarTaxas(app.db, req.tenantId!, data);
  });

  app.get('/taxas/previsualizar', async (req: FastifyRequest) => {
    const q = z
      .object({
        valor: z.coerce.number().positive(),
        moeda: z.string().length(3),
        data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(req.query);
    return previsualizar(app.db, req.tenantId!, q.valor, q.moeda, q.data);
  });
}
