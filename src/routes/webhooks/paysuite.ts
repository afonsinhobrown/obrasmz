import type { FastifyInstance, FastifyRequest } from 'fastify';
import { processarWebhook, verificarAssinatura } from '../../services/paysuite.js';

/**
 * Webhook da PaySuite. E publico (o gateway chama sem JWT), por isso
 * a autenticacao e feita pela assinatura HMAC-SHA256 no header
 * `X-Signature`, calculada sobre o corpo bruto do pedido.
 *
 * O parser de `application/json` e substituido neste escopo para
 * preservar o corpo bruto — sem ele, seria impossivel verificar a
 * assinatura (o parser padrao so devolve o objeto ja interpretado).
 */
export async function rotasWebhookPaySuite(app: FastifyInstance) {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, corpo, done) => {
      const corpoStr = corpo as string;
      (req as unknown as { rawBody?: string }).rawBody = corpoStr;
      try {
        done(null, corpoStr ? JSON.parse(corpoStr) : {});
      } catch (erro) {
        const e = erro as Error & { statusCode?: number };
        e.statusCode = 400;
        done(e);
      }
    },
  );

  app.post('/webhooks/paysuite', async (req: FastifyRequest, reply) => {
    const assinatura = req.headers['x-signature'] as string | undefined;
    const corpoBruto = (req as unknown as { rawBody?: string }).rawBody;

    if (!corpoBruto || !verificarAssinatura(corpoBruto, assinatura)) {
      return reply
        .code(401)
        .send({ erro: 'Assinatura do webhook invalida' });
    }

    const body = req.body as { event?: string; data?: Record<string, unknown> };
    const evento = body?.event;
    const dados = body?.data ?? {};

    if (!evento) {
      return reply.code(400).send({ erro: 'Evento invalido' });
    }

    // PaySuite reenvia o evento ate 5 vezes: o processamento e
    // idempotente, por isso e seguro reconhecer de imediato.
    const resultado = await processarWebhook(app.db, evento, dados);
    return { recebido: true, ...resultado };
  });
}
