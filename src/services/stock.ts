import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Database } from '../db/client.js';
import type { Ctx } from '../db/tx.js';
import {
  fornecedores,
  materiais,
  obras,
  requisicaoItens,
  requisicoes,
  stockMovimentos,
} from '../db/schema.js';
import { hojeISO } from '../lib/datas.js';
import { ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../lib/erros.js';
import { arred2, arred3, paraNum } from '../lib/money.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';
import { lancarCustoInterno } from './custos.js';

/**
 * `quantidade` e sempre uma MAGNITUDE positiva; o sentido esta no `tipo`.
 *
 * A unica excepcao e `ajuste`, que aceita valor negativo porque e uma
 * correccao de inventario ("faltavam 3, logo -3"). E o que torna a vista
 * `v_stock_actual` correcta — se gravassemos saidas ja negativas e a vista
 * voltasse a subtrair, cada saida contaria duas vezes.
 */
export const schemaMovimento = z
  .object({
    obraId: z.string().uuid(),
    materialId: z.string().uuid(),
    tipo: z.enum(['entrada', 'saida', 'ajuste', 'transferencia']),
    quantidade: z.coerce
      .number()
      .refine((n) => Number.isFinite(n) && n !== 0, 'A quantidade nao pode ser zero'),
    precoUnitario: z.coerce.number().min(0).nullable().optional(),
    fornecedorId: z.string().uuid().nullable().optional(),
    requisicaoId: z.string().uuid().nullable().optional(),
    transferenciaParaObraId: z.string().uuid().nullable().optional(),
    observacoes: z.string().max(500).nullable().optional(),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Entrada com preco: nasce um custo `material` na obra. */
    lancarCusto: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.tipo !== 'ajuste' && v.quantidade < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quantidade'],
        message: `A quantidade de um movimento do tipo "${v.tipo}" e um valor positivo — o sinal e dado pelo tipo. Para corrigir o inventario use tipo "ajuste".`,
      });
    }
    if (v.tipo === 'entrada' && (v.precoUnitario == null || v.precoUnitario < 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['precoUnitario'],
        message: 'Uma entrada com preco e obrigatoria: e dela que nasce o custo do material',
      });
    }
    if (v.tipo === 'transferencia' && !v.transferenciaParaObraId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transferenciaParaObraId'],
        message: 'Indique a obra de destino da transferencia',
      });
    }
    if (v.tipo === 'saida' && v.precoUnitario != null && v.precoUnitario > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['precoUnitario'],
        message:
          'Uma saida nao leva preco: o custo ja foi lancado na entrada. Lancar aqui seria contar duas vezes.',
      });
    }
  });

export type Movimento = z.infer<typeof schemaMovimento>;

async function validarObra(db: Ctx, tenantId: string, obraId: string) {
  const [o] = await db
    .select({ id: obras.id, nome: obras.nome, codigo: obras.codigo, moeda: obras.moeda })
    .from(obras)
    .where(and(eq(obras.id, obraId), eq(obras.tenantId, tenantId), isNull(obras.deletedAt)))
    .limit(1);
  if (!o) throw new ErroNaoEncontrado('Obra', obraId);
  return o;
}

async function validarMaterial(db: Ctx, tenantId: string, materialId: string) {
  const [m] = await db
    .select()
    .from(materiais)
    .where(
      and(eq(materiais.id, materialId), eq(materiais.tenantId, tenantId), isNull(materiais.deletedAt)),
    )
    .limit(1);
  if (!m) throw new ErroNaoEncontrado('Material', materialId);
  return m;
}

async function saldoDe(db: Ctx, obraId: string, materialId: string): Promise<number> {
  const res = await db.execute<{ saldo: string }>(
    sql`SELECT coalesce(saldo, 0) AS saldo
          FROM v_stock_actual
         WHERE obra_id = ${obraId} AND material_id = ${materialId}`,
  );
  return arred3(paraNum(res.rows?.[0]?.saldo));
}

/**
 * Regista um movimento de stock.
 *
 * Regras que este servico garante:
 *  - `entrada` com preco cria um custo `material` ligado ao proprio movimento
 *    (origem_tabela='stock_movimentos'). E dai que nasce o custo real da obra.
 *  - `saida` nunca cria custo: o dinheiro foi gasto na compra (entrada). Se a
 *    saida lever custo, o material seria contado duas vezes.
 *  - `transferencia` grava as DUAS pernas na mesma transacao — uma a sair da
 *    obra de origem (`transferencia_para_obra_id` = destino) e outra a entrar na
 *    de destino. O custo nao muda: o material ja foi pago na origem.
 *  - uma `saida` nunca deixa saldo negativo, salvo se `STOCK_PERMITE_NEGATIVO`.
 *  - `quantidade` e gravada como magnitude positiva; so `ajuste` aceita sinal.
 */
export async function registarMovimento(
  db: Ctx,
  tenantId: string,
  entrada: Movimento,
  ctx: Contexto,
) {
  const obra = await validarObra(db, tenantId, entrada.obraId);
  const material = await validarMaterial(db, tenantId, entrada.materialId);
  const qtd = entrada.tipo === 'ajuste' ? arred3(entrada.quantidade) : arred3(Math.abs(entrada.quantidade));
  const magnitude = Math.abs(qtd);

  return db.transaction(async (tx) => {
    if (entrada.tipo === 'saida' || entrada.tipo === 'transferencia') {
      const disponivel = await saldoDe(tx, entrada.obraId, entrada.materialId);
      if (disponivel - magnitude < 0 && !config.dominio.stockPermiteNegativo) {
        throw new ErroRegraNegocio(
          `Saldo insuficiente de ${material.nome} em ${obra.codigo}: ha ${disponivel} ${material.unidade} ` +
            `e pediu ${magnitude}. Lance primeiro uma entrada, ou registe um ajuste.`,
          { disponivel, pedido: magnitude },
        );
      }
    }

    if (entrada.tipo === 'transferencia' && entrada.transferenciaParaObraId) {
      const destino = await validarObra(tx, tenantId, entrada.transferenciaParaObraId);
      if (destino.id === obra.id) {
        throw new ErroValidacao('A obra de destino tem de ser diferente da obra de origem');
      }

      const data = entrada.data ? new Date(`${entrada.data}T08:00:00Z`) : new Date();

      // Perna que sai da origem. O tipo e `transferencia` (nao `saida`) para que
      // o par seja legivel e o estorno saiba que o par tem de ser refeito.
      const [saida] = await tx
        .insert(stockMovimentos)
        .values({
          tenantId,
          obraId: obra.id,
          materialId: material.id,
          tipo: 'transferencia',
          quantidade: magnitude.toFixed(3),
          requisicaoId: entrada.requisicaoId ?? null,
          utilizadorId: ctx.utilizadorId,
          transferenciaParaObraId: destino.id,
          observacoes: `Transferencia para ${destino.codigo}: ${entrada.observacoes ?? ''}`.trim(),
          data,
        })
        .returning();

      const [rececao] = await tx
        .insert(stockMovimentos)
        .values({
          tenantId,
          obraId: destino.id,
          materialId: material.id,
          tipo: 'entrada',
          quantidade: magnitude.toFixed(3),
          requisicaoId: entrada.requisicaoId ?? null,
          utilizadorId: ctx.utilizadorId,
          observacoes: `Transferencia de ${obra.codigo}: ${entrada.observacoes ?? ''}`.trim(),
          data,
        })
        .returning();

      await auditar(tx, tenantId, ctx.utilizadorId, {
        accao: 'stock.transferencia',
        entidade: 'stock_movimento',
        entidadeId: saida?.id ?? null,
        dadosDepois: { origem: obra.codigo, destino: destino.codigo, quantidade: magnitude },
        ip: ctx.ip,
      });

      return { saida, entrada: rececao, custo: null };
    }

    const [movimento] = await tx
      .insert(stockMovimentos)
      .values({
        tenantId,
        obraId: obra.id,
        materialId: material.id,
        tipo: entrada.tipo,
        quantidade: qtd.toFixed(3),
        precoUnitario: entrada.precoUnitario != null ? arred2(entrada.precoUnitario).toFixed(2) : null,
        fornecedorId: entrada.fornecedorId ?? null,
        requisicaoId: entrada.requisicaoId ?? null,
        utilizadorId: ctx.utilizadorId,
        transferenciaParaObraId: null,
        observacoes: entrada.observacoes ?? null,
        data: entrada.data ? new Date(`${entrada.data}T08:00:00Z`) : new Date(),
      })
      .returning();

    if (!movimento) throw new ErroValidacao('Falha ao registar o movimento');

    // A entrada e a unica origem de custo de material.
    let custo = null;
    if (entrada.tipo === 'entrada' && entrada.lancarCusto && entrada.precoUnitario != null) {
      custo = await lancarCustoInterno(tx, tenantId, {
        obraId: obra.id,
        tipo: 'material',
        descricao: `${material.nome} — compra`,
        valor: arred2(magnitude * entrada.precoUnitario),
        moeda: obra.moeda,
        data: entrada.data ?? hojeISO(),
        origemTabela: 'stock_movimentos',
        origemId: movimento.id,
      });
      custo = custo.custo;
    }

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: `stock.${entrada.tipo}`,
      entidade: 'stock_movimento',
      entidadeId: movimento.id,
      dadosDepois: {
        material: material.nome,
        quantidade: qtd,
        precoUnitario: entrada.precoUnitario ?? null,
        obra: obra.codigo,
      },
      ip: ctx.ip,
    });

    return { movimento, custo };
  });
}

export async function listarMovimentos(
  db: Database,
  tenantId: string,
  filtro: {
    obraId?: string;
    materialId?: string;
    tipo?: 'entrada' | 'saida' | 'ajuste' | 'transferencia';
    de?: string;
    ate?: string;
    limite?: number;
  },
) {
  const cond = [eq(stockMovimentos.tenantId, tenantId), isNull(stockMovimentos.deletedAt)];
  if (filtro.obraId) cond.push(eq(stockMovimentos.obraId, filtro.obraId));
  if (filtro.materialId) cond.push(eq(stockMovimentos.materialId, filtro.materialId));
  if (filtro.tipo) cond.push(eq(stockMovimentos.tipo, filtro.tipo));
  if (filtro.de) cond.push(gte(stockMovimentos.data, new Date(`${filtro.de}T00:00:00Z`)));
  if (filtro.ate) cond.push(lte(stockMovimentos.data, new Date(`${filtro.ate}T23:59:59Z`)));

  return db
    .select({
      id: stockMovimentos.id,
      tipo: stockMovimentos.tipo,
      quantidade: stockMovimentos.quantidade,
      precoUnitario: stockMovimentos.precoUnitario,
      data: stockMovimentos.data,
      observacoes: stockMovimentos.observacoes,
      obraId: stockMovimentos.obraId,
      obraCodigo: obras.codigo,
      obraNome: obras.nome,
      materialId: stockMovimentos.materialId,
      material: materiais.nome,
      unidade: materiais.unidade,
      fornecedor: fornecedores.nome,
      requisicaoId: stockMovimentos.requisicaoId,
      transferenciaParaObraId: stockMovimentos.transferenciaParaObraId,
    })
    .from(stockMovimentos)
    .innerJoin(obras, eq(obras.id, stockMovimentos.obraId))
    .innerJoin(materiais, eq(materiais.id, stockMovimentos.materialId))
    .leftJoin(fornecedores, eq(fornecedores.id, stockMovimentos.fornecedorId))
    .where(and(...cond))
    .orderBy(desc(stockMovimentos.data), desc(stockMovimentos.id))
    .limit(filtro.limite ?? 200);
}

/**
 * Estorna um movimento (criar o movimento inverso) em vez de o apagar.
 * O livro-razao fica completo e o historico auditavel sobrevive.
 *
 * A perna estornada e sempre de magnitude igual e tipo oposto; um `ajuste`
 * estorna-se com o valor trocado de sinal, porque e o unico tipo assinado.
 */
export async function estornarMovimento(
  db: Ctx,
  tenantId: string,
  id: string,
  ctx: Contexto,
  motivo: string,
) {
  if (!motivo?.trim()) throw new ErroValidacao('Indique o motivo do estorno');

  const [original] = await db
    .select()
    .from(stockMovimentos)
    .where(and(eq(stockMovimentos.id, id), eq(stockMovimentos.tenantId, tenantId)))
    .limit(1);
  if (!original) throw new ErroNaoEncontrado('Movimento', id);
  if (original.deletedAt) throw new ErroRegraNegocio('Este movimento ja foi anulado');
  if (original.tipo === 'transferencia') {
    throw new ErroRegraNegocio(
      'Um movimento de transferencia e um par (saida na origem, entrada no destino). ' +
        'Estorne-o registando uma transferencia de volta.',
    );
  }

  const magnitude = arred3(Math.abs(paraNum(original.quantidade)));

  const inverso =
    original.tipo === 'entrada' ? 'saida' : original.tipo === 'saida' ? 'entrada' : 'ajuste';
  const quantidade = inverso === 'ajuste' ? arred3(-magnitude) : magnitude;

  if (inverso === 'saida') {
    const disponivel = await saldoDe(db, original.obraId, original.materialId);
    if (disponivel - magnitude < 0 && !config.dominio.stockPermiteNegativo) {
      throw new ErroRegraNegocio(
        `Nao ha saldo para estornar: sobram ${disponivel} e o estorno devolveria ${magnitude}.`,
      );
    }
  }

  return db.transaction(async (tx) => {
    const [estorno] = await tx
      .insert(stockMovimentos)
      .values({
        tenantId,
        obraId: original.obraId,
        materialId: original.materialId,
        tipo: inverso,
        quantidade: quantidade.toFixed(3),
        precoUnitario: original.precoUnitario,
        requisicaoId: original.requisicaoId,
        utilizadorId: ctx.utilizadorId,
        observacoes: `Estorno: ${motivo}`.trim(),
        data: new Date(),
      })
      .returning();

    // O estorno de uma compra tambem tem de desfazer o custo que ela gerou,
    // senao a obra continua a suportar uma compra que ja nao existe.
    let custoRemovido = 0;
    if (original.tipo === 'entrada') {
      const removidos = await tx.execute<{ id: string }>(sql`
        UPDATE custos
           SET deleted_at = now(), updated_at = now()
         WHERE tenant_id = ${tenantId}
           AND origem_tabela = 'stock_movimentos'
           AND origem_id = ${id}
           AND deleted_at IS NULL
        RETURNING id`);
      custoRemovido = removidos.rows.length;
    }

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'stock.estorno',
      entidade: 'stock_movimento',
      entidadeId: id,
      dadosAntes: { tipo: original.tipo, quantidade: original.quantidade },
      dadosDepois: {
        tipoEstorno: inverso,
        quantidade,
        novoMovimentoId: estorno?.id ?? null,
        custosRemovidos: custoRemovido,
        motivo,
      },
      ip: ctx.ip,
    });

    return { estorno, original, custoRemovido };
  });
}

/** Stock por obra com valorization, para o dashboard do armazem. */
export async function resumoStock(db: Database, tenantId: string, obraId?: string) {
  const cond = obraId ? sql`AND v.obra_id = ${obraId}` : sql``;

  const res = await db.execute<{
    obra_id: string;
    obra_codigo: string;
    obra_nome: string;
    n_materials: string;
    valor: string | null;
  }>(
    sql`SELECT v.obra_id, o.codigo AS obra_codigo, o.nome AS obra_nome,
               count(*) AS n_materials,
               sum(v.saldo * coalesce(cm.custo_medio, 0)) AS valor
          FROM v_stock_actual v
          JOIN obras o ON o.id = v.obra_id
          LEFT JOIN v_custo_medio cm ON cm.material_id = v.material_id
                                      AND cm.tenant_id = v.tenant_id
         WHERE v.tenant_id = ${tenantId} AND v.saldo <> 0
         ${cond}
         GROUP BY v.obra_id, o.codigo, o.nome
         ORDER BY valor DESC NULLS LAST`,
  );

  return (res.rows ?? []).map((r) => ({
    obraId: r.obra_id,
    obraCodigo: r.obra_codigo,
    obraNome: r.obra_nome,
    materiais: Number(r.n_materials),
    valor: r.valor != null ? arred2(paraNum(r.valor)) : 0,
  }));
}