import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  actualizarContrato,
  actualizarSubempreiteiro,
  anularMedicao,
  apagarSubempreiteiro,
  criarContrato,
  criarSubempreiteiro,
  especialidades,
  listarContratos,
  listarMedicoes,
  listarSubempreiteiros,
  obterContrato,
  obterSubempreiteiro,
  posicaoContrato,
  registarMedicao,
  schemaActualizarContrato,
  schemaContrato,
  schemaMedicao,
  schemaSubempreiteiro,
} from '../services/subempreitada.js';
import { ctxReq } from './helpers.js';

export async function rotasSubempreitada(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  // Subempreiteiros
  app.get(
    '/subempreiteiros',
    { preHandler: [app.exigir('subempreitada:ler')] },
    async (req: FastifyRequest) => {
      const { texto } = z.object({ texto: z.string().max(120).optional() }).parse(req.query);
      return listarSubempreiteiros(app.db, req.tenantId!, texto);
    },
  );

  app.post(
    '/subempreiteiros',
    { preHandler: [app.exigir('subempreitada:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaSubempreiteiro.parse(req.body);
      const s = await criarSubempreiteiro(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send(s);
    },
  );

  app.get('/subempreiteiros/:id', async (req: FastifyRequest) => {
    return obterSubempreiteiro(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.patch(
    '/subempreiteiros/:id',
    { preHandler: [app.exigir('subempreitada:escrever')] },
    async (req: FastifyRequest) => {
      const campos = schemaSubempreiteiro.partial().parse(req.body);
      return actualizarSubempreiteiro(app.db, req.tenantId!, (req.params as { id: string }).id, campos, ctxReq(req));
    },
  );

  app.delete(
    '/subempreiteiros/:id',
    { preHandler: [app.exigir('subempreitada:escrever')] },
    async (req: FastifyRequest, reply) => {
      await apagarSubempreiteiro(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req));
      return reply.code(204).send();
    },
  );

  app.get('/especialidades', async (req: FastifyRequest) => {
    return especialidades(app.db, req.tenantId!);
  });

  // Contratos
  app.get(
    '/contratos',
    { preHandler: [app.exigir('subempreitada:ler')] },
    async (req: FastifyRequest) => {
      const filtro = z
        .object({
          obraId: z.string().uuid().optional(),
          subempreiteiroId: z.string().uuid().optional(),
          estado: z.enum(['activo', 'concluido', 'cancelado']).optional(),
        })
        .parse(req.query);
      return listarContratos(app.db, req.tenantId!, filtro);
    },
  );

  app.post(
    '/contratos',
    { preHandler: [app.exigir('subempreitada:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaContrato.parse(req.body);
      const c = await criarContrato(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send(c);
    },
  );

  app.get('/contratos/:id', async (req: FastifyRequest) => {
    return obterContrato(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.get('/contratos/:id/posicao', async (req: FastifyRequest) => {
    return posicaoContrato(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.patch(
    '/contratos/:id',
    { preHandler: [app.exigir('subempreitada:escrever')] },
    async (req: FastifyRequest) => {
      const campos = schemaActualizarContrato.parse(req.body);
      return actualizarContrato(app.db, req.tenantId!, (req.params as { id: string }).id, campos, ctxReq(req));
    },
  );

  // Medicoes
  app.get('/contratos/:id/medicoes', async (req: FastifyRequest) => {
    return listarMedicoes(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.post(
    '/contratos/:id/medicoes',
    { preHandler: [app.exigir('subempreitada:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaMedicao.parse(req.body);
      const m = await registarMedicao(app.db, req.tenantId!, (req.params as { id: string }).id, dados, ctxReq(req));
      return reply.code(201).send(m);
    },
  );

  app.post(
    '/medicoes/:id/anular',
    { preHandler: [app.exigir('subempreitada:escrever')] },
    async (req: FastifyRequest) => {
      const { motivo } = z.object({ motivo: z.string().min(1, 'Indique o motivo') }).parse(req.body);
      return anularMedicao(app.db, req.tenantId!, (req.params as { id: string }).id, motivo, ctxReq(req));
    },
  );
}
