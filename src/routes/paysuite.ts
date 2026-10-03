import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ctxReq } from './helpers.js';
import {
  consultar,
  criarPaymentRequest,
  criarPayout,
  listarTransacoes,
  STATUS_VALIDOS,
} from '../services/paysuite.js';

const metodosPagamento = ['mpesa', 'emola', 'credit_card'] as const;
const metodosPayout = [
  'mpesa',
  'emola',
  'mkesh',
  'bank',
  'bank_transfer',
] as const;

export async function rotasPaySuite(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  // Receber dinheiro: cria um pedido de pagamento e devolve o checkout_url
  app.post(
    '/pagamentos',
    { preHandler: [app.exigir('pagamentos:registar')] },
    async (req: FastifyRequest, reply) => {
      const dados = z
        .object({
          valor: z.coerce.number().positive('O valor tem de ser positivo'),
          metodo: z.enum(metodosPagamento).optional(),
          referencia: z.string().max(50).optional(),
          descricao: z.string().max(125).optional(),
          returnUrl: z.string().url().optional(),
          webhookUrl: z.string().url().optional(),
          contactId: z.string().optional(),
          pagamentoId: z.string().uuid().optional(),
        })
        .parse(req.body);
      const transacao = await criarPaymentRequest(
        app.db,
        req.tenantId!,
        dados,
        ctxReq(req),
      );
      return reply.code(201).send(transacao);
    },
  );

  // Pagar dinheiro: cria um payout (M-Pesa/e-Mola/banco)
  app.post(
    '/payouts',
    { preHandler: [app.exigir('pagamentos:registar')] },
    async (req: FastifyRequest, reply) => {
      const dados = z
        .object({
          valor: z.coerce.number().positive('O valor tem de ser positivo'),
          metodo: z.enum(metodosPayout),
          referencia: z.string().max(30).optional(),
          descricao: z.string().max(255).optional(),
          telefone: z.string().max(20).optional(),
          titular: z.string().max(100).optional(),
          nib: z.string().max(21).optional(),
          webhookUrl: z.string().url().optional(),
          pagamentoId: z.string().uuid().optional(),
        })
        .superRefine((v, ctx) => {
          if (v.metodo === 'bank' && !v.nib?.trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nib'],
              message: 'Payout bancario precisa do NIB (21 digitos)',
            });
          }
          if (v.metodo !== 'bank' && !v.telefone?.trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['telefone'],
              message: `Payout ${v.metodo} precisa do telefone (9 digitos)`,
            });
          }
        })
        .parse(req.body);
      const transacao = await criarPayout(
        app.db,
        req.tenantId!,
        dados,
        ctxReq(req),
      );
      return reply.code(201).send(transacao);
    },
  );

  // Listar transacoes externas
  app.get('/', async (req: FastifyRequest) => {
      const filtro = z
        .object({
          tipo: z.enum(['payment_request', 'payout', 'refund']).optional(),
          status: z.enum(STATUS_VALIDOS).optional(),
          pagamentoId: z.string().uuid().optional(),
          limite: z.coerce.number().int().positive().max(100).optional(),
        })
        .parse(req.query);
    return listarTransacoes(app.db, req.tenantId!, filtro);
  });

  // Detalhe de uma transacao
  app.get('/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return consultar(app.db, req.tenantId!, id);
  });

  // Consultar o estado ao gateway (refresh)
  app.post('/:id/consultar', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return consultar(app.db, req.tenantId!, id);
  });
}
