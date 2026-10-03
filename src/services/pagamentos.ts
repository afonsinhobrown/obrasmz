import { and, count, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  contratosSubempreitada,
  folhasSalario,
  fornecedores,
  obras,
  pagamentos,
  presencas,
  subempreiteiros,
  trabalhadores,
} from '../db/schema.js';
import type { Ctx } from '../db/tx.js';
import { paraMoedaBase } from '../lib/cambio.js';
import { ErroConflito, ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../lib/erros.js';
import { arred2, paraNum } from '../lib/money.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';
import { posicaoContrato } from './subempreitada.js';

export const schemaPagamento = z
  .object({
    obraId: z.string().uuid(),
    beneficiarioTipo: z.enum(['trabalhador', 'subempreiteiro', 'fornecedor', 'outro']),
    /** Obrigatorio para todos menos `outro`. Validado contra a tabela certa. */
    beneficiarioId: z.string().uuid().nullable().optional(),
    contratoId: z.string().uuid().nullable().optional(),
    folhaId: z.string().uuid().nullable().optional(),
    descricao: z.string().max(500).nullable().optional(),
    valor: z.coerce.number().positive('O valor do pagamento tem de ser maior que zero'),
    moeda: z.string().length(3).optional(),
    /** Taxa explicita. Se ausente, usa a cotacao da data do pagamento. */
    taxaCambio: z.coerce.number().positive().nullable().optional(),
    metodo: z.enum(['numerario', 'mpesa', 'emola', 'transferencia', 'cheque']),
    referencia: z.string().max(120).nullable().optional(),
    comprovativoUrl: z.string().max(500).nullable().optional(),
    pagoEm: z.string().datetime().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.beneficiarioTipo !== 'outro' && !v.beneficiarioId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['beneficiarioId'],
        message: 'Escolha quem recebeu o pagamento',
      });
    }
    // Um pagamento a um subempreiteiro que nao esteja ligado a um contrato
    // deixa a posicao daquele contrato sem saber o que foi liquidado.
    if (v.beneficiarioTipo === 'subempreiteiro' && !v.contratoId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contratoId'],
        message:
          'Um pagamento a um subempreiteiro tem de estar ligado a um contrato: e o contrato que diz o que se pode pagar.',
      });
    }
    if (v.beneficiarioTipo === 'trabalhador' && v.contratoId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contratoId'],
        message: 'Um pagamento a trabalhador nao pertence a um contrato de subempreitada',
      });
    }
    if (v.taxaCambio != null && v.moeda == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['moeda'],
        message: 'Indique a moeda a que a taxa se aplica',
      });
    }
  });

export type Pagamento = z.infer<typeof schemaPagamento>;

/** Tabela de onde o beneficiario tem de existir, por tipo. */
const TABELA_BENEFICIARIO = {
  trabalhador: trabalhadores,
  subempreiteiro: subempreiteiros,
  fornecedor: fornecedores,
} as const;

/**
 * Regista um pagamento.
 *
 * Regras que este servico garante:
 *  - nunca se paga mais do que o executado no contrato. Paga-se medicao, nao
 *    contratual: e o que impede a empresa de "pagar" o que a obra ainda nao
 *   recognizou como entregue.
 *  - a taxa de cambio e resolvida na data do pagamento e gravada no registo.
 *    Um pagamento a USD registado em Janeiro tem de continuar a valer o que
 *    valia em Janeiro, mesmo que a cotacao mude amanha.
 *  - `taxa_cambio` e sempre gravada, mesmo quando e 1 (moeda base). A coluna
 *    e NOT NULL de propósito: um registo sem taxa e um registo que ninguem
 *    consegue auditar.
 *  - `mpesa`/`emola` exigem referencia — e o id da transacao que permite
 *    reconciliar o extracto bancario com a obra.
 */
export async function registarPagamento(
  db: Database,
  tenantId: string,
  entrada: Pagamento,
  ctx: Contexto,
) {
  const [obra] = await db
    .select({ id: obras.id, nome: obras.nome, codigo: obras.codigo, moeda: obras.moeda, estado: obras.estado })
    .from(obras)
    .where(and(eq(obras.id, entrada.obraId), eq(obras.tenantId, tenantId), isNull(obras.deletedAt)))
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', entrada.obraId);

  if (obra.estado === 'concluida') {
    throw new ErroRegraNegocio(
      `A obra ${obra.codigo} esta concluida. Reabra-a antes de registar pagamentos.`,
    );
  }

  const moeda = (entrada.moeda ?? obra.moeda).toUpperCase();
  const pagoEm = entrada.pagoEm ? new Date(entrada.pagoEm) : new Date();
  const valor = arred2(entrada.valor);

  if (
    (entrada.metodo === 'mpesa' || entrada.metodo === 'emola') &&
    !entrada.referencia?.trim()
  ) {
    throw new ErroValidacao(
      `Um pagamento por ${entrada.metodo} precisa da referencia da transacao para reconciliar o extracto.`,
    );
  }

  return db.transaction(async (tx) => {
    await validarBeneficiario(tx, tenantId, entrada);

    // Taxa: a explicita ganha, senao a cotacao da data do pagamento.
    let taxa: number;
    if (entrada.taxaCambio != null) {
      taxa = entrada.taxaCambio;
    } else {
      const r = await paraMoedaBase(tx, tenantId, 1, moeda, pagoEm);
      taxa = r.taxa;
    }
    const valorBase = arred2(valor * taxa);

    if (entrada.contratoId) {
      const posicao = await posicaoContrato(tx, tenantId, entrada.contratoId);
      if (posicao.estado !== 'activo' && posicao.estado !== 'concluido') {
        throw new ErroRegraNegocio(`O contrato esta em estado "${posicao.estado}".`);
      }
      if (valorBase > posicao.saldoAPagar) {
        throw new ErroRegraNegocio(
          posicao.executado === 0
            ? 'Este contrato ainda nao tem medicoes registadas, e por isso nao ha nada a pagar.'
            : `Excede o que este contrato deve. Ha ${posicao.saldoAPagar} por pagar eTentou pagar ${valorBase}.`,
          {
            saldoAPagar: posicao.saldoAPagar,
            pedido: valorBase,
            executado: posicao.executado,
            contratado: posicao.contratado,
          },
        );
      }
    }

    if (entrada.folhaId) {
      await validarFolha(tx, tenantId, entrada.folhaId, valorBase);
    }

    const [pagamento] = await tx
      .insert(pagamentos)
      .values({
        tenantId,
        obraId: obra.id,
        beneficiarioTipo: entrada.beneficiarioTipo,
        beneficiarioId: entrada.beneficiarioId ?? null,
        contratoId: entrada.contratoId ?? null,
        folhaId: entrada.folhaId ?? null,
        descricao: entrada.descricao ?? null,
        valor: valor.toFixed(2),
        moeda,
        taxaCambio: String(taxa),
        metodo: entrada.metodo,
        referencia: entrada.referencia ?? null,
        comprovativoUrl: entrada.comprovativoUrl ?? null,
        estado: 'registado',
        pagoEm,
        registadoPor: ctx.utilizadorId,
      })
      .returning();

    if (!pagamento) throw new ErroValidacao('Falha ao registar o pagamento');

    // Uma folha marcada como paga deixa de aceitar pagamentos avulsos: as
    // horas ja foram liquidadas por ela.
    let folhaPaga: { id: string } | null = null;
    if (entrada.folhaId) {
      const [f] = await tx
        .update(folhasSalario)
        .set({ estado: 'paga', updatedAt: new Date() })
        .where(eq(folhasSalario.id, entrada.folhaId))
        .returning({ id: folhasSalario.id });
      folhaPaga = f ?? null;
    }

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'pagamento.registado',
      entidade: 'pagamento',
      entidadeId: pagamento.id,
      dadosDepois: {
        obra: obra.codigo,
        beneficiarioTipo: entrada.beneficiarioTipo,
        valor,
        moeda,
        taxa,
        valorBase,
        metodo: entrada.metodo,
        referencia: entrada.referencia ?? null,
      },
      ip: ctx.ip,
    });

    return { pagamento, valorBase, folhaPaga: folhaPaga?.id ?? null };
  });
}

async function validarBeneficiario(tx: Ctx, tenantId: string, entrada: Pagamento) {
  if (entrada.beneficiarioTipo === 'outro') return;

  const tabela = TABELA_BENEFICIARIO[entrada.beneficiarioTipo];
  const id = entrada.beneficiarioId!;

  const [existe] = await tx
    .select({ id: tabela.id })
    .from(tabela)
    .where(and(eq(tabela.id, id), isNull(tabela.deletedAt)))
    .limit(1);

  if (!existe) {
    throw new ErroNaoEncontrado(
      entrada.beneficiarioTipo === 'subempreiteiro' ? 'Subempreiteiro' : 'Beneficiario',
      id,
    );
  }

  // Um subempreiteiro so recebe por um contrato SEU, da mesma obra.
  if (entrada.beneficiarioTipo === 'subempreiteiro' && entrada.contratoId) {
    const [contrato] = await tx
      .select({ id: contratosSubempreitada.id, subempreiteiroId: contratosSubempreitada.subempreiteiroId, obraId: contratosSubempreitada.obraId })
      .from(contratosSubempreitada)
      .where(
        and(
          eq(contratosSubempreitada.id, entrada.contratoId),
          eq(contratosSubempreitada.tenantId, tenantId),
          isNull(contratosSubempreitada.deletedAt),
        ),
      )
      .limit(1);
    if (!contrato) throw new ErroNaoEncontrado('Contrato', entrada.contratoId);
    if (contrato.subempreiteiroId !== id) {
      throw new ErroValidacao('O pagamento nao corresponde ao subempreiteiro do contrato.');
    }
    if (contrato.obraId !== entrada.obraId) {
      throw new ErroValidacao('O contrato pertence a outra obra.');
    }
  }
}

async function validarFolha(tx: Ctx, tenantId: string, folhaId: string, valorBase: number) {
  const [folha] = await tx
    .select({
      id: folhasSalario.id,
      estado: folhasSalario.estado,
      valor: folhasSalario.valor,
      moeda: folhasSalario.moeda,
    })
    .from(folhasSalario)
    .where(and(eq(folhasSalario.id, folhaId), eq(folhasSalario.tenantId, tenantId)))
    .limit(1);
  if (!folha) throw new ErroNaoEncontrado('Folha de salario', folhaId);
  if (folha.estado === 'anulada') throw new ErroRegraNegocio('Esta folha esta anulada.');
  if (folha.estado === 'paga') {
    throw new ErroConflito('Esta folha ja foi paga. Anule o pagamento anterior primeiro.');
  }

  const total = paraNum(folha.valor);
  if (Math.abs(valorBase - total) > 0.01) {
    throw new ErroRegraNegocio(
      `O valor do pagamento (${valorBase}) nao corresponde ao total da folha (${total}). ` +
        'Uma folha paga-se inteira, numa so vez.',
      { valorPagamento: valorBase, totalFolha: total },
    );
  }
}

/** Detalhe de um pagamento com os nomes resolvidos. */
export async function obterPagamento(db: Database, tenantId: string, id: string) {
  const [p] = await db
    .select()
    .from(pagamentos)
    .where(and(eq(pagamentos.id, id), eq(pagamentos.tenantId, tenantId)))
    .limit(1);
  if (!p) throw new ErroNaoEncontrado('Pagamento', id);

  return { ...p, beneficiario: await nomeBeneficiario(db, p) };
}

async function nomeBeneficiario(
  db: Ctx,
  p: { beneficiarioTipo: string; beneficiarioId: string | null; contratoId: string | null },
): Promise<string | null> {
  if (p.beneficiarioTipo === 'trabalhador' && p.beneficiarioId) {
    const [t] = await db
      .select({ nome: trabalhadores.nome })
      .from(trabalhadores)
      .where(eq(trabalhadores.id, p.beneficiarioId))
      .limit(1);
    return t?.nome ?? null;
  }
  if (p.beneficiarioTipo === 'fornecedor' && p.beneficiarioId) {
    const [f] = await db
      .select({ nome: fornecedores.nome })
      .from(fornecedores)
      .where(eq(fornecedores.id, p.beneficiarioId))
      .limit(1);
    return f?.nome ?? null;
  }
  // Num pagamento a subempreiteiro o `beneficiario_id` ja e o subempreiteiro;
  // o contrato serve para saber contra que obra liquidar.
  if (p.beneficiarioTipo === 'subempreiteiro' && p.beneficiarioId) {
    const [s] = await db
      .select({ nome: subempreiteiros.nome })
      .from(subempreiteiros)
      .where(eq(subempreiteiros.id, p.beneficiarioId))
      .limit(1);
    return s?.nome ?? null;
  }
  return null;
}

export async function listarPagamentos(
  db: Database,
  tenantId: string,
  filtro: {
    obraId?: string;
    beneficiarioTipo?: 'trabalhador' | 'subempreiteiro' | 'fornecedor' | 'outro';
    beneficiarioId?: string;
    contratoId?: string;
    metodo?: 'numerario' | 'mpesa' | 'emola' | 'transferencia' | 'cheque';
    estado?: 'registado' | 'confirmado' | 'anulado';
    de?: string;
    ate?: string;
    limite?: number;
  } = {},
) {
  const cond = [eq(pagamentos.tenantId, tenantId), isNull(pagamentos.deletedAt)];
  if (filtro.obraId) cond.push(eq(pagamentos.obraId, filtro.obraId));
  if (filtro.beneficiarioTipo)
    cond.push(eq(pagamentos.beneficiarioTipo, filtro.beneficiarioTipo));
  if (filtro.beneficiarioId) cond.push(eq(pagamentos.beneficiarioId, filtro.beneficiarioId));
  if (filtro.contratoId) cond.push(eq(pagamentos.contratoId, filtro.contratoId));
  if (filtro.metodo) cond.push(eq(pagamentos.metodo, filtro.metodo));
  if (filtro.estado) cond.push(eq(pagamentos.estado, filtro.estado));
  if (filtro.de) cond.push(gte(pagamentos.pagoEm, new Date(`${filtro.de}T00:00:00Z`)));
  if (filtro.ate) cond.push(lte(pagamentos.pagoEm, new Date(`${filtro.ate}T23:59:59Z`)));

  const linhas = await db
    .select({
      id: pagamentos.id,
      obraId: pagamentos.obraId,
      obraCodigo: obras.codigo,
      obraNome: obras.nome,
      beneficiarioTipo: pagamentos.beneficiarioTipo,
      beneficiarioId: pagamentos.beneficiarioId,
      contratoId: pagamentos.contratoId,
      descricao: pagamentos.descricao,
      valor: pagamentos.valor,
      moeda: pagamentos.moeda,
      taxaCambio: pagamentos.taxaCambio,
      valorBase: sql<string>`${pagamentos.valor} * ${pagamentos.taxaCambio}`,
      metodo: pagamentos.metodo,
      referencia: pagamentos.referencia,
      comprovativoUrl: pagamentos.comprovativoUrl,
      estado: pagamentos.estado,
      pagoEm: pagamentos.pagoEm,
    })
    .from(pagamentos)
    .innerJoin(obras, eq(obras.id, pagamentos.obraId))
    .where(and(...cond))
    .orderBy(desc(pagamentos.pagoEm), desc(pagamentos.id))
    .limit(filtro.limite ?? 200);

  return linhas.map((l) => ({
    ...l,
    valorBase: arred2(paraNum(l.valorBase)).toFixed(2),
    beneficiario: null as string | null,
  }));
}

/**
 * Anula um pagamento.
 *
 * Nao se apaga: o registo fica com `estado = 'anulado'` e o motivo. Um
 * pagamento que desaparecesse da base seria impossivel de explicar numa
 * auditoria ou num litigo com o banco.
 */
export async function anularPagamento(
  db: Database,
  tenantId: string,
  id: string,
  motivo: string,
  ctx: Contexto,
) {
  if (!motivo?.trim()) throw new ErroValidacao('Indique o motivo da anulacao');

  const [antes] = await db
    .select({
      id: pagamentos.id,
      estado: pagamentos.estado,
      valor: pagamentos.valor,
      moeda: pagamentos.moeda,
      folhaId: pagamentos.folhaId,
    })
    .from(pagamentos)
    .where(and(eq(pagamentos.id, id), eq(pagamentos.tenantId, tenantId)))
    .limit(1);
  if (!antes) throw new ErroNaoEncontrado('Pagamento', id);
  if (antes.estado === 'anulado') throw new ErroRegraNegocio('Este pagamento ja esta anulado.');

  return db.transaction(async (tx) => {
    const [depois] = await tx
      .update(pagamentos)
      .set({ estado: 'anulado', anuladoMotivo: motivo.trim(), updatedAt: new Date() })
      .where(eq(pagamentos.id, id))
      .returning();

    // A folha que este pagamento liquidava volta a ficar `lancada`, para poder
    // ser paga outra vez. Sem isto, anular o pagamento deixaria a folha num
    // estado que ninguem consegue pagar.
    let folhaReaberta: string | null = null;
    if (antes.folhaId) {
      const [f] = await tx
        .update(folhasSalario)
        .set({ estado: 'lancada', updatedAt: new Date() })
        .where(
          and(
            eq(folhasSalario.id, antes.folhaId),
            eq(folhasSalario.tenantId, tenantId),
            eq(folhasSalario.estado, 'paga'),
          ),
        )
        .returning({ id: folhasSalario.id });
      folhaReaberta = f?.id ?? null;
    }

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'pagamento.anulado',
      entidade: 'pagamento',
      entidadeId: id,
      dadosAntes: { estado: antes.estado, valor: antes.valor, moeda: antes.moeda },
      dadosDepois: { estado: 'anulado', motivo, folhaReaberta },
      ip: ctx.ip,
    });

    return { ...depois, folhaReaberta };
  });
}

/** Confirma um pagamento mobile (a pessoa mostra o comprovativo ao gestor). */
export async function confirmarPagamento(
  db: Database,
  tenantId: string,
  id: string,
  ctx: Contexto,
) {
  const [antes] = await db
    .select({ id: pagamentos.id, estado: pagamentos.estado })
    .from(pagamentos)
    .where(and(eq(pagamentos.id, id), eq(pagamentos.tenantId, tenantId)))
    .limit(1);
  if (!antes) throw new ErroNaoEncontrado('Pagamento', id);
  if (antes.estado === 'anulado') throw new ErroRegraNegocio('Um pagamento anulado nao se confirma.');
  if (antes.estado === 'confirmado') return antes;

  const [depois] = await db
    .update(pagamentos)
    .set({ estado: 'confirmado', updatedAt: new Date() })
    .where(eq(pagamentos.id, id))
    .returning();

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'pagamento.confirmado',
    entidade: 'pagamento',
    entidadeId: id,
    dadosAntes: { estado: antes.estado },
    dadosDepois: { estado: 'confirmado' },
    ip: ctx.ip,
  });

  return depois;
}

/**
 * Totais por metodo e por beneficiario. E o que responde a "quanto pagamos em
 * numerario este mes" — a pergunta que um contabilista faz primeiro.
 */
export async function resumoPagamentos(
  db: Database,
  tenantId: string,
  filtro: { obraId?: string; de?: string; ate?: string } = {},
) {
  const cond = [
    eq(pagamentos.tenantId, tenantId),
    isNull(pagamentos.deletedAt),
    sql`${pagamentos.estado} <> 'anulado'`,
  ];
  if (filtro.obraId) cond.push(eq(pagamentos.obraId, filtro.obraId));
  if (filtro.de) cond.push(gte(pagamentos.pagoEm, new Date(`${filtro.de}T00:00:00Z`)));
  if (filtro.ate) cond.push(lte(pagamentos.pagoEm, new Date(`${filtro.ate}T23:59:59Z`)));

  const [total] = await db
    .select({
      soma: sql<string>`coalesce(sum(${pagamentos.valor} * ${pagamentos.taxaCambio}), 0)`,
      n: count(),
    })
    .from(pagamentos)
    .where(and(...cond));

  const porMetodo = await db
    .select({
      metodo: pagamentos.metodo,
      soma: sql<string>`coalesce(sum(${pagamentos.valor} * ${pagamentos.taxaCambio}), 0)`,
      n: count(),
    })
    .from(pagamentos)
    .where(and(...cond))
    .groupBy(pagamentos.metodo);

  const porBeneficiario = await db
    .select({
      tipo: pagamentos.beneficiarioTipo,
      soma: sql<string>`coalesce(sum(${pagamentos.valor} * ${pagamentos.taxaCambio}), 0)`,
      n: count(),
    })
    .from(pagamentos)
    .where(and(...cond))
    .groupBy(pagamentos.beneficiarioTipo);

  return {
    total: arred2(paraNum(total?.soma)).toFixed(2),
    nPagamentos: Number(total?.n ?? 0),
    porMetodo: porMetodo.map((m) => ({
      metodo: m.metodo,
      total: arred2(paraNum(m.soma)).toFixed(2),
      n: Number(m.n),
    })),
    porBeneficiario: porBeneficiario.map((b) => ({
      tipo: b.tipo,
      total: arred2(paraNum(b.soma)).toFixed(2),
      n: Number(b.n),
    })),
  };
}

/** Contratos com medicao por liquidar — a fila de trabalho do financeiro. */
export async function pagamentosPendentes(db: Database, tenantId: string) {
  const linhas = await db.execute<{
    contrato_id: string;
    codigo: string;
    obra_codigo: string;
    obra_nome: string;
    subempreiteiro: string;
    contratado: string;
    executado: string;
    pago: string;
    saldo_pagar: string;
  }>(sql`
    SELECT v.contrato_id,
           v.codigo,
           o.codigo  AS obra_codigo,
           o.nome    AS obra_nome,
           s.nome    AS subempreiteiro,
           v.contratado,
           v.executado,
           v.pago,
           v.saldo_pagar
      FROM v_contrato_subempreitada v
      JOIN obras o ON o.id = v.obra_id
      JOIN contratos_subempreitada ct ON ct.id = v.contrato_id
      JOIN subempreiteiros s ON s.id = ct.subempreiteiro_id
     WHERE v.tenant_id = ${tenantId}
       AND v.estado = 'activo'
       AND v.saldo_pagar > 0
     ORDER BY v.saldo_pagar DESC`);

  return (linhas.rows ?? []).map((r) => ({
    contratoId: r.contrato_id,
    codigo: r.codigo,
    obra: { codigo: r.obra_codigo, nome: r.obra_nome },
    subempreiteiro: r.subempreiteiro,
    contratado: arred2(paraNum(r.contratado)).toFixed(2),
    executado: arred2(paraNum(r.executado)).toFixed(2),
    pago: arred2(paraNum(r.pago)).toFixed(2),
    saldoPagar: arred2(paraNum(r.saldo_pagar)).toFixed(2),
  }));
}

/**
 * Confirma a folha e paga as suas horas numa so operacao.
 *
 * As horas de uma folha podem estar repartidas por varias obras (o trabalhador
 * foi destacado para dois canteiros no mesmo mes). Nesses casos recusamos:
 * cada obra tem de receber o seu pagamento e o seu comprovativo, e inventar uma
 * obra "principal" seria attribuir custo a uma obra onde nao houve trabalho.
 */
export async function pagarFolha(
  db: Database,
  tenantId: string,
  folhaId: string,
  metodo: 'numerario' | 'mpesa' | 'emola' | 'transferencia' | 'cheque',
  referencia: string | null,
  ctx: Contexto,
) {
  const [folha] = await db
    .select({
      id: folhasSalario.id,
      estado: folhasSalario.estado,
      valor: folhasSalario.valor,
      moeda: folhasSalario.moeda,
      trabalhadorId: folhasSalario.trabalhadorId,
      periodoInicio: folhasSalario.periodoInicio,
      periodoFim: folhasSalario.periodoFim,
    })
    .from(folhasSalario)
    .where(and(eq(folhasSalario.id, folhaId), eq(folhasSalario.tenantId, tenantId)))
    .limit(1);
  if (!folha) throw new ErroNaoEncontrado('Folha de salario', folhaId);
  if (folha.estado !== 'lancada') {
    throw new ErroRegraNegocio(
      `So se paga uma folha "lancada". Esta esta em "${folha.estado}".`,
    );
  }

  // As obras desta folha sao as obras onde houve presencas no periodo.
  const obrasDaFolha = await db
    .select({ obraId: presencas.obraId, codigo: obras.codigo })
    .from(presencas)
    .innerJoin(obras, eq(obras.id, presencas.obraId))
    .where(
      and(
        eq(presencas.tenantId, tenantId),
        eq(presencas.trabalhadorId, folha.trabalhadorId),
        gte(presencas.data, folha.periodoInicio),
        lte(presencas.data, folha.periodoFim),
        isNull(presencas.deletedAt),
      ),
    )
    .groupBy(presencas.obraId, obras.codigo);

  if (obrasDaFolha.length === 0) {
    throw new ErroRegraNegocio(
      'Esta folha nao tem presencas no periodo: nao ha obra aonde lancar o pagamento.',
    );
  }
  if (obrasDaFolha.length > 1) {
    throw new ErroRegraNegocio(
      `As horas desta folha estao repartidas por ${obrasDaFolha.length} obras ` +
        `(${obrasDaFolha.map((o) => o.codigo).join(', ')}). Pague cada obra em separado para que ` +
        'cada uma receba o comprovativo certo e o custo caia onde houve trabalho.',
      { obras: obrasDaFolha.map((o) => o.codigo) },
    );
  }

  // `obrasDaFolha` tem exactamente um elemento: os dois ramos acima lancam
  // excecao nos outros casos.
  const unicaObra = obrasDaFolha[0]!;

  const { pagamento } = await registarPagamento(
    db,
    tenantId,
    {
      obraId: unicaObra.obraId,
      beneficiarioTipo: 'trabalhador',
      beneficiarioId: folha.trabalhadorId,
      descricao: `Folha de salario ${folha.periodoInicio} a ${folha.periodoFim}`,
      valor: paraNum(folha.valor),
      moeda: folha.moeda,
      metodo,
      referencia,
      folhaId,
    },
    ctx,
  );

  return pagamento;
}

/** Pagamentos por obra, para o relatorio de fluxo de caixa da obra. */
export async function pagamentosPorObra(db: Database, tenantId: string, obraId: string) {
  return db
    .select({
      metodo: pagamentos.metodo,
      estado: pagamentos.estado,
      soma: sql<string>`coalesce(sum(${pagamentos.valor} * ${pagamentos.taxaCambio}), 0)`,
      n: count(),
    })
    .from(pagamentos)
    .where(
      and(
        eq(pagamentos.tenantId, tenantId),
        eq(pagamentos.obraId, obraId),
        isNull(pagamentos.deletedAt),
        sql`${pagamentos.estado} <> 'anulado'`,
      ),
    )
    .groupBy(pagamentos.metodo, pagamentos.estado);
}

/** Pagamentos por obra, para o relatorio de fluxo de caixa da obra. */
