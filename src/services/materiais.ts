import { and, count, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { materiais } from '../db/schema.js';
import { ErroConflito, ErroNaoEncontrado, ErroValidacao } from '../lib/erros.js';
import { arred2, arred3, paraNum } from '../lib/money.js';
import { metaPagina, normalizarNome, type Pagina } from '../lib/validadores.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';

export const schemaMaterial = z.object({
  nome: z.string().min(2, 'O nome do material e obrigatorio').max(160),
  unidade: z.string().min(1, 'A unidade e obrigatoria').max(24),
  categoria: z.string().max(80).nullable().optional(),
  stockMinimo: z.coerce.number().min(0).default(0),
  precoRef: z.coerce.number().min(0).nullable().optional(),
});

export const schemaListarMateriais = z.object({
  texto: z.string().max(120).optional(),
  categoria: z.string().max(80).optional(),
  apenasAbaixoMinimo: z.coerce.boolean().default(false),
  incluirApagados: z.coerce.boolean().default(false),
});

/* -------------------------------------------------------------------------
   Leituras — SQL directo
   -------------------------------------------------------------------------
   Os saldos vivem em `v_stock_actual` e `v_custo_medio`. Consultar a vista
   directamente evita recriar a aritmetica dos movimentos em TypeScript (onde
   um erro de arredondamento passaria despercebido) e deixa o indice do
   PostgreSQL fazer o trabalho.
   ------------------------------------------------------------------------- */

/** Materiais com saldo total, por tenant. */
async function materiaisComSaldo(
  db: Database,
  tenantId: string,
  filtros: z.infer<typeof schemaListarMateriais>,
) {
  const res = await db.execute<{
    id: string;
    nome: string;
    unidade: string;
    categoria: string | null;
    stock_minimo: string;
    preco_ref: string | null;
    saldo: string;
  }>(sql`
    SELECT m.id, m.nome, m.unidade, m.categoria, m.stock_minimo, m.preco_ref,
           coalesce(v.saldo, 0) AS saldo
      FROM materiais m
      LEFT JOIN (
        SELECT material_id, sum(saldo) AS saldo
          FROM v_stock_actual
         WHERE tenant_id = ${tenantId}
         GROUP BY material_id
      ) v ON v.material_id = m.id
     WHERE m.tenant_id = ${tenantId}
       AND (${filtros.incluirApagados} OR m.deleted_at IS NULL)
       AND (${filtros.categoria ?? null}::text IS NULL OR m.categoria = ${filtros.categoria ?? null})
       AND (${filtros.texto ? `%${normalizarNome(filtros.texto)}%` : null}::text IS NULL
            OR m.nome ILIKE ${filtros.texto ? `%${normalizarNome(filtros.texto)}%` : null})
     ORDER BY m.nome
     LIMIT 1000`);

  return (res.rows ?? []).map((r) => ({
    id: r.id,
    nome: r.nome,
    unidade: r.unidade,
    categoria: r.categoria,
    stockMinimo: arred3(paraNum(r.stock_minimo)),
    precoRef: r.preco_ref != null ? arred2(paraNum(r.preco_ref)) : null,
    saldo: arred3(paraNum(r.saldo)),
    abaixoDoMinimo: paraNum(r.saldo) < paraNum(r.stock_minimo),
    valorEstimado: arred2(paraNum(r.saldo) * paraNum(r.preco_ref)),
  }));
}

export async function listarMateriais(
  db: Database,
  tenantId: string,
  filtros: z.infer<typeof schemaListarMateriais>,
  pagina: Pagina,
) {
  const todos = await materiaisComSaldo(db, tenantId, filtros);
  const filtrados = filtros.apenasAbaixoMinimo ? todos.filter((m) => m.abaixoDoMinimo) : todos;

  const inicio = (pagina.pagina - 1) * pagina.porPagina;
  return {
    dados: filtrados.slice(inicio, inicio + pagina.porPagina),
    meta: metaPagina(pagina, filtrados.length),
  };
}

/** Saldo de um material numa obra. Fonte de verdade: livro-razão de movimentos. */
export async function saldo(
  db: Database,
  tenantId: string,
  obraId: string,
  materialId: string,
): Promise<number> {
  const res = await db.execute<{ saldo: string }>(
    sql`SELECT coalesce(saldo, 0) AS saldo
          FROM v_stock_actual
         WHERE tenant_id = ${tenantId} AND obra_id = ${obraId} AND material_id = ${materialId}`,
  );
  return arred3(paraNum(res.rows?.[0]?.saldo));
}

/** Saldo de um material em todas as obras. */
export async function saldosPorObra(db: Database, tenantId: string, materialId: string) {
  const res = await db.execute<{
    obra_id: string;
    obra_nome: string;
    obra_codigo: string;
    saldo: string;
  }>(
    sql`SELECT v.obra_id, o.nome AS obra_nome, o.codigo AS obra_codigo, v.saldo
          FROM v_stock_actual v
          JOIN obras o ON o.id = v.obra_id
         WHERE v.tenant_id = ${tenantId} AND v.material_id = ${materialId}
         ORDER BY o.nome`,
  );

  return (res.rows ?? []).map((r) => ({
    obraId: r.obra_id,
    obraNome: r.obra_nome,
    obraCodigo: r.obra_codigo,
    saldo: arred3(paraNum(r.saldo)),
  }));
}

/** Materiais abaixo do minimo — o alerta que o encarregado ve no campo. */
export async function alertasStock(db: Database, tenantId: string, obraId?: string) {
  const cond = obraId ? sql`AND v.obra_id = ${obraId}` : sql``;

  const res = await db.execute<{
    material_id: string;
    nome: string;
    unidade: string;
    stock_minimo: string;
    preco_ref: string | null;
    obra_id: string | null;
    obra_nome: string | null;
    saldo: string;
  }>(
    sql`SELECT m.id AS material_id, m.nome, m.unidade, m.stock_minimo, m.preco_ref,
               v.obra_id, o.nome AS obra_nome, coalesce(v.saldo, 0) AS saldo
          FROM materiais m
          LEFT JOIN (
            SELECT obra_id, material_id, sum(saldo) AS saldo
              FROM v_stock_actual
             WHERE tenant_id = ${tenantId}
             GROUP BY obra_id, material_id
          ) v ON v.material_id = m.id
          LEFT JOIN obras o ON o.id = v.obra_id
         WHERE m.tenant_id = ${tenantId}
           AND m.deleted_at IS NULL
           AND ${materiais.stockMinimo} > 0
           ${cond}`,
  );

  return (res.rows ?? [])
    .map((r) => ({
      materialId: r.material_id,
      material: r.nome,
      unidade: r.unidade,
      obraId: r.obra_id,
      obraNome: r.obra_nome,
      stockMinimo: arred3(paraNum(r.stock_minimo)),
      saldo: arred3(paraNum(r.saldo)),
      falta: arred3(Math.max(0, paraNum(r.stock_minimo) - paraNum(r.saldo))),
      custoRepor: arred2(
        Math.max(0, paraNum(r.stock_minimo) - paraNum(r.saldo)) * paraNum(r.preco_ref),
      ),
    }))
    .filter((r) => r.falta > 0)
    .sort((a, b) => b.custoRepor - a.custoRepor);
}

/** Stock valorizado: saldo x custo medio ponderado das entradas. */
export async function stockValorizado(db: Database, tenantId: string, obraId?: string) {
  const cond = obraId ? sql`AND v.obra_id = ${obraId}` : sql``;

  const res = await db.execute<{
    material_id: string;
    nome: string;
    unidade: string;
    obra_id: string;
    obra_nome: string;
    saldo: string;
    custo_medio: string | null;
  }>(
    sql`SELECT v.material_id, m.nome, m.unidade, v.obra_id, o.nome AS obra_nome,
               v.saldo, cm.custo_medio
          FROM v_stock_actual v
          JOIN materiais m ON m.id = v.material_id
          JOIN obras o ON o.id = v.obra_id
          LEFT JOIN v_custo_medio cm ON cm.material_id = v.material_id
                                      AND cm.tenant_id = v.tenant_id
         WHERE v.tenant_id = ${tenantId} AND v.saldo <> 0
         ${cond}`,
  );

  return (res.rows ?? [])
    .map((r) => {
      const cm = r.custo_medio != null ? arred2(paraNum(r.custo_medio)) : null;
      const saldoNum = arred3(paraNum(r.saldo));
      return {
        materialId: r.material_id,
        material: r.nome,
        unidade: r.unidade,
        obraId: r.obra_id,
        obraNome: r.obra_nome,
        saldo: saldoNum,
        custoMedio: cm,
        valor: cm != null ? arred2(saldoNum * cm) : null,
      };
    })
    .sort((a, b) => (b.valor ?? 0) - (a.valor ?? 0));
}

/**
 * Extrato do material na obra, com o saldo acumulado depois de cada movimento.
 * A soma e feita em SQL com funcao de janela porque depende da ordem.
 */
export async function extratoMaterial(
  db: Database,
  tenantId: string,
  materialId: string,
  obraId: string,
  limite = 200,
) {
  const res = await db.execute<{
    id: string;
    tipo: string;
    quantidade: string;
    preco_unitario: string | null;
    data: Date;
    observacoes: string | null;
    saldo_apos: string;
  }>(
    sql`SELECT m.id, m.tipo, m.quantidade, m.preco_unitario, m.data, m.observacoes,
               sum(
                 CASE WHEN m.tipo IN ('entrada','ajuste') THEN m.quantidade
                      WHEN m.tipo = 'saida' THEN -m.quantidade
                      ELSE 0 END
               ) OVER (ORDER BY m.data, m.id) AS saldo_apos
          FROM stock_movimentos m
         WHERE m.tenant_id = ${tenantId}
           AND m.obra_id = ${obraId}
           AND m.material_id = ${materialId}
           AND m.deleted_at IS NULL
         ORDER BY m.data, m.id
         LIMIT ${limite}`,
  );

  return (res.rows ?? []).map((r) => ({
    id: r.id,
    tipo: r.tipo,
    quantidade: arred3(paraNum(r.quantidade)),
    precoUnitario: r.preco_unitario != null ? arred2(paraNum(r.preco_unitario)) : null,
    data: (r.data as Date).toISOString(),
    observacoes: r.observacoes,
    saldoApos: arred3(paraNum(r.saldo_apos)),
  }));
}

/* -------------------------------------------------------------------------
   Escrita
   ------------------------------------------------------------------------- */

export async function obterMaterial(db: Database, tenantId: string, id: string) {
  const [m] = await db
    .select()
    .from(materiais)
    .where(
      and(eq(materiais.id, id), eq(materiais.tenantId, tenantId), isNull(materiais.deletedAt)),
    )
    .limit(1);
  if (!m) throw new ErroNaoEncontrado('Material', id);
  return m;
}

export async function criarMaterial(
  db: Database,
  tenantId: string,
  entrada: z.infer<typeof schemaMaterial>,
  ctx: Contexto,
) {
  const nome = normalizarNome(entrada.nome);

  const dup = await db
    .select({ id: materiais.id })
    .from(materiais)
    .where(and(eq(materiais.tenantId, tenantId), eq(materiais.nome, nome)))
    .limit(1);
  if (dup.length) throw new ErroConflito(`Ja existe um material chamado "${nome}"`);

  const [material] = await db
    .insert(materiais)
    .values({
      tenantId,
      nome,
      unidade: entrada.unidade.trim(),
      categoria: entrada.categoria ?? null,
      stockMinimo: arred3(entrada.stockMinimo).toFixed(3),
      precoRef: entrada.precoRef != null ? arred2(entrada.precoRef).toFixed(2) : null,
    })
    .returning();

  if (!material) throw new ErroValidacao('Falha ao criar o material');

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'material.criado',
    entidade: 'material',
    entidadeId: material.id,
    dadosDepois: { nome, unidade: material.unidade, precoRef: material.precoRef },
    ip: ctx.ip,
  });

  return material;
}

export async function actualizarMaterial(
  db: Database,
  tenantId: string,
  id: string,
  campos: Partial<z.infer<typeof schemaMaterial>>,
  ctx: Contexto,
) {
  const antes = await obterMaterial(db, tenantId, id);

  const nome = campos.nome ? normalizarNome(campos.nome) : undefined;
  if (nome && nome !== antes.nome) {
    const dup = await db
      .select({ id: materiais.id })
      .from(materiais)
      .where(and(eq(materiais.tenantId, tenantId), eq(materiais.nome, nome)))
      .limit(1);
    if (dup.length) throw new ErroConflito(`Ja existe um material chamado "${nome}"`);
  }

  const [depois] = await db
    .update(materiais)
    .set({
      ...(nome ? { nome } : {}),
      ...(campos.unidade !== undefined ? { unidade: campos.unidade.trim() } : {}),
      ...(campos.categoria !== undefined ? { categoria: campos.categoria } : {}),
      ...(campos.stockMinimo !== undefined
        ? { stockMinimo: arred3(campos.stockMinimo).toFixed(3) }
        : {}),
      ...(campos.precoRef !== undefined
        ? { precoRef: campos.precoRef != null ? arred2(campos.precoRef).toFixed(2) : null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(materiais.id, id))
    .returning();

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'material.actualizado',
    entidade: 'material',
    entidadeId: id,
    dadosAntes: { nome: antes.nome, precoRef: antes.precoRef, stockMinimo: antes.stockMinimo },
    dadosDepois: {
      nome: depois?.nome,
      precoRef: depois?.precoRef,
      stockMinimo: depois?.stockMinimo,
    },
    ip: ctx.ip,
  });

  return depois;
}

/**
 * Apagar so e permitido sem movimentos. Com historico de stock o caminho e
 * desactivar o material (quando deixa de se usar), preservando os movimentos.
 */
export async function apagarMaterial(db: Database, tenantId: string, id: string, ctx: Contexto) {
  const material = await obterMaterial(db, tenantId, id);

  const [movimentos] = await db
    .select({ n: count() })
    .from(sql`stock_movimentos`)
    .where(and(sql`material_id = ${id}`, sql`deleted_at is null`));

  if (Number(movimentos?.n ?? 0) > 0) {
    throw new ErroConflito(
      `O material tem ${movimentos?.n} movimento(s) de stock registados e nao pode ser apagado.`,
    );
  }

  await db
    .update(materiais)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(materiais.id, id));

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'material.apagado',
    entidade: 'material',
    entidadeId: id,
    dadosAntes: { nome: material.nome, unidade: material.unidade },
    ip: ctx.ip,
  });

  return { ok: true };
}