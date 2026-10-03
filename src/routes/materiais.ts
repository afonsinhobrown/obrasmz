import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  actualizarMaterial,
  alertasStock,
  apagarMaterial,
  criarMaterial,
  extratoMaterial,
  listarMateriais,
  obterMaterial,
  saldosPorObra,
  saldo,
  schemaListarMateriais,
  schemaMaterial,
  stockValorizado,
} from '../services/materiais.js';
import { paginaSchema } from '../lib/validadores.js';
import { ctxReq } from './helpers.js';

export async function rotasMateriais(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.get(
    '/',
    { preHandler: [app.exigir('materiais:ler')] },
    async (req: FastifyRequest) => {
      const filtros = schemaListarMateriais.parse(req.query);
      const pagina = paginaSchema.parse(req.query);
      return listarMateriais(app.db, req.tenantId!, filtros, pagina);
    },
  );

  app.post(
    '/',
    { preHandler: [app.exigir('materiais:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaMaterial.parse(req.body);
      const m = await criarMaterial(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send(m);
    },
  );

  app.get('/:id', async (req: FastifyRequest) => {
    return obterMaterial(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.patch(
    '/:id',
    { preHandler: [app.exigir('materiais:escrever')] },
    async (req: FastifyRequest) => {
      const campos = schemaMaterial.partial().parse(req.body);
      return actualizarMaterial(app.db, req.tenantId!, (req.params as { id: string }).id, campos, ctxReq(req));
    },
  );

  app.delete(
    '/:id',
    { preHandler: [app.exigir('materiais:escrever')] },
    async (req: FastifyRequest, reply) => {
      await apagarMaterial(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req));
      return reply.code(204).send();
    },
  );

  // Posicao de stock
  app.get('/:id/saldo', async (req: FastifyRequest) => {
    const { obraId } = zParseQuery(req.query, { obraId: z.string().uuid() });
    return saldo(app.db, req.tenantId!, obraId, (req.params as { id: string }).id);
  });

  app.get('/:id/saldos-por-obra', async (req: FastifyRequest) => {
    return saldosPorObra(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.get('/alertas', async (req: FastifyRequest) => {
    const { obraId } = zParseQuery(req.query, { obraId: z.string().uuid().optional() });
    return alertasStock(app.db, req.tenantId!, obraId);
  });

  app.get('/valorizado', async (req: FastifyRequest) => {
    const { obraId } = zParseQuery(req.query, { obraId: z.string().uuid().optional() });
    return stockValorizado(app.db, req.tenantId!, obraId);
  });

  app.get('/:id/extrato', async (req: FastifyRequest) => {
    const q = zParseQuery(req.query, {
      obraId: z.string().uuid(),
      limite: z.coerce.number().int().positive().optional(),
    });
    return extratoMaterial(app.db, req.tenantId!, (req.params as { id: string }).id, q.obraId, q.limite ?? 200);
  });
}

function zParseQuery<T extends z.ZodRawShape>(query: unknown, shape: T): z.infer<z.ZodObject<T>> {
  return z.object(shape).parse(query);
}
