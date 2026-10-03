import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Database } from '../db/client.js';
import { dispositivos, obras, sessoes, tenants, utilizadores } from '../db/schema.js';
import { unico } from '../db/tx.js';
import { hojeISO } from '../lib/datas.js';
import { ErroConflito, ErroNaoAutenticado, ErroNaoEncontrado, ErroValidacao } from '../lib/erros.js';
import { normalizarEmail, normalizarNome, normalizarTelefone } from '../lib/validadores.js';
import { ErroLimitePlano } from '../lib/erros.js';
import { auditar } from './auditoria.js';

export const schemaRegistarEmpresa = z.object({
  empresa: z.string().min(2).max(160),
  nuit: z.string().min(4).max(32).optional(),
  nome: z.string().min(2).max(120),
  email: z.string().email('Email invalido'),
  telefone: z.string().min(8).max(20).optional(),
  senha: z
    .string()
    .min(8, 'A senha deve ter pelo menos 8 caracteres')
    .max(200)
    .regex(/[a-zA-Z]/, 'A senha deve ter pelo menos uma letra')
    .regex(/\d/, 'A senha deve ter pelo menos um numero'),
  moedaBase: z.string().length(3).default(config.dominio.moedaBase),
});

export const schemaLogin = z.object({
  // Identificador: email OU telefone. O campo chama-se `identificador` para
  // reflectir isso e nao obrigar o utilizador a lembrar de onde faz login.
  identificador: z.string().min(3).max(160),
  senha: z.string().min(1).max(200),
  dispositivo: z
    .object({
      nome: z.string().min(1).max(120).default('desconhecido'),
      plataforma: z.string().max(40).optional(),
    })
    .optional(),
});

export const schemaRefresh = z.object({
  refreshToken: z.string().min(10),
});

export type TokenAcesso = { accessToken: string; expiraEm: string; tokenType: 'Bearer' };
export type ParTokens = {
  accessToken: TokenAcesso;
  refreshToken: string;
  expiraEm: string;
};

export type Contexto = {
  tenantId: string;
  utilizadorId: string;
  nome: string;
  email: string | null;
  papel: string;
  dispositivoId?: string | null;
  ip?: string | null;
};

async function hashearSenha(senha: string): Promise<string> {
  return bcrypt.hash(senha, config.auth.bcryptRounds);
}

/** O token viaja em claro; em base de dados guardamos so o SHA-256. */
function hashRefresh(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseTtl(ttl: string): Date {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) return new Date(Date.now() + 30 * 86_400_000);
  const n = Number(m[1]);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd']!;
  return new Date(Date.now() + n * mult);
}

/**
 * Onboarding: cria empresa + administrador na mesma transacao. Se algum falhar,
 * nao fica metade da empresa registada.
 */
export async function registarEmpresa(
  db: Database,
  entrada: z.infer<typeof schemaRegistarEmpresa>,
  ip?: string | null,
): Promise<{ tenantId: string; utilizadorId: string }> {
  const email = normalizarEmail(entrada.email);

  const jaExiste = await db
    .select({ id: utilizadores.id })
    .from(utilizadores)
    .where(eq(utilizadores.email, email))
    .limit(1);
  if (jaExiste.length) {
    throw new ErroConflito('Ja existe uma conta com este email');
  }

  const senhaHash = await hashearSenha(entrada.senha);

  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({
        nome: normalizarNome(entrada.empresa),
        nuit: entrada.nuit ?? null,
        moedaBase: entrada.moedaBase.toUpperCase(),
        plano: 'starter',
      })
      .returning({ id: tenants.id });

    if (!tenant) throw new ErroValidacao('Falha ao criar a empresa');

    const [user] = await tx
      .insert(utilizadores)
      .values({
        tenantId: tenant.id,
        nome: normalizarNome(entrada.nome),
        email,
        telefone: entrada.telefone ? normalizarTelefone(entrada.telefone) : null,
        senhaHash,
        papel: 'admin',
      })
      .returning({ id: utilizadores.id });

    if (!user) throw new ErroValidacao('Falha ao criar o administrador');

    await auditar(tx, tenant.id, user.id, {
      accao: 'empresa.registada',
      entidade: 'tenant',
      entidadeId: tenant.id,
      dadosDepois: { nome: entrada.empresa, nuit: entrada.nuit ?? null },
      ip,
    });

    return { tenantId: tenant.id, utilizadorId: user.id };
  });
}

/**
 * Localiza a conta. Um email so pode pertencer a um tenant; o telefone e
 * unico por tenant, portanto procuramos pelo par (telefone normalizado) e
 * aceitamos o tenant correspondente.
 */
async function localizarConta(db: Database, identificador: string) {
  const email = identificador.includes('@') ? normalizarEmail(identificador) : null;
  const telefone = email ? null : normalizarTelefone(identificador);

  const linha = await db
    .select({
      id: utilizadores.id,
      tenantId: utilizadores.tenantId,
      nome: utilizadores.nome,
      email: utilizadores.email,
      telefone: utilizadores.telefone,
      senhaHash: utilizadores.senhaHash,
      papel: utilizadores.papel,
      activo: utilizadores.activo,
      tenantActivo: tenants.activo,
      tenantNome: tenants.nome,
      moedaBase: tenants.moedaBase,
    })
    .from(utilizadores)
    .innerJoin(tenants, eq(tenants.id, utilizadores.tenantId))
    .where(
      and(
        isNull(utilizadores.deletedAt),
        email ? eq(utilizadores.email, email) : eq(utilizadores.telefone, telefone!),
      ),
    )
    .limit(1);

  return linha[0] ?? null;
}

export async function entrar(
  db: Database,
  entrada: z.infer<typeof schemaLogin>,
  ip?: string | null,
): Promise<{ tokens: ParTokens; ctx: Contexto }> {
  const conta = await localizarConta(db, entrada.identificador.trim());

  // Compara sempre, mesmo sem conta, para nao vazar por tempo de resposta quem
  // existe no sistema.
  const hashFicticio = '$2a$10$abcdefghijklmnopqrstuv0123456789012345678901234567890';
  const compare = conta
    ? await bcrypt.compare(entrada.senha, conta.senhaHash)
    : (await bcrypt.compare(entrada.senha, hashFicticio), false);

  if (!conta || !compare) {
    throw new ErroNaoAutenticado('Email/telefone ou senha incorrectos');
  }
  if (!conta.activo) {
    throw new ErroNaoAutenticado('Conta desactivada. Fale com o administrador da empresa.');
  }
  if (!conta.tenantActivo) {
    throw new ErroNaoAutenticado('Empresa desactivada');
  }

  const dispositivoId = await garantirDispositivo(db, {
    tenantId: conta.tenantId,
    utilizadorId: conta.id,
    nome: entrada.dispositivo?.nome ?? 'desconhecido',
    plataforma: entrada.dispositivo?.plataforma ?? null,
  });

  await db
    .update(utilizadores)
    .set({ ultimoAcessoEm: new Date() })
    .where(eq(utilizadores.id, conta.id));

  const ctx: Contexto = {
    tenantId: conta.tenantId,
    utilizadorId: conta.id,
    nome: conta.nome,
    email: conta.email,
    papel: conta.papel,
    dispositivoId,
    ip,
  };

  return { tokens: await emitirTokens(db, ctx), ctx };
}

/** Refresh com rotacao: o token usado e revogado e nasce outro. */
export async function renovar(db: Database, refreshToken: string): Promise<ParTokens> {
  const hash = hashRefresh(refreshToken);

  const [sessao] = await db
    .select()
    .from(sessoes)
    .where(eq(sessoes.refreshHash, hash))
    .limit(1);

  if (!sessao) throw new ErroNaoAutenticado('Sessao invalida');
  if (sessao.revogadaEm) {
    // Reuso de um token ja revogado: pode ser roubo. Revoga a familia toda.
    await db
      .update(sessoes)
      .set({ revogadaEm: new Date() })
      .where(
        and(
          eq(sessoes.utilizadorId, sessao.utilizadorId),
          sessao.dispositivoId
            ? eq(sessoes.dispositivoId, sessao.dispositivoId)
            : isNull(sessoes.dispositivoId),
        ),
      );
    throw new ErroNaoAutenticado('Sessao revogada');
  }
  if (sessao.expiraEm < new Date()) {
    throw new ErroNaoAutenticado('Sessao expirada. Entre novamente.');
  }

  const conta = await localizarContaPorId(db, sessao.utilizadorId);
  if (!conta || !conta.activo || !conta.tenantActivo) {
    throw new ErroNaoAutenticado('Conta ou empresa desactivada');
  }

  const ctx: Contexto = {
    tenantId: conta.tenantId,
    utilizadorId: conta.id,
    nome: conta.nome,
    email: conta.email,
    papel: conta.papel,
    dispositivoId: sessao.dispositivoId,
  };

  const tokens = await emitirTokens(db, ctx, sessao.id);

  await db.update(sessoes).set({ revogadaEm: new Date() }).where(eq(sessoes.id, sessao.id));

  return tokens;
}

async function localizarContaPorId(db: Database, id: string) {
  const [linha] = await db
    .select({
      id: utilizadores.id,
      tenantId: utilizadores.tenantId,
      nome: utilizadores.nome,
      email: utilizadores.email,
      papel: utilizadores.papel,
      activo: utilizadores.activo,
      tenantActivo: tenants.activo,
    })
    .from(utilizadores)
    .innerJoin(tenants, eq(tenants.id, utilizadores.tenantId))
    .where(and(eq(utilizadores.id, id), isNull(utilizadores.deletedAt)))
    .limit(1);
  return linha ?? null;
}

export async function sair(db: Database, refreshToken?: string, utilizadorId?: string) {
  if (refreshToken) {
    await db
      .update(sessoes)
      .set({ revogadaEm: new Date() })
      .where(eq(sessoes.refreshHash, hashRefresh(refreshToken)));
    return;
  }
  if (utilizadorId) {
    await db
      .update(sessoes)
      .set({ revogadaEm: new Date() })
      .where(and(eq(sessoes.utilizadorId, utilizadorId), isNull(sessoes.revogadaEm)));
  }
}

export async function emitirTokens(
  db: Database,
  ctx: Contexto,
  revogarSessao?: string,
): Promise<ParTokens> {
  const accessToken = await jwtAssinar(ctx);
  const refreshToken = `${randomUUID()}.${randomBytes(32).toString('hex')}`;
  const expiraEm = parseTtl(config.auth.refreshTtl);
  const expiraAcesso = parseTtl(config.auth.accessTtl);

  if (revogarSessao) {
    await db.update(sessoes).set({ revogadaEm: new Date() }).where(eq(sessoes.id, revogarSessao));
  }

  await db.insert(sessoes).values({
    tenantId: ctx.tenantId,
    utilizadorId: ctx.utilizadorId,
    refreshHash: hashRefresh(refreshToken),
    dispositivoId: ctx.dispositivoId ?? null,
    expiraEm,
  });

  return {
    accessToken: { accessToken, tokenType: 'Bearer', expiraEm: expiraAcesso.toISOString() },
    refreshToken,
    expiraEm: expiraEm.toISOString(),
  };
}

/**
 * A assinatura do access token fica isolada aqui para que os servicos nunca
 * dependam do `app.jwt` (que so existe no contexto HTTP) — assim o sync e o
 * CLI conseguem emitir tokens igual.
 */
let signFn: ((payload: Record<string, unknown>) => string) | null = null;

export function registarSignJwt(fn: (payload: Record<string, unknown>) => string) {
  signFn = fn;
}

async function jwtAssinar(ctx: Contexto): Promise<string> {
  if (!signFn) throw new ErroValidacao('Emissor de JWT nao registado');
  return signFn({
    sub: ctx.utilizadorId,
    tid: ctx.tenantId,
    papel: ctx.papel,
    nome: ctx.nome,
    email: ctx.email,
  });
}

async function garantirDispositivo(
  db: Database,
  entrada: { tenantId: string; utilizadorId: string; nome: string; plataforma: string | null },
): Promise<string> {
  const existente = await db
    .select({ id: dispositivos.id })
    .from(dispositivos)
    .where(
      and(
        eq(dispositivos.utilizadorId, entrada.utilizadorId),
        eq(dispositivos.nome, entrada.nome),
        entrada.plataforma
          ? eq(dispositivos.plataforma, entrada.plataforma)
          : isNull(dispositivos.plataforma),
      ),
    )
    .limit(1);

  if (existente[0]) return existente[0].id;

  const [novo] = await db
    .insert(dispositivos)
    .values(entrada)
    .returning({ id: dispositivos.id });
  if (!novo) throw new ErroValidacao('Falha ao registar o dispositivo');
  return novo.id;
}

/** Termina sessoes a partir de `agora` (limpeza periodica). */
export async function limparSessoesExpiradas(db: Database): Promise<number> {
  const res = await db
    .delete(sessoes)
    .where(sql`${sessoes.expiraEm} < now() - interval '30 days'`)
    .returning({ id: sessoes.id });
  return res.length;
}

/* -------------------------------------------------------------------------
   Gestao de utilizadores (dentro de um tenant ja existente)
   ------------------------------------------------------------------------- */

export const schemaCriarUtilizador = z.object({
  nome: z.string().min(2).max(120),
  email: z.string().email('Email invalido'),
  telefone: z.string().min(8).max(20).optional(),
  senha: z.string().min(8).max(200),
  papel: z.enum(['admin', 'gestor', 'fiscal', 'encarregado', 'armazem', 'financeiro']),
  activo: z.boolean().default(true),
});

export async function criarUtilizador(
  db: Database,
  tenantId: string,
  entrada: z.infer<typeof schemaCriarUtilizador>,
  ctx: Contexto,
): Promise<string> {
  const email = normalizarEmail(entrada.email);
  const telefone = entrada.telefone ? normalizarTelefone(entrada.telefone) : null;

  const [limite] = await db
    .select({ max: tenants.maxUtilizadores, plano: tenants.plano })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!limite) throw new ErroNaoEncontrado('Empresa', tenantId);

  const { total } = unico(
    await db
      .select({ total: sql<number>`count(*)::int` })
      .from(utilizadores)
      .where(and(eq(utilizadores.tenantId, tenantId), isNull(utilizadores.deletedAt))),
  );

  if (total >= limite.max) {
    throw new ErroLimitePlano('utilizadores', limite.max, limite.plano);
  }

  if (email) {
    const dup = await db
      .select({ id: utilizadores.id })
      .from(utilizadores)
      .where(and(eq(utilizadores.tenantId, tenantId), eq(utilizadores.email, email)))
      .limit(1);
    if (dup.length) throw new ErroConflito('Ja existe um utilizador com este email na empresa');
  }

  const senhaHash = await hashearSenha(entrada.senha);

  return db.transaction(async (tx) => {
    const [u] = await tx
      .insert(utilizadores)
      .values({
        tenantId,
        nome: normalizarNome(entrada.nome),
        email,
        telefone,
        senhaHash,
        papel: entrada.papel,
        activo: entrada.activo,
      })
      .returning({ id: utilizadores.id });
    if (!u) throw new ErroValidacao('Falha ao criar o utilizador');

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'utilizador.criado',
      entidade: 'utilizador',
      entidadeId: u.id,
      dadosDepois: { nome: entrada.nome, email, papel: entrada.papel },
      ip: ctx.ip,
    });

    return u.id;
  });
}

export async function listarUtilizadores(db: Database, tenantId: string) {
  return db
    .select({
      id: utilizadores.id,
      nome: utilizadores.nome,
      email: utilizadores.email,
      telefone: utilizadores.telefone,
      papel: utilizadores.papel,
      activo: utilizadores.activo,
      ultimoAcessoEm: utilizadores.ultimoAcessoEm,
      criadoEm: utilizadores.criadoEm,
    })
    .from(utilizadores)
    .where(and(eq(utilizadores.tenantId, tenantId), isNull(utilizadores.deletedAt)))
    .orderBy(utilizadores.nome);
}

export async function actualizarUtilizador(
  db: Database,
  tenantId: string,
  id: string,
  campos: Partial<z.infer<typeof schemaCriarUtilizador>>,
  ctx: Contexto,
) {
  const [antes] = await db
    .select()
    .from(utilizadores)
    .where(and(eq(utilizadores.id, id), eq(utilizadores.tenantId, tenantId)))
    .limit(1);
  if (!antes) throw new ErroNaoEncontrado('Utilizador', id);

  // Trava de seguranca: a empresa nao pode ficar sem nenhum admin activo,
  // nem o admin pode despromover-se a si proprio e perder o acesso.
  const vaiPerderAdmin =
    antes.papel === 'admin' &&
    (campos.papel !== undefined && campos.papel !== 'admin' || campos.activo === false);

  if (vaiPerderAdmin) {
    const { restantes } = unico(
      await db
        .select({ restantes: sql<number>`count(*)::int` })
        .from(utilizadores)
        .where(
          and(
            eq(utilizadores.tenantId, tenantId),
            eq(utilizadores.papel, 'admin'),
            sql`${utilizadores.activo} = true`,
            isNull(utilizadores.deletedAt),
            sql`${utilizadores.id} <> ${id}`,
          ),
        ),
    );
    if (restantes === 0) {
      throw new ErroConflito(
        'A empresa ficaria sem nenhum administrador activo. Promova outro utilizador primeiro.',
      );
    }
  }

  // A senha e um campo separado: nao entra no `set` com os outros campos, e
  // muda sozinha revoga as sessoes abertas (utilizador trocou a senha).
  const { senha, ...resto } = campos;

  if (senha) {
    await db
      .update(utilizadores)
      .set({ senhaHash: await hashearSenha(senha), updatedAt: new Date() })
      .where(eq(utilizadores.id, id));
    await db
      .update(sessoes)
      .set({ revogadaEm: new Date() })
      .where(and(eq(sessoes.utilizadorId, id), isNull(sessoes.revogadaEm)));
  }

  if (Object.keys(resto).length) {
    await db
      .update(utilizadores)
      .set({
        ...(resto.nome ? { nome: normalizarNome(resto.nome) } : {}),
        ...(resto.email ? { email: normalizarEmail(resto.email) } : {}),
        ...(resto.telefone ? { telefone: normalizarTelefone(resto.telefone) } : {}),
        ...(resto.papel ? { papel: resto.papel } : {}),
        ...(resto.activo !== undefined ? { activo: resto.activo } : {}),
        updatedAt: new Date(),
      })
      .where(eq(utilizadores.id, id));
  }

  // Desactivar ou mudar de papel tambem tem de invalidar as sessoes abertas.
  if (resto.activo === false || (resto.papel && resto.papel !== antes.papel)) {
    await db
      .update(sessoes)
      .set({ revogadaEm: new Date() })
      .where(and(eq(sessoes.utilizadorId, id), isNull(sessoes.revogadaEm)));
  }

  const [depois] = await db.select().from(utilizadores).where(eq(utilizadores.id, id)).limit(1);

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'utilizador.actualizado',
    entidade: 'utilizador',
    entidadeId: id,
    dadosAntes: { nome: antes.nome, email: antes.email, papel: antes.papel, activo: antes.activo },
    dadosDepois: { nome: depois?.nome, email: depois?.email, papel: depois?.papel, activo: depois?.activo },
    ip: ctx.ip,
  });

  return depois;
}

/** Desactiva a conta mas preserva o historico (soft delete). */
export async function desactivarUtilizador(
  db: Database,
  tenantId: string,
  id: string,
  ctx: Contexto,
) {
  if (id === ctx.utilizadorId) {
    throw new ErroConflito('Nao pode desactivar a propria conta');
  }
  return actualizarUtilizador(db, tenantId, id, { activo: false }, ctx);
}

/* -------------------------------------------------------------------------
   Configuracao da empresa
   ------------------------------------------------------------------------- */

export const schemaTenant = z.object({
  nome: z.string().min(2).max(160).optional(),
  nuit: z.string().max(32).nullable().optional(),
  moedaBase: z.string().length(3).optional(),
  logoUrl: z.string().url().nullable().optional(),
});

export async function actualizarTenant(
  db: Database,
  tenantId: string,
  dados: z.infer<typeof schemaTenant>,
  ctx: Contexto,
) {
  const [antes] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!antes) throw new ErroNaoEncontrado('Empresa', tenantId);

  await db
    .update(tenants)
    .set({
      ...(dados.nome ? { nome: normalizarNome(dados.nome) } : {}),
      ...(dados.nuit !== undefined ? { nuit: dados.nuit } : {}),
      ...(dados.moedaBase ? { moedaBase: dados.moedaBase.toUpperCase() } : {}),
      ...(dados.logoUrl !== undefined ? { logoUrl: dados.logoUrl } : {}),
    })
    .where(eq(tenants.id, tenantId));

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'empresa.actualizada',
    entidade: 'tenant',
    entidadeId: tenantId,
    dadosAntes: { nome: antes.nome, nuit: antes.nuit, moedaBase: antes.moedaBase },
    dadosDepois: dados,
    ip: ctx.ip,
  });

  const [depois] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return depois;
}

export async function resumoTenant(db: Database, tenantId: string) {
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!t) throw new ErroNaoEncontrado('Empresa', tenantId);

  const { obras: nObras } = unico(
    await db
      .select({ obras: sql<number>`count(*)::int` })
      .from(obras)
      .where(and(eq(obras.tenantId, tenantId), isNull(obras.deletedAt))),
  );

  const { utilizadores: nUtilizadores } = unico(
    await db
      .select({ utilizadores: sql<number>`count(*)::int` })
      .from(utilizadores)
      .where(and(eq(utilizadores.tenantId, tenantId), isNull(utilizadores.deletedAt))),
  );

  return { ...t, obras: nObras, utilizadores: nUtilizadores, hoje: hojeISO() };
}