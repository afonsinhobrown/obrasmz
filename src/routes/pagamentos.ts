import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  anularPagamento,
  confirmarPagamento,
  listarPagamentos,
  obterPagamento,
  pagarFolha,
  pagamentosPendentes,
  pagamentosPorObra,
  registarPagamento,
  resumoPagamentos,
  schemaPagamento,
} from '../services/pagamentos.js';
import { ctxReq } from './helpers.js';

export async function rotasPagamentos(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.get(
    '/',
    { preHandler: [app.exigir('pagamentos:ler')] },
    async (req: FastifyRequest) => {
      const filtro = z
        .object({
          obraId: z.string().uuid().optional(),
          beneficiarioTipo: z.enum(['trabalhador', 'subempreiteiro', 'fornecedor', 'outro']).optional(),
          beneficiarioId: z.string().uuid().optional(),
          contratoId: z.string().uuid().optional(),
          metodo: z.enum(['numerario', 'mpesa', 'emola', 'transferencia', 'cheque']).optional(),
          estado: z.enum(['registado', 'confirmado', 'anulado']).optional(),
          de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          limite: z.coerce.number().int().positive().optional(),
        })
        .parse(req.query);
      return listarPagamentos(app.db, req.tenantId!, filtro);
    },
  );

  app.post(
    '/',
    { preHandler: [app.exigir('pagamentos:registar')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaPagamento.parse(req.body);
      const pagamento = await registarPagamento(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send(pagamento);
    },
  );

  app.get('/pendentes', async (req: FastifyRequest) => {
    return pagamentosPendentes(app.db, req.tenantId!);
  });

  app.get('/resumo', async (req: FastifyRequest) => {
    const filtro = z
      .object({
        obraId: z.string().uuid().optional(),
        de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.query);
    return resumoPagamentos(app.db, req.tenantId!, filtro);
  });

  app.get('/por-obra/:obraId', async (req: FastifyRequest) => {
    return pagamentosPorObra(app.db, req.tenantId!, (req.params as { obraId: string }).obraId);
  });

  app.get('/:id', async (req: FastifyRequest) => {
    return obterPagamento(app.db, req.tenantId!, (req.params as { id: string }).id);
  });

  app.post(
    '/:id/confirmar',
    { preHandler: [app.exigir('pagamentos:registar')] },
    async (req: FastifyRequest) => {
      return confirmarPagamento(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req));
    },
  );

  app.post(
    '/:id/anular',
    { preHandler: [app.exigir('pagamentos:anular')] },
    async (req: FastifyRequest) => {
      const { motivo } = z.object({ motivo: z.string().min(1, 'Indique o motivo') }).parse(req.body);
      return anularPagamento(app.db, req.tenantId!, (req.params as { id: string }).id, motivo, ctxReq(req));
    },
  );

  // Pagar uma folha de salario (lancada) cria o pagamento correspondente
  app.post(
    '/folha/:folhaId',
    { preHandler: [app.exigir('pagamentos:registar')] },
    async (req: FastifyRequest, reply) => {
      const dados = z
        .object({
          metodo: z.enum(['numerario', 'mpesa', 'emola', 'transferencia', 'cheque']),
          referencia: z.string().max(120).nullable().default(null),
        })
        .parse(req.body);
      const pagamento = await pagarFolha(
        app.db,
        req.tenantId!,
        (req.params as { folhaId: string }).folhaId,
        dados.metodo,
        dados.referencia,
        ctxReq(req),
      );
      return reply.code(201).send(pagamento);
    },
  );
}
