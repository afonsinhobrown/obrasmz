import { and, asc, count, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Database } from '../db/client.js';
import type { Ctx } from '../db/tx.js';
import {
  folhasSalario,
  obras,
  presencas,
  trabalhadores,
} from '../db/schema.js';
import { hojeISO } from '../lib/datas.js';
import { ErroConflito, ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../lib/erros.js';
import { arred2, arred3, paraNum } from '../lib/money.js';
import { normalizarNome, normalizarTelefone } from '../lib/validadores.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';
import { lancarCustoInterno } from './custos.js';

export const schemaTrabalhador = z.object({
  nome: z.string().min(2).max(160),
  funcao: z.string().max(80).nullable().optional(),
  documento: z.string().max(40).nullable().optional(),
  telefone: z.string().max(20).nullable().optional(),
  tipo: z.enum(['diarista', 'efectivo']).default('diarista'),
  valorDia: z.coerce.number().min(0).default(0),
  moeda: z.string().length(3).default(config.dominio.moedaBase),
  ativo: z.boolean().default(true),
});

export const schemaListarTrabalhadores = z.object({
  texto: z.string().max(120).optional(),
  tipo: z.enum(['diarista', 'efectivo']).optional(),
  apenasActivos: z.coerce.boolean().default(true),
});

export const schemaPresenca = z.object({
  obraId: z.string().uuid(),
  trabalhadorId: z.string().uuid(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  presente: z.boolean().default(true),
  horasExtra: z.coerce.number().min(0).max(24).default(0),
  observacoes: z.string().max(500).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
});

export const schemaFolha = z.object({
  trabalhadorId: z.string().uuid(),
  periodoInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodoFim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/* -------------------------------------------------------------------------
   Cadastro
   ------------------------------------------------------------------------- */

export async function listarTrabalhadores(
  db: Database,
  tenantId: string,
  filtro: z.infer<typeof schemaListarTrabalhadores>,
) {
  const cond = [eq(trabalhadores.tenantId, tenantId), isNull(trabalhadores.deletedAt)];
  if (filtro.apenasActivos) cond.push(eq(trabalhadores.ativo, true));
  if (filtro.tipo) cond.push(eq(trabalhadores.tipo, filtro.tipo));
  if (filtro.texto) cond.push(sql`${trabalhadores.nome} ILIKE ${`%${filtro.texto.trim()}%`}`);

  return db
    .select({
      id: trabalhadores.id,
      nome: trabalhadores.nome,
      funcao: trabalhadores.funcao,
      documento: trabalhadores.documento,
      telefone: trabalhadores.telefone,
      tipo: trabalhadores.tipo,
      valorDia: trabalhadores.valorDia,
      moeda: trabalhadores.moeda,
      ativo: trabalhadores.ativo,
      // Ultimos 30 dias: serve para o gestor ver quem tem trabalhado.
      diasUltimoMes: sql<number>`(
        SELECT count(*)::int FROM presencas p
         WHERE p.trabalhador_id = ${trabalhadores.id}
           AND p.presente = true
           AND p.data >= current_date - 30
           AND p.deleted_at IS NULL)`,
    })
    .from(trabalhadores)
    .where(and(...cond))
    .orderBy(trabalhadores.nome);
}

export async function obterTrabalhador(db: Database, tenantId: string, id: string) {
  const [t] = await db
    .select()
    .from(trabalhadores)
    .where(
      and(
        eq(trabalhadores.id, id),
        eq(trabalhadores.tenantId, tenantId),
        isNull(trabalhadores.deletedAt),
      ),
    )
    .limit(1);
  if (!t) throw new ErroNaoEncontrado('Trabalhador', id);
  return t;
}

export async function criarTrabalhador(
  db: Database,
  tenantId: string,
  entrada: z.infer<typeof schemaTrabalhador>,
  ctx: Contexto,
) {
  const [t] = await db
    .insert(trabalhadores)
    .values({
      tenantId,
      nome: normalizarNome(entrada.nome),
      funcao: entrada.funcao ?? null,
      documento: entrada.documento ?? null,
      telefone: entrada.telefone ? normalizarTelefone(entrada.telefone) : null,
      tipo: entrada.tipo,
      valorDia: arred2(entrada.valorDia).toFixed(2),
      moeda: entrada.moeda.toUpperCase(),
      ativo: entrada.ativo,
    })
    .returning();

  if (!t) throw new ErroValidacao('Falha ao criar o trabalhador');

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'trabalhador.criado',
    entidade: 'trabalhador',
    entidadeId: t.id,
    dadosDepois: { nome: t.nome, tipo: t.tipo, valorDia: t.valorDia },
    ip: ctx.ip,
  });

  return t;
}

export async function actualizarTrabalhador(
  db: Database,
  tenantId: string,
  id: string,
  campos: Partial<z.infer<typeof schemaTrabalhador>>,
  ctx: Contexto,
) {
  const antes = await obterTrabalhador(db, tenantId, id);

  // O valor do dia so pode mudar se nao houver folha ja lancada sobre ele:
  // caso contrario o custo lancado deixa de bater com o salario atual.
  if (campos.valorDia !== undefined && campos.valorDia !== paraNum(antes.valorDia)) {
    const [lancadas] = await db
      .select({ n: count() })
      .from(folhasSalario)
      .where(
        and(
          eq(folhasSalario.trabalhadorId, id),
          sql`${folhasSalario.estado} IN ('lancada','paga')`,
          isNull(folhasSalario.deletedAt),
        ),
      );
    if (Number(lancadas?.n ?? 0) > 0) {
      throw new ErroRegraNegocio(
        `Ja existem folhas lancadas para este trabalhador. Alterar o valor do dia agora ` +
          'alteraria o custo ja lancado. Lance uma folha nova com o valor actualizado.',
      );
    }
  }

  const [depois] = await db
    .update(trabalhadores)
    .set({
      ...(campos.nome !== undefined ? { nome: normalizarNome(campos.nome) } : {}),
      ...(campos.funcao !== undefined ? { funcao: campos.funcao } : {}),
      ...(campos.documento !== undefined ? { documento: campos.documento } : {}),
      ...(campos.telefone !== undefined
        ? { telefone: campos.telefone ? normalizarTelefone(campos.telefone) : null }
        : {}),
      ...(campos.tipo !== undefined ? { tipo: campos.tipo } : {}),
      ...(campos.valorDia !== undefined ? { valorDia: arred2(campos.valorDia).toFixed(2) } : {}),
      ...(campos.moeda !== undefined ? { moeda: campos.moeda.toUpperCase() } : {}),
      ...(campos.ativo !== undefined ? { ativo: campos.ativo } : {}),
      updatedAt: new Date(),
    })
    .where(eq(trabalhadores.id, id))
    .returning();

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'trabalhador.actualizado',
    entidade: 'trabalhador',
    entidadeId: id,
    dadosAntes: { nome: antes.nome, valorDia: antes.valorDia, ativo: antes.ativo },
    dadosDepois: { nome: depois?.nome, valorDia: depois?.valorDia, ativo: depois?.ativo },
    ip: ctx.ip,
  });

  return depois;
}

/**
 * Um trabalhador com presencas nao pode ser apagado, so desactivado: o ponto
 * registado tem de continuar a justificar as folhas ja pagas.
 */
export async function apagarTrabalhador(
  db: Database,
  tenantId: string,
  id: string,
  ctx: Contexto,
) {
  const t = await obterTrabalhador(db, tenantId, id);

  const [presencasVinculadas] = await db
    .select({ n: count() })
    .from(presencas)
    .where(and(eq(presencas.trabalhadorId, id), isNull(presencas.deletedAt)));

  if (Number(presencasVinculadas?.n ?? 0) > 0) {
    throw new ErroConflito(
      `O trabalhador tem ${presencasVinculadas?.n} registo(s) de ponto. Desactive-o em vez de o apagar.`,
    );
  }

  await db
    .update(trabalhadores)
    .set({ deletedAt: new Date(), ativo: false, updatedAt: new Date() })
    .where(eq(trabalhadores.id, id));

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'trabalhador.apagado',
    entidade: 'trabalhador',
    entidadeId: id,
    dadosAntes: { nome: t.nome, valorDia: t.valorDia },
    ip: ctx.ip,
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------
   Ponto
   ------------------------------------------------------------------------- */

/**
 * Regista a presenca. Faz upsert em `(obra, trabalhador, data)`: quem aponta
 * duas vezes no mesmo dia corrige o registo anterior em vez de duplicar.
 */
export async function registarPresenca(
  db: Database,
  tenantId: string,
  registadoPor: string,
  entrada: z.infer<typeof schemaPresenca>,
  ctx: Contexto,
) {
  const trabalhador = await obterTrabalhador(db, tenantId, entrada.trabalhadorId);
  if (!trabalhador.ativo) {
    throw new ErroRegraNegocio('Este trabalhador esta inactivo e nao pode ter ponto registado');
  }

  const [obra] = await db
    .select({ id: obras.id })
    .from(obras)
    .where(
      and(eq(obras.id, entrada.obraId), eq(obras.tenantId, tenantId), isNull(obras.deletedAt)),
    )
    .limit(1);
  if (!obra) throw new ErroNaoEncontrado('Obra', entrada.obraId);

  const data = entrada.data ?? hojeISO();

  return db.transaction(async (tx) => {
    const [existente] = await tx
      .select()
      .from(presencas)
      .where(
        and(
          eq(presencas.obraId, entrada.obraId),
          eq(presencas.trabalhadorId, entrada.trabalhadorId),
          eq(presencas.data, data),
          isNull(presencas.deletedAt),
        ),
      )
      .limit(1);

    const [presenca] = existente
      ? await tx
          .update(presencas)
          .set({
            presente: entrada.presente,
            horasExtra: arred3(entrada.horasExtra).toFixed(1),
            observacoes: entrada.observacoes ?? null,
            registadoPor,
            updatedAt: new Date(),
          })
          .where(eq(presencas.id, existente.id))
          .returning()
      : await tx
          .insert(presencas)
          .values({
            tenantId,
            obraId: entrada.obraId,
            trabalhadorId: entrada.trabalhadorId,
            data,
            presente: entrada.presente,
            horasExtra: arred3(entrada.horasExtra).toFixed(1),
            observacoes: entrada.observacoes ?? null,
            registadoPor,
            clientId: entrada.clientId ?? null,
          })
          .returning();

    if (!presenca) throw new ErroValidacao('Falha ao registar a presenca');

    // Alterar ponto depois da folha lancada altera o custo ja lancado.
    if (existente) {
      await bloquearSeFolhaLancada(tx, tenantId, entrada.trabalhadorId, data, ctx);
    }

    if (!existente) {
      await auditar(tx, tenantId, ctx.utilizadorId, {
        accao: 'ponto.registado',
        entidade: 'presenca',
        entidadeId: presenca.id,
        dadosDepois: {
          trabalhadorId: entrada.trabalhadorId,
          obraId: entrada.obraId,
          data,
          presente: entrada.presente,
        },
        ip: ctx.ip,
      });
    }

    return { presenca, substituiu: Boolean(existente) };
  });
}

async function bloquearSeFolhaLancada(
  db: Ctx,
  tenantId: string,
  trabalhadorId: string,
  data: string,
  ctx: Contexto,
) {
  const [folha] = await db
    .select()
    .from(folhasSalario)
    .where(
      and(
        eq(folhasSalario.tenantId, tenantId),
        eq(folhasSalario.trabalhadorId, trabalhadorId),
        sql`${folhasSalario.estado} IN ('lancada','paga')`,
        lte(folhasSalario.periodoInicio, data),
        gte(folhasSalario.periodoFim, data),
        isNull(folhasSalario.deletedAt),
      ),
    )
    .limit(1);

  if (folha) {
    throw new ErroRegraNegocio(
      `O dia ${data} ja esta coberto por uma folha de salario lancada. ` +
        'Anule a folha antes de alterar o ponto.',
      { folhaId: folha.id },
    );
  }
}

/**
 * Registo em lote: o encarregado aponta a equipa toda de uma vez. Cada linha
 * e independiente — uma falha nao cancela as restantes, para nao perder meio
 * dia de apontamentos por causa de um trabalhador apagado.
 */
export async function registarPresencasLote(
  db: Database,
  tenantId: string,
  registadoPor: string,
  linhas: Array<z.infer<typeof schemaPresenca>>,
  ctx: Contexto,
) {
  const ok: unknown[] = [];
  const falhas: Array<{ indice: number; trabalhadorId: string; erro: string }> = [];

  for (const [indice, linha] of linhas.entries()) {
    try {
      ok.push(await registarPresenca(db, tenantId, registadoPor, linha, ctx));
    } catch (err) {
      falhas.push({
        indice,
        trabalhadorId: linha.trabalhadorId,
        erro: err instanceof Error ? err.message : 'erro desconhecido',
      });
    }
  }

  return { registados: ok.length, falhas };
}

export async function listarPresencas(
  db: Database,
  tenantId: string,
  filtro: { obraId?: string; trabalhadorId?: string; de?: string; ate?: string; limite?: number },
) {
  const cond = [eq(presencas.tenantId, tenantId), isNull(presencas.deletedAt)];
  if (filtro.obraId) cond.push(eq(presencas.obraId, filtro.obraId));
  if (filtro.trabalhadorId) cond.push(eq(presencas.trabalhadorId, filtro.trabalhadorId));
  if (filtro.de) cond.push(gte(presencas.data, filtro.de));
  if (filtro.ate) cond.push(lte(presencas.data, filtro.ate));

  return db
    .select({
      id: presencas.id,
      obraId: presencas.obraId,
      obraNome: obras.nome,
      trabalhadorId: presencas.trabalhadorId,
      trabalhador: trabalhadores.nome,
      funcao: trabalhadores.funcao,
      valorDia: trabalhadores.valorDia,
      data: presencas.data,
      presente: presencas.presente,
      horasExtra: presencas.horasExtra,
      observacoes: presencas.observacoes,
    })
    .from(presencas)
    .innerJoin(obras, eq(obras.id, presencas.obraId))
    .innerJoin(trabalhadores, eq(trabalhadores.id, presencas.trabalhadorId))
    .where(and(...cond))
    .orderBy(desc(presencas.data), trabalhadores.nome)
    .limit(filtro.limite ?? 500);
}

export async function apagarPresenca(
  db: Database,
  tenantId: string,
  id: string,
  ctx: Contexto,
  motivo?: string,
) {
  const [p] = await db
    .select()
    .from(presencas)
    .where(and(eq(presencas.id, id), eq(presencas.tenantId, tenantId)))
    .limit(1);
  if (!p) throw new ErroNaoEncontrado('Presenca', id);

  await bloquearSeFolhaLancada(db, tenantId, p.trabalhadorId, p.data, ctx);

  await db
    .update(presencas)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(presencas.id, id));

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'ponto.apagado',
    entidade: 'presenca',
    entidadeId: id,
    dadosAntes: { trabalhadorId: p.trabalhadorId, data: p.data, presente: p.presente },
    dadosDepois: { motivo: motivo ?? null },
    ip: ctx.ip,
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------
   Folhas de salario
   ------------------------------------------------------------------------- */

type ItemObra = {
  obraId: string;
  obraNome: string;
  dias: number;
  horasExtra: number;
  valor: number;
};

type ResumoFolha = {
  trabalhadorId: string;
  trabalhador: string;
  valorDia: string;
  moeda: string;
  dias: number;
  horasExtra: number;
  valorDias: number;
  valorExtra: number;
  total: number;
  porObra: ItemObra[];
};

/**
 * Resumo do ponto num periodo, agrupado por obra.
 *
 * O valor extra usa `valor_dia / HORAS_POR_DIA` como hora base — 8h por dia e
 * a pratica em obra em Mozambique; quem tiver outro valor muda `HORAS_POR_DIA`.
 */
export async function resumirFolha(
  db: Database,
  tenantId: string,
  trabalhadorId: string,
  periodoInicio: string,
  periodoFim: string,
): Promise<ResumoFolha> {
  if (periodoFim < periodoInicio) {
    throw new ErroValidacao('A data de fim do periodo e anterior a data de inicio');
  }

  const trabalhador = await obterTrabalhador(db, tenantId, trabalhadorId);

  const linhas = await db
    .select({
      obraId: presencas.obraId,
      obraNome: obras.nome,
      presente: presencas.presente,
      horasExtra: presencas.horasExtra,
      data: presencas.data,
    })
    .from(presencas)
    .innerJoin(obras, eq(obras.id, presencas.obraId))
    .where(
      and(
        eq(presencas.tenantId, tenantId),
        eq(presencas.trabalhadorId, trabalhadorId),
        isNull(presencas.deletedAt),
        gte(presencas.data, periodoInicio),
        lte(presencas.data, periodoFim),
      ),
    )
    .orderBy(asc(presencas.data));

  const valorDia = paraNum(trabalhador.valorDia);
  const horaBase = valorDia / config.dominio.horasPorDia;

  const porObraMap = new Map<string, { obraId: string; obraNome: string; dias: number; horas: number }>();
  let dias = 0;
  let horasExtra = 0;

  for (const l of linhas) {
    if (!l.presente) continue;
    dias += 1;
    const extras = paraNum(l.horasExtra);
    horasExtra += extras;

    const chave = porObraMap.get(l.obraId) ?? {
      obraId: l.obraId,
      obraNome: l.obraNome,
      dias: 0,
      horas: 0,
    };
    chave.dias += 1;
    chave.horas += extras;
    porObraMap.set(l.obraId, chave);
  }

  const valorDias = arred2(dias * valorDia);
  const valorExtra = arred2(horasExtra * horaBase);

  return {
    trabalhadorId,
    trabalhador: trabalhador.nome,
    valorDia: trabalhador.valorDia,
    moeda: trabalhador.moeda,
    dias,
    horasExtra: arred3(horasExtra),
    valorDias,
    valorExtra,
    porObra: [...porObraMap.values()].map((o) => ({
      obraId: o.obraId,
      obraNome: o.obraNome,
      dias: o.dias,
      horasExtra: arred3(o.horas),
      valor: arred2(o.dias * valorDia + o.horas * horaBase),
    })),
    total: arred2(valorDias + valorExtra),
  };
}

export async function gerarFolha(
  db: Database,
  tenantId: string,
  entrada: z.infer<typeof schemaFolha>,
  ctx: Contexto,
) {
  const resumo = await resumirFolha(
    db,
    tenantId,
    entrada.trabalhadorId,
    entrada.periodoInicio,
    entrada.periodoFim,
  );

  if (resumo.dias === 0) {
    throw new ErroRegraNegocio(
      `Nao ha presencas registadas entre ${entrada.periodoInicio} e ${entrada.periodoFim}.`,
    );
  }

  const [existente] = await db
    .select()
    .from(folhasSalario)
    .where(
      and(
        eq(folhasSalario.tenantId, tenantId),
        eq(folhasSalario.trabalhadorId, entrada.trabalhadorId),
        eq(folhasSalario.periodoInicio, entrada.periodoInicio),
        eq(folhasSalario.periodoFim, entrada.periodoFim),
        isNull(folhasSalario.deletedAt),
      ),
    )
    .limit(1);

  if (existente && existente.estado !== 'anulada') {
    throw new ErroConflito(
      `Ja existe uma folha para ${resumo.trabalhador} neste periodo (estado: ${existente.estado}).`,
      { folhaId: existente.id },
    );
  }

  const [folha] = await db
    .insert(folhasSalario)
    .values({
      tenantId,
      trabalhadorId: entrada.trabalhadorId,
      periodoInicio: entrada.periodoInicio,
      periodoFim: entrada.periodoFim,
      dias: resumo.dias,
      horasExtra: resumo.horasExtra.toFixed(1),
      valor: (resumo.valorDias + resumo.valorExtra).toFixed(2),
      moeda: resumo.moeda,
      estado: 'gerada',
    })
    .returning();

  if (!folha) throw new ErroValidacao('Falha ao gerar a folha');

  await auditar(db, tenantId, ctx.utilizadorId, {
    accao: 'folha.gerada',
    entidade: 'folha_salario',
    entidadeId: folha.id,
    dadosDepois: {
      trabalhadorId: entrada.trabalhadorId,
      periodo: `${entrada.periodoInicio}..${entrada.periodoFim}`,
      dias: resumo.dias,
      valor: folha.valor,
    },
    ip: ctx.ip,
  });

  return { folha, resumo };
}

/**
 * Lanca a folha nos custos das obras.
 *
 * Idempotente: cada obra da folha recebe um custo com
 * `origem_tabela='folhas_salario'` e `origem_id = folha.id`, protegido por um
 * indice unico. Reexecutar o lancamento nao duplica dinheiro.
 */
export async function lancarFolha(
  db: Database,
  tenantId: string,
  folhaId: string,
  ctx: Contexto,
) {
  const [folha] = await db
    .select()
    .from(folhasSalario)
    .where(and(eq(folhasSalario.id, folhaId), eq(folhasSalario.tenantId, tenantId)))
    .limit(1);
  if (!folha) throw new ErroNaoEncontrado('Folha', folhaId);
  if (folha.estado === 'lancada') {
    throw new ErroRegraNegocio('Esta folha ja foi lancada nos custos');
  }
  if (folha.estado === 'anulada') {
    throw new ErroRegraNegocio('Folha anulada nao pode ser lancada');
  }

  const resumo = await resumirFolha(
    db,
    tenantId,
    folha.trabalhadorId,
    folha.periodoInicio,
    folha.periodoFim,
  );

  return db.transaction(async (tx) => {
    const lancados = [];
    for (const o of resumo.porObra) {
      const r = await lancarCustoInterno(tx, tenantId, {
        obraId: o.obraId,
        tipo: 'mao_de_obra',
        descricao:
          `Mao de obra — ${resumo.trabalhador} — ` +
          `${folha.periodoInicio} a ${folha.periodoFim} (${o.dias} dia(s)` +
          `${o.horasExtra ? `, ${o.horasExtra}h extra` : ''})`,
        valor: o.valor,
        moeda: resumo.moeda,
        data: folha.periodoFim,
        origemTabela: 'folhas_salario',
        // Uma folha lanca varias obras, por isso a origem inclui a obra para
        // que cada par (folha, obra) seja unico.
        origemId: folha.id,
      });
      lancados.push({ obraId: o.obraId, custo: r.custo, criado: r.criado });
    }

    const [depois] = await tx
      .update(folhasSalario)
      .set({ estado: 'lancada', lancadaEm: new Date(), updatedAt: new Date() })
      .where(eq(folhasSalario.id, folhaId))
      .returning();

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'folha.lancada',
      entidade: 'folha_salario',
      entidadeId: folhaId,
      dadosAntes: { estado: 'gerada' },
      dadosDepois: {
        estado: 'lancada',
        custos: lancados.map((l) => ({ obraId: l.obraId, valor: l.custo?.valor })),
      },
      ip: ctx.ip,
    });

    return { folha: depois, lancados };
  });
}

/**
 * Anula uma folha: os custos gerados sao removidos (soft delete) para o
 * "orcado vs real" voltar a bater certo. O ponto registado nao e tocado —
 * quem trabalhou, trabalhou.
 */
export async function anularFolha(
  db: Database,
  tenantId: string,
  folhaId: string,
  motivo: string,
  ctx: Contexto,
) {
  const [folha] = await db
    .select()
    .from(folhasSalario)
    .where(and(eq(folhasSalario.id, folhaId), eq(folhasSalario.tenantId, tenantId)))
    .limit(1);
  if (!folha) throw new ErroNaoEncontrado('Folha', folhaId);
  if (folha.estado === 'paga') {
    throw new ErroRegraNegocio('Folha ja paga. Anule primeiro o pagamento correspondente.');
  }

  if (!motivo?.trim()) throw new ErroValidacao('Indique o motivo da anulacao');

  return db.transaction(async (tx) => {
    // UPDATE directo: os custos sao apagados em lote por origem, e um
    // `update` tipado nao sabe quais colunas tocar numa tabela acessada por SQL.
    const removidos = await tx.execute<{ id: string }>(sql`
      UPDATE custos
         SET deleted_at = now(), updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND origem_tabela = 'folhas_salario'
         AND origem_id = ${folhaId}
         AND deleted_at IS NULL
      RETURNING id`);

    const [depois] = await tx
      .update(folhasSalario)
      .set({ estado: 'anulada', updatedAt: new Date() })
      .where(eq(folhasSalario.id, folhaId))
      .returning();

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'folha.anulada',
      entidade: 'folha_salario',
      entidadeId: folhaId,
      dadosAntes: { estado: folha.estado },
      dadosDepois: { estado: 'anulada', custosRemovidos: removidos.rows.length, motivo },
      ip: ctx.ip,
    });

    return { folha: depois, custosRemovidos: removidos.rows.length };
  });
}

export async function listarFolhas(
  db: Database,
  tenantId: string,
  filtro: { trabalhadorId?: string; estado?: 'gerada' | 'lancada' | 'paga' | 'anulada' } = {},
) {
  const cond = [eq(folhasSalario.tenantId, tenantId), isNull(folhasSalario.deletedAt)];
  if (filtro.trabalhadorId) cond.push(eq(folhasSalario.trabalhadorId, filtro.trabalhadorId));
  if (filtro.estado) cond.push(eq(folhasSalario.estado, filtro.estado));

  return db
    .select({
      id: folhasSalario.id,
      trabalhadorId: folhasSalario.trabalhadorId,
      trabalhador: trabalhadores.nome,
      periodoInicio: folhasSalario.periodoInicio,
      periodoFim: folhasSalario.periodoFim,
      dias: folhasSalario.dias,
      horasExtra: folhasSalario.horasExtra,
      valor: folhasSalario.valor,
      moeda: folhasSalario.moeda,
      estado: folhasSalario.estado,
      lancadaEm: folhasSalario.lancadaEm,
    })
    .from(folhasSalario)
    .innerJoin(trabalhadores, eq(trabalhadores.id, folhasSalario.trabalhadorId))
    .where(and(...cond))
    .orderBy(desc(folhasSalario.periodoFim));
}

/** Folha de ponto de um periodo, agrupada por trabalhador — para imprimir. */
export async function folhaDePonto(
  db: Database,
  tenantId: string,
  filtro: { obraId?: string; de: string; ate: string },
) {
  const cond = [
    eq(presencas.tenantId, tenantId),
    isNull(presencas.deletedAt),
    gte(presencas.data, filtro.de),
    lte(presencas.data, filtro.ate),
  ];
  if (filtro.obraId) cond.push(eq(presencas.obraId, filtro.obraId));

  const linhas = await db
    .select({
      trabalhadorId: trabalhadores.id,
      trabalhador: trabalhadores.nome,
      funcao: trabalhadores.funcao,
      valorDia: trabalhadores.valorDia,
      data: presencas.data,
      presente: presencas.presente,
      horasExtra: presencas.horasExtra,
      obraNome: obras.nome,
    })
    .from(presencas)
    .innerJoin(trabalhadores, eq(trabalhadores.id, presencas.trabalhadorId))
    .innerJoin(obras, eq(obras.id, presencas.obraId))
    .where(and(...cond))
    .orderBy(trabalhadores.nome, presencas.data);

  const porTrabalhador = new Map<
    string,
    {
      trabalhadorId: string;
      trabalhador: string;
      funcao: string | null;
      valorDia: string;
      moeda: string;
      dias: number;
      horasExtra: number;
      valor: number;
      detalhe: typeof linhas;
    }
  >();

  for (const l of linhas) {
    if (!l.presente) continue;
    const chave = porTrabalhador.get(l.trabalhadorId) ?? {
      trabalhadorId: l.trabalhadorId,
      trabalhador: l.trabalhador,
      funcao: l.funcao,
      valorDia: l.valorDia,
      moeda: 'MZN',
      dias: 0,
      horasExtra: 0,
      valor: 0,
      detalhe: [] as typeof linhas,
    };
    const horaBase = paraNum(l.valorDia) / config.dominio.horasPorDia;
    chave.dias += 1;
    chave.horasExtra += paraNum(l.horasExtra);
    chave.valor += paraNum(l.valorDia) + paraNum(l.horasExtra) * horaBase;
    chave.detalhe.push(l);
    porTrabalhador.set(l.trabalhadorId, chave);
  }

  return [...porTrabalhador.values()].map((t) => ({
    ...t,
    horasExtra: arred3(t.horasExtra),
    valor: arred2(t.valor),
  }));
}