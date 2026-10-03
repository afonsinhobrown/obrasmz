import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  apagarPresenca,
  anularFolha,
  actualizarTrabalhador,
  apagarTrabalhador,
  criarTrabalhador,
  folhaDePonto,
  gerarFolha,
  lancarFolha,
  listarFolhas,
  listarPresencas,
  listarTrabalhadores,
  obterTrabalhador,
  registarPresenca,
  registarPresencasLote,
  resumirFolha,
  schemaFolha,
  schemaListarTrabalhadores,
  schemaPresenca,
  schemaTrabalhador,
} from '../services/equipa.js';
import { ctxReq } from './helpers.js';

export async function rotasEquipa(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.get(
    '/trabalhadores',
    { preHandler: [app.exigir('ponto:ler')] },
    async (req: FastifyRequest) => {
      const filtro = schemaListarTrabalhadores.parse(req.query);
      return listarTrabalhadores(app.db, req.tenantId!, filtro);
    },
  );

  app.post(
    '/trabalhadores',
    { preHandler: [app.exigir('ponto:registar')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaTrabalhador.parse(req.body);
      const id = await criarTrabalhador(app.db, req.tenantId!, dados, ctxReq(req));
      reply.code(201);
      return { id };
    },
  );

  app.get('/trabalhadores/:id', async (req: FastifyRequest) => {
    return obterTrabalhador(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.patch(
    '/trabalhadores/:id',
    { preHandler: [app.exigir('ponto:registar')] },
    async (req: FastifyRequest) => {
      const campos = schemaTrabalhador.partial().parse(req.body);
      return actualizarTrabalhador(app.db, req.tenantId!, (req.params as { id: string }).id, campos, ctxReq(req));
    },
  );

  app.delete(
    '/trabalhadores/:id',
    { preHandler: [app.exigir('ponto:registar')] },
    async (req: FastifyRequest, reply) => {
      await apagarTrabalhador(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req));
      return reply.code(204).send();
    },
  );

  // Presencas
  app.get('/presencas', async (req: FastifyRequest) => {
    const q = z
      .object({
        obraId: z.string().uuid().optional(),
        trabalhadorId: z.string().uuid().optional(),
        de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limite: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    return listarPresencas(app.db, req.tenantId!, q);
  });

  app.post(
    '/presencas',
    { preHandler: [app.exigir('ponto:registar')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaPresenca.parse(req.body);
      const id = await registarPresenca(app.db, req.tenantId!, req.utilizadorId!, dados, ctxReq(req));
      return reply.code(201).send({ id });
    },
  );

  app.post(
    '/presencas/lote',
    { preHandler: [app.exigir('ponto:registar')] },
    async (req: FastifyRequest, reply) => {
      const dados = z.array(schemaPresenca).parse(req.body);
      const res = await registarPresencasLote(
        app.db,
        req.tenantId!,
        req.utilizadorId!,
        dados,
        ctxReq(req),
      );
      return reply.code(201).send(res);
    },
  );

  app.delete(
    '/presencas/:id',
    { preHandler: [app.exigir('ponto:registar')] },
    async (req: FastifyRequest, reply) => {
      const body = (req.body ?? {}) as { motivo?: string };
      await apagarPresenca(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req), body.motivo);
      return reply.code(204).send();
    },
  );

  // Folhas de salario
  app.get('/folhas/resumo', async (req: FastifyRequest) => {
    const q = z
      .object({
        trabalhadorId: z.string().uuid(),
        periodoInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        periodoFim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(req.query);
    return resumirFolha(app.db, req.tenantId!, q.trabalhadorId, q.periodoInicio, q.periodoFim);
  });

  app.post(
    '/folhas',
    { preHandler: [app.exigir('folhas:gerar')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaFolha.parse(req.body);
      const folha = await gerarFolha(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send(folha);
    },
  );

  app.post(
    '/folhas/:id/lancar',
    { preHandler: [app.exigir('folhas:gerar')] },
    async (req: FastifyRequest) => {
      return lancarFolha(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req));
    },
  );

  app.post(
    '/folhas/:id/anular',
    { preHandler: [app.exigir('folhas:gerar')] },
    async (req: FastifyRequest) => {
      const { motivo } = z.object({ motivo: z.string().min(1) }).parse(req.body);
      return anularFolha(app.db, req.tenantId!, (req.params as { id: string }).id, motivo, ctxReq(req));
    },
  );

  app.get('/folhas', async (req: FastifyRequest) => {
    const q = z
      .object({
        trabalhadorId: z.string().uuid().optional(),
        estado: z.enum(['gerada', 'lancada', 'paga', 'anulada']).optional(),
      })
      .parse(req.query);
    return listarFolhas(app.db, req.tenantId!, q);
  });

  app.get('/folhas/ponto', async (req: FastifyRequest) => {
    const q = z
      .object({
        obraId: z.string().uuid().optional(),
        de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(req.query);
    return folhaDePonto(app.db, req.tenantId!, q);
  });
}
