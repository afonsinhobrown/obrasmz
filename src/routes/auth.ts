import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  actualizarTenant,
  actualizarUtilizador,
  criarUtilizador,
  desactivarUtilizador,
  entrar,
  listarUtilizadores,
  registarEmpresa,
  renovar,
  resumoTenant,
  sair,
  schemaCriarUtilizador,
  schemaLogin,
  schemaRefresh,
  schemaRegistarEmpresa,
  schemaTenant,
} from '../services/auth.js';
import { ctxReq } from './helpers.js';

export async function rotasAuth(app: FastifyInstance) {
  // Registo de empresa nova (tenant + admin)
  app.post('/registar', async (req, reply) => {
    const dados = schemaRegistarEmpresa.parse(req.body);
    const res = await registarEmpresa(app.db, dados, req.ip);
    return reply.code(201).send(res);
  });

  // Login por email ou telefone
  app.post('/login', async (req, reply) => {
    const dados = schemaLogin.parse(req.body);
    const { tokens } = await entrar(app.db, dados, req.ip);
    return reply.code(200).send(tokens);
  });

  // Renovar access token com rotacao do refresh token
  app.post('/refresh', async (req, reply) => {
    const dados = schemaRefresh.parse(req.body);
    return renovar(app.db, dados.refreshToken);
  });

  // Logout: revoga o refresh token da sessao
  app.post('/logout', async (req) => {
    const dados = z.object({ refreshToken: z.string().min(10).optional() }).parse(req.body ?? {});
    if (dados.refreshToken) await sair(app.db, dados.refreshToken);
    return { mensagem: 'Sessao terminada' };
  });

  // Perfil do utilizador autenticado
  app.get('/eu', { preHandler: [app.autenticar] }, async (req: FastifyRequest) => {
    return req.auth;
  });

  // Alterar a propria senha (invalida sessoes abertas, como implementado no servico)
  app.post(
    '/eu/senha',
    { preHandler: [app.autenticar] },
    async (req: FastifyRequest) => {
      const { senha } = z
        .object({
          senha: z
            .string()
            .min(8, 'A senha deve ter pelo menos 8 caracteres')
            .max(200)
            .regex(/[a-zA-Z]/, 'A senha deve ter pelo menos uma letra')
            .regex(/\d/, 'A senha deve ter pelo menos um numero'),
        })
        .parse(req.body);
      return actualizarUtilizador(
        app.db,
        req.tenantId!,
        req.utilizadorId!,
        { senha },
        ctxReq(req),
      );
    },
  );
}

export async function rotasUtilizadores(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.get(
    '/',
    { preHandler: [app.exigir('utilizadores:ler')] },
    async (req: FastifyRequest) => {
      return listarUtilizadores(app.db, req.tenantId!);
    },
  );

  app.post(
    '/',
    { preHandler: [app.exigir('utilizadores:escrever')] },
    async (req: FastifyRequest, reply) => {
      const dados = schemaCriarUtilizador.parse(req.body);
      const id = await criarUtilizador(app.db, req.tenantId!, dados, ctxReq(req));
      return reply.code(201).send({ id });
    },
  );

  app.patch(
    '/:id',
    { preHandler: [app.exigir('utilizadores:escrever')] },
    async (req: FastifyRequest) => {
      const campos = schemaCriarUtilizador.partial().parse(req.body);
      return actualizarUtilizador(app.db, req.tenantId!, (req.params as { id: string }).id, campos, ctxReq(req));
    },
  );

  app.delete(
    '/:id',
    { preHandler: [app.exigir('utilizadores:escrever')] },
    async (req: FastifyRequest, reply) => {
      await desactivarUtilizador(app.db, req.tenantId!, (req.params as { id: string }).id, ctxReq(req));
      return reply.code(204).send();
    },
  );

  // Configuracao da empresa
  app.get('/empresa', async (req: FastifyRequest) => {
    return resumoTenant(app.db, req.tenantId!);
  });

  app.patch(
    '/empresa',
    { preHandler: [app.exigir('tenant:configurar')] },
    async (req: FastifyRequest) => {
      const dados = schemaTenant.parse(req.body);
      return actualizarTenant(app.db, req.tenantId!, dados, ctxReq(req));
    },
  );
}
