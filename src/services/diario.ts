import { and, asc, count, desc, eq, getTableColumns, gte, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import type { Ctx } from '../db/tx.js';
import { diarioFotos, diarioObra, obras, utilizadores } from '../db/schema.js';
import { hojeISO } from '../lib/datas.js';
import { ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../lib/erros.js';
import { arred2, paraNum } from '../lib/money.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';

export const schemaEntrada = z.object({
  obraId: z.string().uuid(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  clima: z.string().max(80).nullable().optional(),
  trabalhos: z.string().min(3, 'Descreva os trabalhos do dia').max(4000),
  ocorrencias: z.string().max(4000).nullable().optional(),
  progressoPct: z.coerce.number().min(0).max(100).nullable().optional(),
  /**
   * Entrada que nao mexe no progresso da obra. Para registar o dia sem
   * tocar nas percentagens — por exemplo uma correcao administrativa.
   */
  semEfeito: z.boolean().default(false),
  clientId: z.string().uuid().nullable().optional(),
});

export const schemaFoto = z.object({
  url: z.string().min(1),
  legenda: z.string().max(300).nullable().optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  tiradaEm: z.string().optional(),
  clientId: z.string().uuid().nullable().optional(),
});

export const schemaListarDiario = z.object({
  obraId: z.string().uuid().optional(),
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  comFotos: z.coerce.boolean().default(false),
});

/**
 * Registar uma entrada de diario.
 *
 * O progresso da obra e monotonicamente nao-decrescente: quem escreve offline
 * pode reenviar entradas antigas e o progresso nao pode recuar por causa
 * disso. Entradas marcadas com `semEfeito` nao entram nesta regra.
 */
export async function registarEntrada(
  db: Database,
  tenantId: string,
  autorId: string,
  entrada: z.infer<typeof schemaEntrada>,
  ctx: Contexto,
) {
  const [obra] = await db
    .select()
    .from(obras)
    .where(and(eq(obras.id, entrada.obraId), eq(obras.tenantId, tenantId), isNull(obras.deletedAt)))
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', entrada.obraId);

  // Duas entradas no mesmo dia, pela mesma pessoa, sao quase sempre duplicado
  // de sincronismo offline. Bloqueamos com mensagem explicita.
  const data = entrada.data ?? hojeISO();
  const [duplicada] = await db
    .select({ id: diarioObra.id, data: diarioObra.data })
    .from(diarioObra)
    .where(
      and(
        eq(diarioObra.obraId, entrada.obraId),
        eq(diarioObra.autorId, autorId),
        eq(diarioObra.data, data),
        isNull(diarioObra.deletedAt),
      ),
    )
    .limit(1);
  if (duplicada) {
    throw new ErroRegraNegocio(
      `Ja existe uma entrada de diario deste utilizador em ${data}. Edite essa entrada em vez de criar outra.`,
      { entradaId: duplicada.id },
    );
  }

  return db.transaction(async (tx) => {
    const [registo] = await tx
      .insert(diarioObra)
      .values({
        tenantId,
        obraId: entrada.obraId,
        autorId,
        data,
        clima: entrada.clima ?? null,
        trabalhos: entrada.trabalhos.trim(),
        ocorrencias: entrada.ocorrencias ?? null,
        progressoPct:
          entrada.progressoPct != null ? arred2(entrada.progressoPct).toFixed(2) : null,
        semEfeito: entrada.semEfeito,
        clientId: entrada.clientId ?? null,
      })
      .returning();

    if (!registo) throw new ErroValidacao('Falha ao registar a entrada de diario');

    let progressoAplicado: number | null = null;
    if (!entrada.semEfeito && entrada.progressoPct != null) {
      progressoAplicado = await aplicarProgresso(tx, obra.id, paraNum(obra.progressoPct), paraNum(entrada.progressoPct));
    }

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'diario.entrada_criada',
      entidade: 'diario_obra',
      entidadeId: registo.id,
      dadosDepois: { obraId: entrada.obraId, data, progresso: entrada.progressoPct },
      ip: ctx.ip,
    });

    return { entrada: registo, progressoAplicado };
  });
}

/**
 * Aplica o progresso respeitando a monotonicidade. Uma obra concluida nao
 * pode voltar a 60% por causa de uma entrada antiga que chegou do offline.
 */
async function aplicarProgresso(
  db: Ctx,
  obraId: string,
  progressoActual: number,
  novo: number,
): Promise<number> {
  if (novo < progressoActual) return progressoActual;
  if (novo >= 100) {
    await db
      .update(obras)
      .set({ progressoPct: '100', estado: 'concluida', updatedAt: new Date() })
      .where(eq(obras.id, obraId));
    return 100;
  }
  await db
    .update(obras)
    .set({ progressoPct: String(arred2(novo)), updatedAt: new Date() })
    .where(eq(obras.id, obraId));
  return arred2(novo);
}

export async function obterEntrada(db: Database, tenantId: string, id: string) {
  const [entrada] = await db
    .select({
      ...getTableColumns(diarioObra),
      autorNome: utilizadores.nome,
      obraNome: obras.nome,
      obraCodigo: obras.codigo,
    })
    .from(diarioObra)
    .innerJoin(utilizadores, eq(utilizadores.id, diarioObra.autorId))
    .innerJoin(obras, eq(obras.id, diarioObra.obraId))
    .where(and(eq(diarioObra.id, id), eq(diarioObra.tenantId, tenantId)))
    .limit(1);
  if (!entrada) throw new ErroNaoEncontrado('Entrada de diario', id);

  const fotos = await db
    .select()
    .from(diarioFotos)
    .where(and(eq(diarioFotos.diarioId, id), isNull(diarioFotos.deletedAt)))
    .orderBy(asc(diarioFotos.tiradaEm));

  return { ...entrada, fotos };
}

export async function listarEntradas(
  db: Database,
  tenantId: string,
  filtro: z.infer<typeof schemaListarDiario>,
  limite = 100,
) {
  const cond = [eq(diarioObra.tenantId, tenantId), isNull(diarioObra.deletedAt)];
  if (filtro.obraId) cond.push(eq(diarioObra.obraId, filtro.obraId));
  if (filtro.de) cond.push(gte(diarioObra.data, filtro.de));
  if (filtro.ate) cond.push(lte(diarioObra.data, filtro.ate));

  const linhas = await db
    .select({
      id: diarioObra.id,
      obraId: diarioObra.obraId,
      obraNome: obras.nome,
      obraCodigo: obras.codigo,
      data: diarioObra.data,
      clima: diarioObra.clima,
      trabalhos: diarioObra.trabalhos,
      ocorrencias: diarioObra.ocorrencias,
      progressoPct: diarioObra.progressoPct,
      semEfeito: diarioObra.semEfeito,
      autorNome: utilizadores.nome,
      nFotos: sql<number>`(SELECT count(*)::int FROM diario_fotos f
                           WHERE f.diario_id = ${diarioObra.id} AND f.deleted_at IS NULL)`,
    })
    .from(diarioObra)
    .innerJoin(obras, eq(obras.id, diarioObra.obraId))
    .innerJoin(utilizadores, eq(utilizadores.id, diarioObra.autorId))
    .where(and(...cond))
    .orderBy(desc(diarioObra.data), desc(diarioObra.id))
    .limit(limite);

  return filtro.comFotos ? linhas.filter((l) => Number(l.nFotos) > 0) : linhas;
}

export async function actualizarEntrada(
  db: Database,
  tenantId: string,
  id: string,
  campos: Partial<z.infer<typeof schemaEntrada>>,
  ctx: Contexto,
) {
  const [antes] = await db
    .select()
    .from(diarioObra)
    .where(and(eq(diarioObra.id, id), eq(diarioObra.tenantId, tenantId)))
    .limit(1);
  if (!antes) throw new ErroNaoEncontrado('Entrada de diario', id);

  const [depois] = await db
    .update(diarioObra)
    .set({
      ...(campos.clima !== undefined ? { clima: campos.clima } : {}),
      ...(campos.trabalhos !== undefined ? { trabalhos: campos.trabalhos.trim() } : {}),
      ...(campos.ocorrencias !== undefined ? { ocorrencias: campos.ocorrencias } : {}),
      ...(campos.semEfeito !== undefined ? { semEfeito: campos.semEfeito } : {}),
      ...(campos.progressoPct !== undefined && campos.progressoPct !== null
        ? { progressoPct: arred2(campos.progressoPct).toFixed(2) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(diarioObra.id, id))
    .returning();

  // Corrigir o progresso de uma entrada pode mexer no progresso da obra — mas so
  // para a frente, pela mesma regra da criacao.
  let progressoAplicado: number | null = null;
  if (
    campos.progressoPct != null &&
    campos.progressoPct !== paraNum(antes.progressoPct) &&
    !antes.semEfeito
  ) {
    const [obra] = await db
      .select({ progressoPct: obras.progressoPct })
      .from(obras)
      .where(eq(obras.id, antes.obraId))
      .limit(1);
    progressoAplicado = await aplicarProgresso(
      db,
      antes.obraId,
      paraNum(obra?.progressoPct),
      paraNum(campos.progressoPct),
    );
  }

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'diario.entrada_actualizada',
    entidade: 'diario_obra',
    entidadeId: id,
    dadosAntes: { trabalhos: antes.trabalhos, progressoPct: antes.progressoPct },
    dadosDepois: { trabalhos: depois?.trabalhos, progressoPct: depois?.progressoPct },
    ip: ctx.ip,
  });

  return { entrada: depois, progressoAplicado };
}

/** Soft delete: a entrada pode estar referenciada em relatorios ja emitidos. */
export async function apagarEntrada(
  db: Database,
  tenantId: string,
  id: string,
  ctx: Contexto,
  motivo?: string,
) {
  const [antes] = await db
    .select()
    .from(diarioObra)
    .where(and(eq(diarioObra.id, id), eq(diarioObra.tenantId, tenantId)))
    .limit(1);
  if (!antes) throw new ErroNaoEncontrado('Entrada de diario', id);

  await db.transaction(async (tx) => {
    await tx
      .update(diarioObra)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(diarioObra.id, id));

    await tx
      .update(diarioFotos)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(diarioFotos.diarioId, id));

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'diario.entrada_apagada',
      entidade: 'diario_obra',
      entidadeId: id,
      dadosAntes: { data: antes.data, trabalhos: antes.trabalhos },
      dadosDepois: { motivo: motivo ?? null },
      ip: ctx.ip,
    });
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------
   Fotos
   ------------------------------------------------------------------------- */

export async function anexarFoto(
  db: Database,
  tenantId: string,
  diarioId: string,
  entrada: z.infer<typeof schemaFoto>,
  ctx: Contexto,
) {
  const [diario] = await db
    .select({ id: diarioObra.id, obraId: diarioObra.obraId })
    .from(diarioObra)
    .where(and(eq(diarioObra.id, diarioId), eq(diarioObra.tenantId, tenantId)))
    .limit(1);
  if (!diario) throw new ErroNaoEncontrado('Entrada de diario', diarioId);

  const [foto] = await db
    .insert(diarioFotos)
    .values({
      tenantId,
      diarioId,
      url: entrada.url,
      legenda: entrada.legenda ?? null,
      latitude: entrada.latitude != null ? String(entrada.latitude) : null,
      longitude: entrada.longitude != null ? String(entrada.longitude) : null,
      tiradaEm: entrada.tiradaEm ? new Date(entrada.tiradaEm) : new Date(),
      clientId: entrada.clientId ?? null,
    })
    .returning();

  if (!foto) throw new ErroValidacao('Falha ao anexar a foto');

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'diario.foto_anexada',
    entidade: 'diario_foto',
    entidadeId: foto.id,
    dadosDepois: { diarioId, url: entrada.url },
    ip: ctx.ip,
  });

  return foto;
}

export async function apagarFoto(db: Database, tenantId: string, id: string, ctx: Contexto) {
  const [foto] = await db
    .select()
    .from(diarioFotos)
    .where(and(eq(diarioFotos.id, id), eq(diarioFotos.tenantId, tenantId)))
    .limit(1);
  if (!foto) throw new ErroNaoEncontrado('Foto', id);

  await db
    .update(diarioFotos)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(diarioFotos.id, id));

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'diario.foto_apagada',
    entidade: 'diario_foto',
    entidadeId: id,
    dadosAntes: { url: foto.url, diarioId: foto.diarioId },
    ip: ctx.ip,
  });

  return { ok: true, url: foto.url };
}

/** Contagem de entradas por obra no periodo — para o dashboard do gestor. */
export async function estatisticasDiario(db: Database, tenantId: string, de?: string, ate?: string) {
  const cond = [eq(diarioObra.tenantId, tenantId), isNull(diarioObra.deletedAt)];
  if (de) cond.push(gte(diarioObra.data, de));
  if (ate) cond.push(lte(diarioObra.data, ate));

  const [r] = await db
    .select({
      entradas: count(),
      nFotos: sql<number>`coalesce(sum((SELECT count(*) FROM diario_fotos f
                                          WHERE f.diario_id = ${diarioObra.id} AND f.deleted_at IS NULL)), 0)::int`,
    })
    .from(diarioObra)
    .where(and(...cond));

  return { entradas: Number(r?.entradas ?? 0), fotos: Number(r?.nFotos ?? 0) };
}