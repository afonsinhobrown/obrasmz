import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  actualizarItem,
  apagarItem,
  criarItem,
  detalheItens,
  importarCsv,
  listarItens,
  schemaActualizarItem,
  schemaItem,
} from '../services/orcamento.js';
import { ctxReq } from './helpers.js';

export async function rotasOrcamento(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  // Itens do orcamento de uma obra
  app.get('/obras/:obraId/itens', async (req: FastifyRequest) => {
    return listarItens(app.db, req.tenantId!, (req.params as { obraId: string }).obraId);
  });

  app.get(
    '/obras/:obraId/itens/detalhe',
    async (req: FastifyRequest) => {
      return detalheItens(app.db, req.tenantId!, (req.params as { obraId: string }).obraId);
    },
  );

  app.post(
    '/obras/:obraId/itens',
    { preHandler: [app.exigir('orcamento:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaItem.parse(req.body);
      const item = await criarItem(app.db, req.tenantId!, (req.params as { obraId: string }).obraId, dados, ctxReq(req));
      return reply.code(201).send(item);
    },
  );

  app.patch(
    '/itens/:id',
    { preHandler: [app.exigir('orcamento:escrever')] },
    async (req: FastifyRequest) => {
      const dados = schemaActualizarItem.parse(req.body);
      return actualizarItem(app.db, req.tenantId!, (req.params as { id: string }).id, dados, ctxReq(req));
    },
  );

  app.delete(
    '/itens/:id',
    { preHandler: [app.exigir('orcamento:escrever')] },
    async (req: FastifyRequest, reply) => {
      await apagarItem(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req));
      return reply.code(204).send();
    },
  );

  // Importacao CSV: { csv, opcoes?: { substituir?, modo? } }
  app.post(
    '/obras/:obraId/itens/importar-csv',
    { preHandler: [app.exigir('orcamento:escrever')] },
    async (req: FastifyRequest) => {
      const { csv, opcoes } = z
        .object({
          csv: z.string().min(1, 'Envie o conteudo do ficheiro CSV'),
          opcoes: z
            .object({
              substituir: z.boolean().optional(),
              modo: z.enum(['validar', 'importar']).optional(),
            })
            .default({}),
        })
        .parse(req.body);
      return importarCsv(app.db, req.tenantId!, (req.params as { obraId: string }).obraId, csv, opcoes, ctxReq(req));
    },
  );
}
