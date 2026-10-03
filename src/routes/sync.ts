import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { estadoSync, fazerPull, fazerPush, schemaPush } from '../services/sync.js';
import { ctxReq } from './helpers.js';

export async function rotasSync(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.post('/push', async (req: FastifyRequest) => {
    const dados = schemaPush.parse(req.body);
    return fazerPush(app.db, req.tenantId!, req.utilizadorId!, dados, ctxReq(req));
  });

  app.get('/pull', async (req: FastifyRequest) => {
    const q = z
      .object({
        desde: z.string().datetime().optional(),
        limite: z.coerce.number().int().positive().max(config.sync.pageMax).optional(),
        incluirApagados: z.coerce.boolean().default(false),
      })
      .parse(req.query);
    return fazerPull(app.db, req.tenantId!, q);
  });

  app.get('/estado', async (req: FastifyRequest) => {
    const { dispositivoId } = z
      .object({ dispositivoId: z.string().uuid().optional() })
      .parse(req.query);
    return estadoSync(app.db, req.tenantId!, dispositivoId ?? '');
  });
}
