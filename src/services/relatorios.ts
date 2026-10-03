import { and, count, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  custos,
  diarioObra,
  folhasSalario,
  obras,
  orcamentoItens,
  pagamentos,
  presencas,
  requisicoes,
  trabalhadores,
} from '../db/schema.js';
import { ErroNaoEncontrado } from '../lib/erros.js';
import { hojeISO } from '../lib/datas.js';
import { arred2, paraNum } from '../lib/money.js';

/**
 * Relatorios.
 *
 * Duas regras transversais a tudo o que esta neste ficheiro:
 *
 *  1. Os valores monetarios sao sempre devolvidos em **moeda base** (a coluna
 *     `valor * taxa_cambio`) e como `NUMERIC` em string. Um `number` em JS
 *     perde precisao acima de 2^53 e, pior, transforma 0.1 + 0.2 em 0.30000000004
 *     num documento que vai para o cliente.
 *
 *  2. Nenhum relatorio faz contas em JavaScript quando o PostgreSQL as faz
 *     melhor. Somar custos em memoria obriga a trazer milhares de linhas para o
 *     processo e dava resultados diferentes conforme a paginacao.
 */

export type Periodo = { de?: string; ate?: string };


/**
 * Painel principal da empresa: o que o dono quer ver ao abrir a aplicacao.
 *
 * `margem` e o unico numero que importa: quanto da obra fica depois de pagar
 * tudo o que ela consome.
 */
export async function dashboard(db: Database, tenantId: string) {
  const [plano] = await db
    .select({ moedaBase: sql<string>`moeda_base` })
    .from(sql`tenants`)
    .where(sql`id = ${tenantId}`)
    .limit(1);

  const obrasAtivas = await db
    .select({
      id: obras.id,
      codigo: obras.codigo,
      nome: obras.nome,
      estado: obras.estado,
      progressoPct: obras.progressoPct,
      orcamentoTotal: obras.orcamentoTotal,
      moeda: obras.moeda,
      dataInicio: obras.dataInicio,
      dataFimPrevista: obras.dataFimPrevista,
    })
    .from(obras)
    .where(and(eq(obras.tenantId, tenantId), isNull(obras.deletedAt)))
    .orderBy(desc(obras.criadoEm));

  const custoPorObra = await db
    .select({
      obraId: custos.obraId,
      total: sql<string>`coalesce(sum(${custos.valor} * ${custos.taxaCambio}), 0)`,
    })
    .from(custos)
    .where(and(eq(custos.tenantId, tenantId), isNull(custos.deletedAt)))
    .groupBy(custos.obraId);

  const pagoPorObra = await db
    .select({
      obraId: pagamentos.obraId,
      total: sql<string>`coalesce(sum(${pagamentos.valor} * ${pagamentos.taxaCambio}), 0)`,
    })
    .from(pagamentos)
    .where(
      and(
        eq(pagamentos.tenantId, tenantId),
        isNull(pagamentos.deletedAt),
        sql`${pagamentos.estado} <> 'anulado'`,
      ),
    )
    .groupBy(pagamentos.obraId);

  const porEstado = await db
    .select({ estado: obras.estado, n: count() })
    .from(obras)
    .where(and(eq(obras.tenantId, tenantId), isNull(obras.deletedAt)))
    .groupBy(obras.estado);

  const custoMapa = new Map(custoPorObra.map((c) => [c.obraId, paraNum(c.total)]));
  const pagoMapa = new Map(pagoPorObra.map((p) => [p.obraId, paraNum(p.total)]));

  let orcado = 0;
  let real = 0;
  let pago = 0;

  const lista = obrasAtivas.map((o) => {
    const c = arred2(custoMapa.get(o.id) ?? 0);
    const p = arred2(pagoMapa.get(o.id) ?? 0);
    orcado += paraNum(o.orcamentoTotal);
    real += c;
    pago += p;

    return {
      id: o.id,
      codigo: o.codigo,
      nome: o.nome,
      estado: o.estado,
      progressoPct: o.progressoPct,
      orcado: o.orcamentoTotal,
      custoReal: c.toFixed(2),
      pago: p.toFixed(2),
      margem: arred2(paraNum(o.orcamentoTotal) - c).toFixed(2),
      consumoPct:
        paraNum(o.orcamentoTotal) > 0
          ? arred2((c / paraNum(o.orcamentoTotal)) * 100).toFixed(2)
          : '0.00',
      // Sinal de alerta: consumiu mais do que o previsto antes de a obra
      // estar concluida. E o numero que evita a surpresa no fim da obra.
      emRisco:
        o.estado !== 'concluida' && paraNum(o.orcamentoTotal) > 0 && c > paraNum(o.orcamentoTotal),
    };
  });

  const arred = (n: number) => arred2(n).toFixed(2);

  return {
    moedaBase: plano?.moedaBase ?? 'MZN',
    hoje: hojeISO(),
    obras: lista,
    porEstado: Object.fromEntries(porEstado.map((e) => [e.estado, Number(e.n)])),
    totais: {
      nObras: lista.length,
      orcado: arred(orcado),
      custoReal: arred(real),
      pago: arred(pago),
      margem: arred(orcado - real),
      margemPct: orcado > 0 ? arred2(((orcado - real) / orcado) * 100).toFixed(2) : '0.00',
      consumoPct: orcado > 0 ? arred2((real / orcado) * 100).toFixed(2) : '0.00',
    },
  };
}

/** Orcado vs real de todas as obras, a partir da vista. */
export async function orcadoVsReal(db: Database, tenantId: string, periodo: Periodo = {}) {
  const cond = [sql`v.tenant_id = ${tenantId}`];
  if (periodo.de) cond.push(sql`(v.real > 0 OR o.data_inicio >= ${periodo.de})`);
  if (periodo.ate) cond.push(sql`(v.real > 0 OR o.data_inicio <= ${periodo.ate})`);

  const r = await db.execute<{
    obra_id: string;
    codigo: string;
    nome: string;
    moeda: string;
    orcado: string;
    real: string;
    saldo: string;
    desvio: string;
    consumo_pct: string | null;
    estado: string;
    progresso_pct: string;
  }>(sql`
    SELECT v.obra_id, v.codigo, v.nome, v.moeda, v.orcado, v.real, v.saldo,
           v.desvio, v.consumo_pct,
           o.estado, o.progresso_pct
      FROM v_obra_orcado_vs_real v
      JOIN obras o ON o.id = v.obra_id
     WHERE ${cond.reduce((a, b) => sql`${a} AND ${b}`, sql`TRUE`)}
     ORDER BY v.desvio DESC`);

  return (r.rows ?? []).map((x) => ({
    obraId: x.obra_id,
    codigo: x.codigo,
    nome: x.nome,
    estado: x.estado,
    progressoPct: x.progresso_pct,
    orcado: arred2(paraNum(x.orcado)).toFixed(2),
    real: arred2(paraNum(x.real)).toFixed(2),
    saldo: arred2(paraNum(x.saldo)).toFixed(2),
    desvio: arred2(paraNum(x.desvio)).toFixed(2),
    consumoPct: x.consumo_pct ?? '0.00',
    // Consumiu mais do que orcou sem estar concluida: a obra precisa de revisao.
    emRisco: paraNum(x.desvio) > 0 && x.estado !== 'concluida',
  }));
}

/**
 * Curva S: quanto se previa gastar ate cada mes, contra quanto se gastou.
 *
 * A linha "previsto" e uma recta entre o inicio e o fim previsto da obra,
 * repartida pelo valor orcado. E assim que se ve se a obra esta adiantada ou
 * atrasada em relacao ao plano — e a unica leitura que faz sentido num
 * grafico de uma obra so.
 */
export async function curvaS(db: Database, tenantId: string, obraId: string) {
  const [obra] = await db
    .select({
      id: obras.id,
      codigo: obras.codigo,
      nome: obras.nome,
      orcadoTotal: obras.orcamentoTotal,
      dataInicio: obras.dataInicio,
      dataFimPrevista: obras.dataFimPrevista,
      estado: obras.estado,
    })
    .from(obras)
    .where(and(eq(obras.id, obraId), eq(obras.tenantId, tenantId), isNull(obras.deletedAt)))
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', obraId);

  const inicio = obra.dataInicio;
  const fim = obra.dataFimPrevista;

  const realizado = await db
    .select({
      mes: sql<string>`to_char(${custos.data}, 'YYYY-MM')`,
      total: sql<string>`coalesce(sum(${custos.valor} * ${custos.taxaCambio}), 0)`,
    })
    .from(custos)
    .where(
      and(
        eq(custos.tenantId, tenantId),
        eq(custos.obraId, obraId),
        isNull(custos.deletedAt),
      ),
    )
    .groupBy(sql`to_char(${custos.data}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${custos.data}, 'YYYY-MM')`);

  const orcado = paraNum(obra.orcadoTotal);

  const meses: {
    mes: string;
    previsto: number;
    realizado: number;
    acumuladoPrevisto: number;
    acumuladoReal: number;
  }[] = [];
  let acumuladoPrevisto = 0;
  let acumuladoReal = 0;

  const inicioRealizado = realizado[0]?.mes ?? null;
  const primeiro = inicio ?? inicioRealizado;
  const ultimo = fim ?? (inicioRealizado ? somaMeses(inicioRealizado, realizado.length - 1) : null);

  if (primeiro && ultimo && orcado > 0) {
    const totalMeses = diffMeses(primeiro, ultimo);
    const porMes = orcado / (totalMeses + 1);

    for (let i = 0; i <= totalMeses; i++) {
      const mes = somaMeses(primeiro, i);
      const doMes = realizado.find((r) => r.mes === mes);
      const valorReal = doMes ? paraNum(doMes.total) : 0;
      acumuladoPrevisto = arred2(acumuladoPrevisto + porMes);
      acumuladoReal = arred2(acumuladoReal + valorReal);
      meses.push({
        mes,
        previsto: arred2(porMes),
        realizado: arred2(valorReal),
        acumuladoPrevisto,
        acumuladoReal,
      });
    }
  }

  return {
    obra: {
      id: obra.id,
      codigo: obra.codigo,
      nome: obra.nome,
      estado: obra.estado,
      orcadoTotal: arred2(orcado).toFixed(2),
      inicio,
      fimPrevisto: fim,
    },
    meses,
    desvio: arred2(acumuladoReal - acumuladoPrevisto).toFixed(2),
    // Gasto a mais do que a recta do plano neste momento.
    adiantado: acumuladoReal > acumuladoPrevisto,
  };
}

function somaMeses(ym: string, n: number): string {
  const partes = ym.split('-').map(Number);
  const d = new Date(Date.UTC(partes[0] ?? 1970, (partes[1] ?? 1) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function diffMeses(de: string, ate: string): number {
  const x = de.split('-').map(Number);
  const y = ate.split('-').map(Number);
  return (y[0] ?? 0) * 12 + (y[1] ?? 0) - ((x[0] ?? 0) * 12 + (x[1] ?? 0));
}

/**
 * Conta corrente da obra: quanto custou, quanto se pagou, quanto falta.
 *
 * E o relatorio que substitui a conversa "quanto de dinheiro ainda tem esta
 * obra" — e o unico onde custos e pagamentos aparecem lado a lado.
 */
export async function contaCorrente(db: Database, tenantId: string, obraId: string, periodo: Periodo = {}) {
  const condCusto = [eq(custos.tenantId, tenantId), eq(custos.obraId, obraId), isNull(custos.deletedAt)];
  const condPago = [
    eq(pagamentos.tenantId, tenantId),
    eq(pagamentos.obraId, obraId),
    isNull(pagamentos.deletedAt),
    sql`${pagamentos.estado} <> 'anulado'`,
  ];
  if (periodo.de) {
    condCusto.push(gte(custos.data, periodo.de) as never);
    condPago.push(gte(pagamentos.pagoEm, new Date(`${periodo.de}T00:00:00Z`)) as never);
  }
  if (periodo.ate) {
    condCusto.push(lte(custos.data, periodo.ate) as never);
    condPago.push(lte(pagamentos.pagoEm, new Date(`${periodo.ate}T23:59:59Z`)) as never);
  }

  const [totalCusto] = await db
    .select({
      soma: sql<string>`coalesce(sum(${custos.valor} * ${custos.taxaCambio}), 0)`,
      n: count(),
    })
    .from(custos)
    .where(and(...condCusto));

  const [totalPago] = await db
    .select({
      soma: sql<string>`coalesce(sum(${pagamentos.valor} * ${pagamentos.taxaCambio}), 0)`,
      n: count(),
    })
    .from(pagamentos)
    .where(and(...condPago));

  const custo = paraNum(totalCusto?.soma);
  const pago = paraNum(totalPago?.soma);

  return {
    periodo: periodo.de ?? null,
    custo: arred2(custo).toFixed(2),
    pago: arred2(pago).toFixed(2),
    // Positivo = a obra consumiu mais do que pagou; e o numerario que falta.
    diferenca: arred2(custo - pago).toFixed(2),
    nLancamentos: Number(totalCusto?.n ?? 0),
    nPagamentos: Number(totalPago?.n ?? 0),
  };
}

/** Custo acumulado por mes — a evolucao da obra ao longo do tempo. */
export async function custosPorMes(
  db: Database,
  tenantId: string,
  filtro: { obraId?: string } & Periodo = {},
) {
  const cond = [eq(custos.tenantId, tenantId), isNull(custos.deletedAt)];
  if (filtro.obraId) cond.push(eq(custos.obraId, filtro.obraId));
  if (filtro.de) cond.push(gte(custos.data, filtro.de) as never);
  if (filtro.ate) cond.push(lte(custos.data, filtro.ate) as never);

  const r = await db
    .select({
      mes: sql<string>`to_char(${custos.data}, 'YYYY-MM')`,
      tipo: custos.tipo,
      total: sql<string>`coalesce(sum(${custos.valor} * ${custos.taxaCambio}), 0)`,
      n: count(),
    })
    .from(custos)
    .where(and(...cond))
    .groupBy(sql`to_char(${custos.data}, 'YYYY-MM')`, custos.tipo)
    .orderBy(sql`to_char(${custos.data}, 'YYYY-MM')`);

  const porMes = new Map<string, { mes: string; total: number; porTipo: Record<string, number> }>();
  for (const l of r) {
    const v = arred2(paraNum(l.total));
    const registo = porMes.get(l.mes) ?? { mes: l.mes, total: 0, porTipo: {} };
    registo.total = arred2(registo.total + v);
    registo.porTipo[l.tipo] = arred2((registo.porTipo[l.tipo] ?? 0) + v);
    porMes.set(l.mes, registo);
  }

  return [...porMes.values()];
}

/**
 * Consumo do orcamento por rubrica, com o executado ao lado do previsto.
 *
 * E o relatorio que responde "em que rubrica e que a obra a gastar demais".
 * O previsto vem do somatorio das barras do orcamento; o executado vem dos
 * custos que apontam para esse item. Itens sem custos aparecem com zero, para
 * que uma rubrica ainda nao tocada nao desapareca do relatorio.
 */
export async function orcemPorRubrica(db: Database, tenantId: string, obraId: string) {
  const r = await db
    .select({
      id: orcamentoItens.id,
      capitulo: orcamentoItens.capitulo,
      descricao: orcamentoItens.descricao,
      unidade: orcamentoItens.unidade,
      quantidade: orcamentoItens.quantidade,
      precoUnitario: orcamentoItens.precoUnitario,
      totalOrcado: orcamentoItens.totalOrcado,
      custoReal: sql<string>`coalesce((SELECT sum(${custos.valor} * ${custos.taxaCambio})
                                          FROM ${custos}
                                         WHERE ${custos.orcamentoItemId} = ${orcamentoItens.id}
                                           AND ${custos.deletedAt} IS NULL), 0)`,
    })
    .from(orcamentoItens)
    .where(and(eq(orcamentoItens.obraId, obraId), isNull(orcamentoItens.deletedAt)))
    .orderBy(orcamentoItens.ordem, orcamentoItens.id);

  return r.map((i) => {
    const previsto = paraNum(i.totalOrcado);
    const executado = arred2(paraNum(i.custoReal));
    return {
      id: i.id,
      capitulo: i.capitulo,
      descricao: i.descricao,
      unidade: i.unidade,
      quantidade: i.quantidade,
      precoUnitario: i.precoUnitario,
      previsto: previsto.toFixed(2),
      executado: executado.toFixed(2),
      desvio: arred2(executado - previsto).toFixed(2),
      consumoPct: previsto > 0 ? arred2((executado / previsto) * 100).toFixed(2) : '0.00',
      // Acima de 100% desta rubrica e o sinal de que o preco unitario ou a
      // quantidade subestimados no orcamento.
      estourado: previsto > 0 && executado > previsto,
    };
  });
}

/**
 * produtividade por trabalhador: dias trabalhados, horas extra e custo gerado.
 *
 * O custo vem das folhas lancadas, nao das presencas: as presencas dizem onde
 * esteve, as folhas dizem quanto custou. Sao fontes diferentes e nao se
 * inventam numeros a partir da mais facil.
 */
export async function produtividade(db: Database, tenantId: string, periodo: Periodo = {}) {
  const cond = [eq(presencas.tenantId, tenantId), isNull(presencas.deletedAt)];
  if (periodo.de) cond.push(gte(presencas.data, periodo.de) as never);
  if (periodo.ate) cond.push(lte(presencas.data, periodo.ate) as never);

  const presencasPorTrabalhador = await db
    .select({
      trabalhadorId: presencas.trabalhadorId,
      // Uma presenca e um dia inteiro; as horas do dia entram em `horas_extra`.
      dias: count(),
      horasExtra: sql<string>`coalesce(sum(${presencas.horasExtra}), 0)`,
    })
    .from(presencas)
    .where(and(...cond))
    .groupBy(presencas.trabalhadorId);

  const condFolha = [eq(folhasSalario.tenantId, tenantId), isNull(folhasSalario.deletedAt)];
  if (periodo.de) condFolha.push(gte(folhasSalario.periodoInicio, periodo.de) as never);
  if (periodo.ate) condFolha.push(lte(folhasSalario.periodoFim, periodo.ate) as never);

  const folhasPorTrabalhador = await db
    .select({
      trabalhadorId: folhasSalario.trabalhadorId,
      custo: sql<string>`coalesce(sum(${folhasSalario.valor}), 0)`,
      n: count(),
    })
    .from(folhasSalario)
    .where(and(...condFolha))
    .groupBy(folhasSalario.trabalhadorId);

  const ids = [...new Set([...presencasPorTrabalhador, ...folhasPorTrabalhador].map((x) => x.trabalhadorId))];
  if (ids.length === 0) return [];

  const pessoas = await db
    .select({ id: trabalhadores.id, nome: trabalhadores.nome, funcao: trabalhadores.funcao })
    .from(trabalhadores)
    .where(and(eq(trabalhadores.tenantId, tenantId), isNull(trabalhadores.deletedAt)));

  const nomePorId = new Map(pessoas.map((p) => [p.id, p]));
  const presPorId = new Map(presencasPorTrabalhador.map((p) => [p.trabalhadorId, p]));
  const folhaPorId = new Map(folhasPorTrabalhador.map((f) => [f.trabalhadorId, f]));

  return ids.map((id) => {
    const p = presPorId.get(id);
    const f = folhaPorId.get(id);
    const dias = Number(p?.dias ?? 0);
    const custo = arred2(paraNum(f?.custo));
    return {
      trabalhadorId: id,
      nome: nomePorId.get(id)?.nome ?? '(desconhecido)',
      funcao: nomePorId.get(id)?.funcao ?? null,
      dias,
      horasExtra: arred2(paraNum(p?.horasExtra)),
      custoFolhas: custo.toFixed(2),
      // Custo medio por dia presente: e o que permite comparar quem ganha
      // mais e quem custa mais, seja diarista ou efectivo.
      custoPorDia: dias > 0 ? arred2(custo / dias).toFixed(2) : '0.00',
      folhas: Number(f?.n ?? 0),
    };
  }).sort((a, b) => paraNum(b.custoFolhas) - paraNum(a.custoFolhas));
}

/** Ponto do mes por obra: quantas pessoas trabalharam em cada obra. */
export async function presencasPorObra(db: Database, tenantId: string, periodo: Periodo = {}) {
  const cond = [eq(presencas.tenantId, tenantId), isNull(presencas.deletedAt)];
  if (periodo.de) cond.push(gte(presencas.data, periodo.de) as never);
  if (periodo.ate) cond.push(lte(presencas.data, periodo.ate) as never);

  return db
    .select({
      obraId: presencas.obraId,
      codigo: obras.codigo,
      obra: obras.nome,
      dias: count(),
      pessoas: sql<number>`count(distinct ${presencas.trabalhadorId})`,
      horasExtra: sql<string>`coalesce(sum(${presencas.horasExtra}), 0)`,
    })
    .from(presencas)
    .innerJoin(obras, eq(obras.id, presencas.obraId))
    .where(and(...cond))
    .groupBy(presencas.obraId, obras.codigo, obras.nome)
    .orderBy(desc(obras.codigo));
}

/** Como o dinheiro saiu: por metodo e por tipo de beneficiario. */
export async function mapaPagamentos(db: Database, tenantId: string, periodo: Periodo = {}) {
  const cond = [
    eq(pagamentos.tenantId, tenantId),
    isNull(pagamentos.deletedAt),
    sql`${pagamentos.estado} <> 'anulado'`,
  ];
  if (periodo.de) cond.push(gte(pagamentos.pagoEm, new Date(`${periodo.de}T00:00:00Z`)) as never);
  if (periodo.ate) cond.push(lte(pagamentos.pagoEm, new Date(`${periodo.ate}T23:59:59Z`)) as never);

  const linhas = await db
    .select({
      metodo: pagamentos.metodo,
      tipo: pagamentos.beneficiarioTipo,
      moeda: pagamentos.moeda,
      soma: sql<string>`coalesce(sum(${pagamentos.valor} * ${pagamentos.taxaCambio}), 0)`,
      n: count(),
    })
    .from(pagamentos)
    .where(and(...cond))
    .groupBy(pagamentos.metodo, pagamentos.beneficiarioTipo, pagamentos.moeda);

  return linhas.map((l) => ({
    metodo: l.metodo,
    beneficiario: l.tipo,
    moeda: l.moeda,
    total: arred2(paraNum(l.soma)).toFixed(2),
    n: Number(l.n),
  }));
}

/** Estado do armazem: quantos materiais estao abaixo do minimo. */
export async function alertasArmazem(db: Database, tenantId: string) {
  return db.execute<{
    material_id: string;
    nome: string;
    unidade: string;
    stock_minimo: string;
    saldo_total: string;
    obra_id: string | null;
    obra_codigo: string | null;
    obra_nome: string | null;
  }>(sql`
    SELECT m.id AS material_id, m.nome, m.unidade, m.stock_minimo,
           coalesce(sum(v.saldo), 0) AS saldo_total,
           v.obra_id, o.codigo AS obra_codigo, o.nome AS obra_nome
      FROM materiais m
      LEFT JOIN v_stock_actual v
             ON v.material_id = m.id
            AND v.tenant_id = m.tenant_id
            AND v.saldo > 0
      LEFT JOIN obras o ON o.id = v.obra_id
     WHERE m.tenant_id = ${tenantId}
       AND m.deleted_at IS NULL
     GROUP BY m.id, v.obra_id, o.codigo, o.nome
    HAVING coalesce(sum(v.saldo), 0) <= m.stock_minimo
    ORDER BY (coalesce(sum(v.saldo), 0) - m.stock_minimo) ASC`);
}

/** Requisicoes que estao paradas ha mais tempo — a fila do que trava a obra. */
export async function requisicoesParadas(db: Database, tenantId: string) {
  const linhas = await db
    .select({
      id: requisicoes.id,
      codigo: requisicoes.codigo,
      estado: requisicoes.estado,
      obraId: requisicoes.obraId,
      obraCodigo: obras.codigo,
      criadoEm: requisicoes.criadoEm,
      pendente: sql<string>`coalesce((SELECT quantidade_pendente FROM v_requicao_pendente p
                                        WHERE p.requisicao_id = ${requisicoes.id}), 0)`,
    })
    .from(requisicoes)
    .innerJoin(obras, eq(obras.id, requisicoes.obraId))
    .where(and(eq(requisicoes.tenantId, tenantId), isNull(requisicoes.deletedAt)))
    .orderBy(requisicoes.criadoEm);

  const agora = Date.now();
  return linhas
    .filter((l) => l.estado === 'pendente' || paraNum(l.pendente) > 0)
    .map((l) => ({
      ...l,
      diasParada: Math.floor((agora - new Date(l.criadoEm).getTime()) / 86_400_000),
      pendente: arred2(paraNum(l.pendente)).toFixed(2),
    }))
    .sort((a, b) => b.diasParada - a.diasParada);
}

/** Entradas de diario por obra e mes — evidencia de execucao. */
export async function producaoMensal(db: Database, tenantId: string, periodo: Periodo = {}) {
  const cond = [eq(diarioObra.tenantId, tenantId), isNull(diarioObra.deletedAt)];
  if (periodo.de) cond.push(gte(diarioObra.data, periodo.de) as never);
  if (periodo.ate) cond.push(lte(diarioObra.data, periodo.ate) as never);

  return db
    .select({
      mes: sql<string>`to_char(${diarioObra.data}, 'YYYY-MM')`,
      obraId: diarioObra.obraId,
      codigo: obras.codigo,
      entradas: count(),
      progresso: sql<string>`max(${diarioObra.progressoPct})`,
    })
    .from(diarioObra)
    .innerJoin(obras, eq(obras.id, diarioObra.obraId))
    .where(and(...cond))
    .groupBy(sql`to_char(${diarioObra.data}, 'YYYY-MM')`, diarioObra.obraId, obras.codigo)
    .orderBy(sql`to_char(${diarioObra.data}, 'YYYY-MM')`);
}

/** Materiais mais consumidos — o que se compra com mais frequencia. */
export async function materiaisMaisConsumidos(db: Database, tenantId: string, periodo: Periodo = {}) {
  const r = await db.execute<{ material_id: string; nome: string; unidade: string; consumido: string; custo: string }>(sql`
    SELECT m.id AS material_id, m.nome, m.unidade,
           sum(CASE WHEN sm.tipo IN ('saida','transferencia') THEN sm.quantidade
                    WHEN sm.tipo = 'ajuste' THEN -sm.quantidade ELSE 0 END) AS consumido,
           coalesce(sum(CASE WHEN sm.tipo = 'saida' THEN sm.quantidade * coalesce(cm.custo_medio, 0) ELSE 0 END), 0) AS custo
      FROM materiais m
      JOIN v_stock_actual v ON v.material_id = m.id AND v.tenant_id = m.tenant_id
      LEFT JOIN v_custo_medio cm ON cm.material_id = m.id AND cm.tenant_id = m.tenant_id
      LEFT JOIN stock_movimentos sm
             ON sm.material_id = m.id
            AND sm.tenant_id = m.tenant_id
            AND sm.deleted_at IS NULL
            AND (${periodo.de ?? '1900-01-01'}::date IS NULL OR sm.data::date >= ${periodo.de ?? '1900-01-01'}::date)
            AND (${periodo.ate ?? '2999-12-31'}::date IS NULL OR sm.data::date <= ${periodo.ate ?? '2999-12-31'}::date)
     WHERE m.tenant_id = ${tenantId}
       AND m.deleted_at IS NULL
     GROUP BY m.id
     HAVING sum(CASE WHEN sm.tipo IN ('saida','transferencia') THEN sm.quantidade
                      WHEN sm.tipo = 'ajuste' THEN -sm.quantidade ELSE 0 END) > 0
     ORDER BY consumido DESC
     LIMIT 20`);

  return (r.rows ?? []).map((x) => ({
    materialId: x.material_id,
    nome: x.nome,
    unidade: x.unidade,
    consumido: arred2(paraNum(x.consumido)).toFixed(3),
    custo: arred2(paraNum(x.custo)).toFixed(2),
  }));
}


