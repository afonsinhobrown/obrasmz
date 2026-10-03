import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Ctx } from '../db/tx.js';
import { custos, obras, orcamentoItens } from '../db/schema.js';
import { ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../lib/erros.js';
import { arred2, arred3, paraNum } from '../lib/money.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';
import { obterObra, recalcularProgresso } from './obras.js';

export const schemaItem = z.object({
  capitulo: z.string().max(120).nullable().optional(),
  descricao: z.string().min(1, 'A descricao e obrigatoria').max(500),
  unidade: z.string().min(1, 'A unidade e obrigatoria').max(24),
  quantidade: z.coerce.number().positive('A quantidade tem de ser maior que zero'),
  precoUnitario: z.coerce.number().min(0, 'O preco unitario nao pode ser negativo'),
  ordem: z.coerce.number().int().min(0).optional(),
});

export const schemaActualizarItem = schemaItem
  .partial()
  .extend({ qtdExecutada: z.coerce.number().min(0).optional() });

export async function listarItens(db: Ctx, tenantId: string, obraId: string) {
  return db
    .select()
    .from(orcamentoItens)
    .where(
      and(
        eq(orcamentoItens.tenantId, tenantId),
        eq(orcamentoItens.obraId, obraId),
        isNull(orcamentoItens.deletedAt),
      ),
    )
    .orderBy(asc(orcamentoItens.ordem), asc(orcamentoItens.descricao));
}

async function obterItem(db: Ctx, tenantId: string, id: string) {
  const [item] = await db
    .select()
    .from(orcamentoItens)
    .where(
      and(
        eq(orcamentoItens.id, id),
        eq(orcamentoItens.tenantId, tenantId),
        isNull(orcamentoItens.deletedAt),
      ),
    )
    .limit(1);
  if (!item) throw new ErroNaoEncontrado('Item de orcamento', id);
  return item;
}

/**
 * Soma orcada dos itens contra o orcamento contratual da obra.
 *
 * Com `BUDGET_STRICT=true` o excedente e recusado; por omissao e so
 * sinalizado, porque na pratica o orcamento revisto existe e o gestor
 * precisa de o registar â€” bloquear o trabalho no campo por causa de uma
 * regra de sistema e pior do que aceitar e avisar.
 */
async function guardarExcedente(
  db: Ctx,
  tenantId: string,
  obraId: string,
  somaOrcado: number,
  contexto: { accao: string; itemId?: string },
  ctx: Contexto,
) {
  const obra = await obterObra(db, tenantId, obraId);
  const contratual = paraNum(obra.orcamentoTotal);
  const excesso = arred2(somaOrcado - contratual);

  if (excesso > 0 && contratual > 0) {
    if (config.dominio.budgetStrict) {
      throw new ErroRegraNegocio(
        `O orcamento dos itens excede o valor contratual da obra em ${excesso} ${obra.moeda}. ` +
          'Ajuste a obra ou remova itens.',
        { contratual, itens: somaOrcado, excesso },
      );
    }
  }
  return { contratual, somaOrcado, excesso };
}

export async function criarItem(
  db: Ctx,
  tenantId: string,
  obraId: string,
  entrada: z.infer<typeof schemaItem>,
  ctx: Contexto,
) {
  await obterObra(db, tenantId, obraId);

  return db.transaction(async (tx) => {
    const [maior] = await tx
      .select({ ordem: sql<number>`coalesce(max(ordem), 0)` })
      .from(orcamentoItens)
      .where(and(eq(orcamentoItens.obraId, obraId), isNull(orcamentoItens.deletedAt)));

    const [item] = await tx
      .insert(orcamentoItens)
      .values({
        tenantId,
        obraId,
        capitulo: entrada.capitulo ?? null,
        descricao: entrada.descricao.trim(),
        unidade: entrada.unidade.trim(),
        quantidade: arred3(entrada.quantidade).toFixed(3),
        precoUnitario: arred2(entrada.precoUnitario).toFixed(2),
        ordem: entrada.ordem ?? Number(maior?.ordem ?? 0) + 10,
      })
      .returning();

    if (!item) throw new ErroValidacao('Falha ao criar o item');

    await atualizaOrcamentoDaObra(tx, tenantId, obraId);
    await recalcularProgresso(tx, obraId);

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'orcamento.item_criado',
      entidade: 'orcamento_item',
      entidadeId: item.id,
      dadosDepois: { descricao: item.descricao, quantidade: item.quantidade, preco: item.precoUnitario },
      ip: ctx.ip,
    });

    return item;
  });
}

export async function actualizarItem(
  db: Ctx,
  tenantId: string,
  id: string,
  campos: z.infer<typeof schemaActualizarItem>,
  ctx: Contexto,
) {
  const antes = await obterItem(db, tenantId, id);

  const novaQtd =
    campos.quantidade !== undefined ? arred3(campos.quantidade) : paraNum(antes.quantidade);

  // `ck_orcamento_itens_execucao`: nao se pode executar mais do que o orcado.
  const executado = campos.qtdExecutada !== undefined ? arred3(campos.qtdExecutada) : paraNum(antes.qtdExecutada);
  if (executado > novaQtd * 1.0001) {
    throw new ErroRegraNegocio(
      `Quantidade executada (${executado}) superior a quantidade orcada (${novaQtd}). ` +
        'Ajuste a quantidade orcada se houve revisao de medicao.',
      { executado, orcado: novaQtd },
    );
  }

  return db.transaction(async (tx) => {
    const [depois] = await tx
      .update(orcamentoItens)
      .set({
        ...(campos.capitulo !== undefined ? { capitulo: campos.capitulo } : {}),
        ...(campos.descricao !== undefined ? { descricao: campos.descricao.trim() } : {}),
        ...(campos.unidade !== undefined ? { unidade: campos.unidade.trim() } : {}),
        ...(campos.quantidade !== undefined ? { quantidade: arred3(campos.quantidade).toFixed(3) } : {}),
        ...(campos.precoUnitario !== undefined
          ? { precoUnitario: arred2(campos.precoUnitario).toFixed(2) }
          : {}),
        ...(campos.qtdExecutada !== undefined ? { qtdExecutada: arred3(campos.qtdExecutada).toFixed(3) } : {}),
        ...(campos.ordem !== undefined ? { ordem: campos.ordem } : {}),
        updatedAt: new Date(),
      })
      .where(eq(orcamentoItens.id, id))
      .returning();

    if (!depois) throw new ErroNaoEncontrado('Item de orcamento', id);

    await atualizaOrcamentoDaObra(tx, tenantId, antes.obraId);
    await recalcularProgresso(tx, antes.obraId);

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'orcamento.item_actualizado',
      entidade: 'orcamento_item',
      entidadeId: id,
      dadosAntes: {
        quantidade: antes.quantidade,
        precoUnitario: antes.precoUnitario,
        qtdExecutada: antes.qtdExecutada,
      },
      dadosDepois: {
        quantidade: depois.quantidade,
        precoUnitario: depois.precoUnitario,
        qtdExecutada: depois.qtdExecutada,
      },
      ip: ctx.ip,
    });

    return depois;
  });
}

export async function apagarItem(db: Ctx, tenantId: string, id: string, ctx: Contexto) {
  const antes = await obterItem(db, tenantId, id);

  // Item com custo associate ja foi usado para medir; apagar perderia a
  // ligacao ao historico financeiro.
  const [usado] = await db
    .select({ n: count() })
    .from(custos)
    .where(and(eq(custos.orcamentoItemId, id), isNull(custos.deletedAt)));

  if (Number(usado?.n ?? 0) > 0) {
    throw new ErroRegraNegocio(
      `O item esta usado em ${usado?.n} custo(s). Ajuste a quantidade executada para 0 em vez de o apagar.`,
    );
  }

  return db.transaction(async (tx) => {
    await tx
      .update(orcamentoItens)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(orcamentoItens.id, id));

    await atualizaOrcamentoDaObra(tx, tenantId, antes.obraId);
    await recalcularProgresso(tx, antes.obraId);

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'orcamento.item_apagado',
      entidade: 'orcamento_item',
      entidadeId: id,
      dadosAntes: { descricao: antes.descricao, quantidade: antes.quantidade },
      ip: ctx.ip,
    });

    return { ok: true };
  });
}

/**
 * Mantem `obras.orcamento_total` igual a soma dos itens **quando a obra ainda
 * nao tem valor contratual definido**. Se o gestor ja fixou o contratual, ele
 * manda â€” divergencias sao reportadas, nao sobrescritas.
 */
async function atualizaOrcamentoDaObra(
  db: Ctx,
  tenantId: string,
  obraId: string,
): Promise<void> {
  const [r] = await db
    .select({ soma: sql<string>`coalesce(sum(quantidade * preco_unitario), 0)` })
    .from(orcamentoItens)
    .where(and(eq(orcamentoItens.obraId, obraId), isNull(orcamentoItens.deletedAt)));

  const soma = arred2(paraNum(r?.soma));

  const [obra] = await db
    .select({ orcamentoTotal: obras.orcamentoTotal })
    .from(obras)
    .where(and(eq(obras.id, obraId), eq(obras.tenantId, tenantId)))
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', obraId);

  if (paraNum(obra.orcamentoTotal) === 0 && soma > 0) {
    await db
      .update(obras)
      .set({ orcamentoTotal: soma.toFixed(2), updatedAt: new Date() })
      .where(eq(obras.id, obraId));
  }
}

/* -------------------------------------------------------------------------
   Importacao por CSV
   ------------------------------------------------------------------------- */

/** Divide uma linha CSV respeitando aspas (campos como `2,5 m3, "cimento"`). */
export function partirLinhaCsv(linha: string, sep = ','): string[] {
  const campos: string[] = [];
  let atual = '';
  let dentroAspas = false;
  let i = 0;

  while (i < linha.length) {
    const c = linha[i]!;
    if (dentroAspas) {
      if (c === '"') {
        if (linha[i + 1] === '"') {
          atual += '"';
          i += 2;
          continue;
        }
        dentroAspas = false;
        i += 1;
        continue;
      }
      atual += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      dentroAspas = true;
      i += 1;
      continue;
    }
    if (c === sep) {
      campos.push(atual.trim());
      atual = '';
      i += 1;
      continue;
    }
    atual += c;
    i += 1;
  }
  campos.push(atual.trim());
  return campos;
}

export type LinhaOrcamento = {
  linha: number;
  capitulo?: string | null;
  descricao: string;
  unidade: string;
  quantidade: number;
  precoUnitario: number;
  erro?: string;
};

/**
 * Le um orcamento em CSV. Formato aceite (com ou sem linha de cabecalho):
 *   capitulo;descricao;unidade;quantidade;preco_unitario
 *   ;Assentamento de alicerce;m3;12,5;850,00
 *
 * O separador e detectado automaticamente (`,` ou `;`) porque as separacoes
 * decimais em Mocambique usam virgula e o Excel exporta `;` para nao confundir.
 */
export function lerCsvOrcamento(csv: string, separador?: string): LinhaOrcamento[] {
  const texto = csv.replace(/^\uFEFF/, '');
  const linhas = texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!linhas.length) return [];

  const sep =
    separador ??
    (linhas[0]!.includes(';') && !linhas[0]!.includes(',') ? ';' : ',');

  const resultado: LinhaOrcamento[] = [];
  let inicio = 0;

  const primeira = partirLinhaCsv(linhas[0]!, sep);
  const pareceCabecalho =
    /^\s*(capitulo|descricao|descri|unidade|qtd|quantidade|preco)/i.test(
      primeira.join(' '),
    ) && !/^\d/.test(primeira[primeira.length - 1] ?? '');
  if (pareceCabecalho) inicio = 1;

  for (let i = inicio; i < linhas.length; i += 1) {
    const c = partirLinhaCsv(linhas[i]!, sep);
    const capitulo = c[0]?.trim() || null;
    const descricao = c[1]?.trim() || '';
    const unidade = c[2]?.trim() || '';
    const qtd = paraNum(c[3]);
    const preco = paraNum(c[4]);

    if (!descricao) {
      resultado.push({ linha: i + 1, descricao: '', unidade, quantidade: 0, precoUnitario: 0, erro: 'Sem descricao' });
      continue;
    }
    if (!unidade) {
      resultado.push({ linha: i + 1, capitulo, descricao, unidade: '', quantidade: qtd, precoUnitario: preco, erro: 'Sem unidade' });
      continue;
    }
    if (!(qtd > 0)) {
      resultado.push({ linha: i + 1, capitulo, descricao, unidade, quantidade: qtd, precoUnitario: preco, erro: 'Quantidade invalida' });
      continue;
    }
    if (!(preco >= 0)) {
      resultado.push({ linha: i + 1, capitulo, descricao, unidade, quantidade: qtd, precoUnitario: preco, erro: 'Preco invalido' });
      continue;
    }

    resultado.push({ linha: i + 1, capitulo, descricao, unidade, quantidade: arred3(qtd), precoUnitario: arred2(preco) });
  }

  return resultado;
}

export type ResultadoImport = {
  importados: number;
  comErro: number;
  totalOrcado: string;
  erros: Array<{ linha: number; descricao: string; erro: string }>;
  itens: string[];
};

/**
 * Importa o orcamento de uma obra a partir de CSV. Por omissao `substituir`
 * e verdadeiro: um orcamento importado duas vezes nao pode duplicar itens.
 * As linhas com erro sao reportadas e nao interrompem as restantes â€” quem
 * importa 300 linhas nao quer perder 299 por causa de uma.
 */
export async function importarCsv(
  db: Ctx,
  tenantId: string,
  obraId: string,
  csv: string,
  opcoes: { substituir?: boolean; modo?: 'validar' | 'importar' },
  ctx: Contexto,
): Promise<ResultadoImport> {
  await obterObra(db, tenantId, obraId);

  const linhas = lerCsvOrcamento(csv);
  if (!linhas.length) throw new ErroValidacao('O CSV nao tem linhas de dados');

  const erros = linhas
    .filter((l) => l.erro)
    .map((l) => ({ linha: l.linha, descricao: l.descricao, erro: l.erro! }));

  const validas = linhas.filter((l) => !l.erro) as Array<Required<Omit<LinhaOrcamento, 'erro' | 'capitulo'>> & { capitulo: string | null }>;

  const soma = arred2(validas.reduce((acc, l) => acc + l.quantidade * l.precoUnitario, 0));

  if (opcoes.modo === 'validar') {
    return {
      importados: 0,
      comErro: erros.length,
      totalOrcado: soma.toFixed(2),
      erros,
      itens: [],
    };
  }

  if (validas.length) {
    await guardarExcedente(
      db,
      tenantId,
      obraId,
      soma,
      { accao: 'orcamento.importado' },
      ctx,
    );
  }

  const ids = await db.transaction(async (tx) => {
    if (opcoes.substituir !== false) {
      await tx
        .update(orcamentoItens)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(orcamentoItens.obraId, obraId), isNull(orcamentoItens.deletedAt)));
    }

    const inseridos: string[] = [];
    let ordem = 0;
    for (const l of validas) {
      ordem += 10;
      const [inserido] = await tx
        .insert(orcamentoItens)
        .values({
          tenantId,
          obraId,
          capitulo: l.capitulo ?? null,
          descricao: l.descricao,
          unidade: l.unidade,
          quantidade: l.quantidade.toFixed(3),
          precoUnitario: l.precoUnitario.toFixed(2),
          ordem,
        })
        .returning({ id: orcamentoItens.id });
      if (inserido) inseridos.push(inserido.id);
    }

    await atualizaOrcamentoDaObra(tx, tenantId, obraId);
    await recalcularProgresso(tx, obraId);

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'orcamento.importado',
      entidade: 'obra',
      entidadeId: obraId,
      dadosDepois: { itens: inseridos.length, total: soma.toFixed(2), substituir: opcoes.substituir !== false },
      ip: ctx.ip,
    });

    return inseridos;
  });

  return {
    importados: ids.length,
    comErro: erros.length,
    totalOrcado: soma.toFixed(2),
    erros,
    itens: ids,
  };
}

/** Detalhe por item: orcado, executado em quantidade e em valor. */
export async function detalheItens(db: Ctx, tenantId: string, obraId: string) {
  const itens = await listarItens(db, tenantId, obraId);

  return itens.map((i) => {
    const qtd = paraNum(i.quantidade);
    const exe = paraNum(i.qtdExecutada);
    return {
      ...i,
      valorOrcado: arred2(qtd * paraNum(i.precoUnitario)),
      valorExecutado: arred2(exe * paraNum(i.precoUnitario)),
      desvioQtd: arred3(exe - qtd),
      conclusaoPct: qtd > 0 ? arred2((exe / qtd) * 100) : 0,
    };
  });
}