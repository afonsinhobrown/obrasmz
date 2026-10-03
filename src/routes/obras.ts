import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  actualizarObra,
  apagarObra,
  criarObra,
  definirMembros,
  listarMembros,
  listarObras,
  obterObra,
  recalcularProgresso,
  resumoObra,
  schemaActualizarObra,
  schemaCriarObra,
  schemaListarObras,
  totaisOrcamento,
} from '../services/obras.js';
import { paginaSchema } from '../lib/validadores.js';
import { ctxReq } from './helpers.js';

export async function rotasObras(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.get('/', async (req: FastifyRequest) => {
    const filtros = schemaListarObras.parse(req.query);
    const pagina = paginaSchema.parse(req.query);
    return listarObras(app.db, req.tenantId!, filtros, pagina);
  });

  app.post(
    '/',
    { preHandler: [app.exigir('obras:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaCriarObra.parse(req.body);
      const obra = await criarObra(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send(obra);
    },
  );

  app.get('/:id', async (req: FastifyRequest) => {
    return obterObra(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.get('/:id/resumo', async (req: FastifyRequest) => {
    return resumoObra(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.patch(
    '/:id',
    { preHandler: [app.exigir('obras:escrever')] },
    async (req: FastifyRequest) => {
      const dados = schemaActualizarObra.parse(req.body);
      return actualizarObra(app.db, req.tenantId!, (req.params as { id: string }).id, dados, ctxReq(req));
    },
  );

  app.delete(
    '/:id',
    { preHandler: [app.exigir('obras:apagar')] },
    async (req: FastifyRequest, reply) => {
      await apagarObra(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req));
      return reply.code(204).send();
    },
  );

  app.get('/:id/totais-orcamento', async (req: FastifyRequest) => {
    return totaisOrcamento(app.db, (req.params as { id: string }).id);
  });

  app.post(
    '/:id/recalcular-progresso',
    { preHandler: [app.exigir('obras:escrever')] },
    async (req: FastifyRequest) => {
      const progressoPct = await recalcularProgresso(app.db, (req.params as { id: string }).id);
      return { progressoPct };
    },
  );

  app.get('/:id/membros', async (req: FastifyRequest) => {
    return listarMembros(app.db, (req.params as { id: string }).id);
  });

  app.put(
    '/:id/membros',
    { preHandler: [app.exigir('obras:escrever')] },
    async (req: FastifyRequest) => {
      const { ids } = z.object({ ids: z.array(z.string().uuid()) }).parse(req.body);
      await definirMembros(app.db, req.tenantId!, (req.params as { id: string }).id, ids);
      return listarMembros(app.db, (req.params as { id: string }).id);
    },
  );
}
