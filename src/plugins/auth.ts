import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { tenants, utilizadores } from '../db/schema.js';
import { ErroNaoAutenticado, ErroSemPermissao } from '../lib/erros.js';
import { permissoesDoPapel, type Permissao } from '../lib/rbac.js';
import { registarSignJwt } from '../services/auth.js';

export type Papel = 'admin' | 'gestor' | 'fiscal' | 'encarregado' | 'armazem' | 'financeiro';

export type TokenAccesso = {
  sub: string;
  tid: string;
  papel: Papel;
  nome: string;
  email: string | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Preenchido por `autenticar`. Tenant e utilizador vem sempre daqui. */
    auth?: TokenAccesso;
    tenantId?: string;
    utilizadorId?: string;
    papel?: Papel;
  }
  interface FastifyInstance {
    /** Exige um access token valido e carrega auth/tenantId/utilizadorId. */
    autenticar: (req: FastifyRequest) => Promise<void>;
    /** Exige uma das permissoes indicadas. Usar como `preHandler`. */
    exigir: (...permissoes: Permissao[]) => (req: FastifyRequest) => Promise<void>;
  }
}

/**
 * Um token pode estar assinado correctamente e mesmo assim nao servir: se foi
 * emitido por outra versao da app, por um refresh antigo ou truncado, pode
 * faltar o tenant. Validamos a forma do payload em runtime — nao confiamos
 * apenas na assinatura.
 */
function lerToken(payload: unknown): TokenAccesso {
  if (typeof payload !== 'object' || payload === null) {
    throw new ErroNaoAutenticado('Token invalido');
  }
  const p = payload as Record<string, unknown>;
  const sub = typeof p.sub === 'string' ? p.sub : null;
  const tid = typeof p.tid === 'string' ? p.tid : null;
  if (!sub || !tid) throw new ErroNaoAutenticado('Token incompleto');

  return {
    sub,
    tid,
    papel: p.papel as Papel,
    nome: typeof p.nome === 'string' ? p.nome : '',
    email: typeof p.email === 'string' ? p.email : null,
  };
}

export const pluginAuth = fp(async (app) => {
  await app.register(import('@fastify/jwt'), {
    secret: config.auth.secret,
    sign: { expiresIn: config.auth.accessTtl },
  });

  // Os servicos nao dependem de `app.jwt` (nao existe fora do contexto HTTP,
  // e o sync/CLI precisam de emitir tokens). O plugin da-lhes a assinatura
  // uma vez, no arranque. Sem isto, `entrar` lanca "Emissor de JWT nao
  // registado" sempre.
  registarSignJwt((payload) =>
    app.jwt.sign(payload as Record<string, unknown>, { expiresIn: config.auth.accessTtl }),
  );

  app.decorate('autenticar', async (req: FastifyRequest) => {
    let token: TokenAccesso;
    try {
      token = lerToken(await req.jwtVerify());
    } catch {
      throw new ErroNaoAutenticado();
    }

    // Recarga do estado do utilizador: um token de uma conta desactivada ou de
    // um tenant desactivado tem de deixar de funcionar imediatamente, mesmo
    // que ainda nao tenha expirado.
    const [estado] = await app.db
      .select({
        tenantId: utilizadores.tenantId,
        ativo: utilizadores.activo,
        tenantAtivo: tenants.activo,
        papel: utilizadores.papel,
        nome: utilizadores.nome,
        email: utilizadores.email,
      })
      .from(utilizadores)
      .innerJoin(tenants, eq(tenants.id, utilizadores.tenantId))
      .where(
        and(
          eq(utilizadores.id, token.sub),
          eq(utilizadores.tenantId, token.tid),
          isNull(utilizadores.deletedAt),
        ),
      )
      .limit(1);

    if (!estado) throw new ErroNaoAutenticado('Utilizador nao existe');
    if (!estado.ativo) throw new ErroNaoAutenticado('Conta desactivada');
    if (!estado.tenantAtivo) throw new ErroNaoAutenticado('Empresa desactivada');

    // O papel vem da base, nunca do token: um token emitido antes de uma
    // mudanca de permissoes nao pode continuar a valer com as permissoes antigas.
    req.auth = {
      sub: token.sub,
      tid: estado.tenantId,
      papel: estado.papel as Papel,
      nome: estado.nome,
      email: estado.email,
    };
    req.tenantId = estado.tenantId;
    req.utilizadorId = token.sub;
    req.papel = estado.papel as Papel;
  });

  app.decorate('exigir', (...permissoes: Permissao[]) => {
    return async (req: FastifyRequest) => {
      if (!req.auth) await app.autenticar(req);
      const papel = req.papel;
      if (!papel) throw new ErroNaoAutenticado();

      const concedidas = permissoesDoPapel(papel);
      const ok = permissoes.some((p) => concedidas.includes(p));
      if (!ok) {
        throw new ErroSemPermissao(permissoes.join(' | '));
      }
    };
  });
});