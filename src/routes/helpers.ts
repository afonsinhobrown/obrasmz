import type { FastifyRequest } from 'fastify';
import type { Contexto } from '../services/auth.js';

/**
 * Monta o `Contexto` para os servicos a partir do pedido autenticado.
 *
 * Nao se pode construir inline em cada rota sem risco de esquecer um campo: o
 * `auditoria` escreve `ip` e `utilizadorId` no registo, e o sync precisa de
 * saber de quem a alteracao veio. Um helper so, com testes, resolve.
 */
export function ctxReq(req: FastifyRequest): Contexto {
  return {
    tenantId: req.tenantId!,
    utilizadorId: req.utilizadorId!,
    nome: req.auth!.nome,
    email: req.auth!.email,
    papel: req.papel!,
    dispositivoId: null,
    ip: req.ip,
  };
}
