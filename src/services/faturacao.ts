import { and, count, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { faturaItens, faturas, tenants } from '../db/schema.js';
import type { Ctx } from '../db/tx.js';
import { arred2, paraNum } from '../lib/money.js';
import {
  ErroNaoEncontrado,
  ErroRegraNegocio,
  ErroValidacao,
} from '../lib/erros.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';
import { preverNumero, proximoNumero } from './numeracao.js';

/**
 * Faturacao fiscal.
 *
 * Modelo de totais (NUMERIC guardado como string):
 *   item.valor  = quantidade * precoUnitario - desconto da linha
 *   subtotal    = soma dos item.valor
 *   base        = subtotal - desconto (do documento)
 *   ivaValor    = base * ivaTaxa
 *   total       = base + ivaValor
 *
 * O IVA e aplicado ao documento (taxa unica). A numeração
 * e sequencial e atomica (FAT-2026-0001): o numero só e
 * consumido se a criacao tiver sucesso.
 */

const IVA_TAXA_PADRAO = 0.17;

const schemaItemFatura = z.object({
  descricao: z.string().min(1, 'Descreva o item'),
  quantidade: z.coerce
    .number()
    .positive('A quantidade tem de ser positiva')
    .default(1),
  precoUnitario: z.coerce
    .number()
    .min(0, 'O preco unitario nao pode ser negativo'),
  /** Desconto absoluto desta linha (em moeda). */
  desconto: z.coerce.number().min(0).default(0),
});

export const schemaFatura = z
  .object({
    clienteNome: z.string().min(1, 'Indique o nome do cliente'),
    clienteNuit: z.string().max(30).optional(),
    clienteEndereco: z.string().max(200).optional(),
    clienteTelefone: z.string().max(30).optional(),
    emitenteNome: z.string().max(100).optional(),
    emitenteNuit: z.string().max(30).optional(),
    emitenteEndereco: z.string().max(200).optional(),
    emitenteTelefone: z.string().max(30).optional(),
    obraId: z.string().uuid().optional(),
    serie: z.string().max(20).optional(),
    dataEmissao: z.string().datetime().optional(),
    dataVencimento: z.string().datetime().optional(),
    notas: z.string().max(500).optional(),
    /** Taxa de IVA do documento (ex.: 0.17 = 17%). */
    ivaTaxa: z.coerce.number().min(0).max(1).default(IVA_TAXA_PADRAO),
    /** Desconto absoluto do documento (em moeda). */
    desconto: z.coerce.number().min(0).default(0),
    itens: z
      .array(schemaItemFatura)
      .min(1, 'A fatura precisa de pelo menos um item'),
  })
  .superRefine((v, ctx) => {
    const subtotal = v.itens.reduce(
      (soma, i) => soma + i.quantidade * i.precoUnitario - i.desconto,
      0,
    );
    if (v.desconto > subtotal + 0.001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['desconto'],
        message: 'O desconto nao pode ser maior que o subtotal',
      });
    }
  });

export type Fatura = z.infer<typeof schemaFatura>;
export type ItemFatura = z.infer<typeof schemaItemFatura>;

/** Emitente por omissao: o tenant (nome e NUIT). */
async function emitenteDoTenant(db: Ctx, tenantId: string) {
  const [t] = await db
    .select({ nome: tenants.nome, nuit: tenants.nuit })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return { nome: t?.nome ?? null, nuit: t?.nuit ?? null };
}

export async function gerarFatura(
  db: Database,
  tenantId: string,
  entrada: Fatura,
  ctx: Contexto,
) {
  const emitente = await emitenteDoTenant(db, tenantId);
  const dataEmissao = entrada.dataEmissao
    ? new Date(entrada.dataEmissao)
    : new Date();

  return db.transaction(async (tx) => {
    // Numero sequencial atomico: so e consumido se a criacao
    // tiver sucesso (o INSERT ... ON CONFLICT ... RETURNING e
    // atomico e a transacao reverte o numero se falhar).
    const numero = await proximoNumero(tx, tenantId, 'FAT', dataEmissao);

    // Totais.
    let subtotal = 0;
    const itens = entrada.itens.map((item, ordem) => {
      const bruto = item.quantidade * item.precoUnitario;
      const valor = arred2(bruto - item.desconto);
      subtotal += valor;
      return {
        tenantId,
        descricao: item.descricao,
        quantidade: item.quantidade.toFixed(4),
        precoUnitario: arred2(item.precoUnitario).toFixed(2),
        desconto: arred2(item.desconto).toFixed(2),
        valor: valor.toFixed(2),
        ivaTaxa: entrada.ivaTaxa.toFixed(4),
        ordem,
      };
    });

    const subtotalArred = arred2(subtotal);
    const base = arred2(subtotalArred - entrada.desconto);
    if (base < 0) {
      throw new ErroValidacao(
        'O desconto nao pode ser maior que o subtotal.',
      );
    }
    const ivaValor = arred2(base * entrada.ivaTaxa);
    const total = arred2(base + ivaValor);

    const [fatura] = await tx
      .insert(faturas)
      .values({
        tenantId,
        numero,
        serie: entrada.serie ?? null,
        obraId: entrada.obraId ?? null,
        emitenteNome: entrada.emitenteNome ?? emitente.nome,
        emitenteNuit: entrada.emitenteNuit ?? emitente.nuit,
        emitenteEndereco: entrada.emitenteEndereco ?? null,
        emitenteTelefone: entrada.emitenteTelefone ?? null,
        clienteNome: entrada.clienteNome,
        clienteNuit: entrada.clienteNuit ?? null,
        clienteEndereco: entrada.clienteEndereco ?? null,
        clienteTelefone: entrada.clienteTelefone ?? null,
        moeda: 'MZN',
        subtotal: subtotalArred.toFixed(2),
        desconto: arred2(entrada.desconto).toFixed(2),
        ivaTaxa: entrada.ivaTaxa.toFixed(4),
        ivaValor: ivaValor.toFixed(2),
        total: total.toFixed(2),
        estado: 'emitida',
        dataEmissao,
        dataVencimento: entrada.dataVencimento
          ? new Date(entrada.dataVencimento)
          : null,
        notas: entrada.notas ?? null,
        registadoPor: ctx.utilizadorId,
      })
      .returning();
    if (!fatura) throw new ErroValidacao('Falha ao criar a fatura');

    if (itens.length > 0) {
      await tx.insert(faturaItens).values(
        itens.map((item) => ({ ...item, faturaId: fatura.id })),
      );
    }

    const itensCriados = await tx
      .select()
      .from(faturaItens)
      .where(eq(faturaItens.faturaId, fatura.id))
      .orderBy(faturaItens.ordem, faturaItens.id);

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'fatura.criada',
      entidade: 'fatura',
      entidadeId: fatura.id,
      dadosDepois: {
        numero: fatura.numero,
        cliente: entrada.clienteNome,
        subtotal: subtotalArred.toFixed(2),
        iva: ivaValor.toFixed(2),
        total: total.toFixed(2),
        nItens: itens.length,
      },
      ip: ctx.ip,
    });

    return { ...fatura, itens: itensCriados };
  });
}

export async function listarFaturas(
  db: Database,
  tenantId: string,
  filtro: {
    obraId?: string;
    estado?: 'emitida' | 'anulada' | 'paga';
    clienteNuit?: string;
    de?: string;
    ate?: string;
    limite?: number;
  } = {},
) {
  const cond = [eq(faturas.tenantId, tenantId), isNull(faturas.deletedAt)];
  if (filtro.obraId) cond.push(eq(faturas.obraId, filtro.obraId));
  if (filtro.estado) cond.push(eq(faturas.estado, filtro.estado));
  if (filtro.clienteNuit) cond.push(eq(faturas.clienteNuit, filtro.clienteNuit));
  if (filtro.de)
    cond.push(gte(faturas.dataEmissao, new Date(`${filtro.de}T00:00:00Z`)));
  if (filtro.ate)
    cond.push(lte(faturas.dataEmissao, new Date(`${filtro.ate}T23:59:59Z`)));

  const linhas = await db
    .select({
      id: faturas.id,
      numero: faturas.numero,
      serie: faturas.serie,
      obraId: faturas.obraId,
      clienteNome: faturas.clienteNome,
      clienteNuit: faturas.clienteNuit,
      subtotal: faturas.subtotal,
      desconto: faturas.desconto,
      ivaTaxa: faturas.ivaTaxa,
      ivaValor: faturas.ivaValor,
      total: faturas.total,
      moeda: faturas.moeda,
      estado: faturas.estado,
      dataEmissao: faturas.dataEmissao,
      dataVencimento: faturas.dataVencimento,
      nItens: count(),
    })
    .from(faturas)
    .leftJoin(faturaItens, eq(faturaItens.faturaId, faturas.id))
    .where(and(...cond))
    .groupBy(faturas.id)
    .orderBy(desc(faturas.dataEmissao), desc(faturas.id))
    .limit(filtro.limite ?? 100);

  return linhas;
}

export async function obterFatura(
  db: Database,
  tenantId: string,
  id: string,
) {
  const [f] = await db
    .select()
    .from(faturas)
    .where(and(eq(faturas.id, id), eq(faturas.tenantId, tenantId)))
    .limit(1);
  if (!f) throw new ErroNaoEncontrado('Fatura', id);

  const itens = await db
    .select()
    .from(faturaItens)
    .where(
      and(
        eq(faturaItens.faturaId, f.id),
        eq(faturaItens.tenantId, tenantId),
        isNull(faturaItens.deletedAt),
      ),
    )
    .orderBy(faturaItens.ordem, faturaItens.id);

  return { ...f, itens };
}

/** Anula uma fatura (soft, com motivo — nao se apaga: e documento fiscal). */
export async function anularFatura(
  db: Database,
  tenantId: string,
  id: string,
  motivo: string,
  ctx: Contexto,
) {
  if (!motivo?.trim()) {
    throw new ErroValidacao('Indique o motivo da anulacao');
  }
  const [antes] = await db
    .select({ id: faturas.id, estado: faturas.estado, numero: faturas.numero })
    .from(faturas)
    .where(and(eq(faturas.id, id), eq(faturas.tenantId, tenantId)))
    .limit(1);
  if (!antes) throw new ErroNaoEncontrado('Fatura', id);
  if (antes.estado === 'anulada') {
    throw new ErroRegraNegocio('Esta fatura ja esta anulada.');
  }

  return db.transaction(async (tx) => {
    const [depois] = await tx
      .update(faturas)
      .set({ estado: 'anulada', anuladoMotivo: motivo.trim(), updatedAt: new Date() })
      .where(eq(faturas.id, id))
      .returning();

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'fatura.anulada',
      entidade: 'fatura',
      entidadeId: id,
      dadosAntes: { estado: antes.estado, numero: antes.numero },
      dadosDepois: { estado: 'anulada', motivo: motivo.trim() },
      ip: ctx.ip,
    });

    return depois;
  });
}

/** Marca a fatura como paga (após recebimento). */
export async function marcarFaturaPaga(
  db: Database,
  tenantId: string,
  id: string,
  ctx: Contexto,
) {
  const [antes] = await db
    .select({ id: faturas.id, estado: faturas.estado, numero: faturas.numero })
    .from(faturas)
    .where(and(eq(faturas.id, id), eq(faturas.tenantId, tenantId)))
    .limit(1);
  if (!antes) throw new ErroNaoEncontrado('Fatura', id);
  if (antes.estado === 'anulada') {
    throw new ErroRegraNegocio('Nao se marca como paga uma fatura anulada.');
  }
  if (antes.estado === 'paga') return antes;

  return db.transaction(async (tx) => {
    const [depois] = await tx
      .update(faturas)
      .set({ estado: 'paga', updatedAt: new Date() })
      .where(eq(faturas.id, id))
      .returning();

    await auditar(tx, tenantId, ctx.utilizadorId, {
      accao: 'fatura.paga',
      entidade: 'fatura',
      entidadeId: id,
      dadosAntes: { estado: antes.estado, numero: antes.numero },
      dadosDepois: { estado: 'paga' },
      ip: ctx.ip,
    });

    return depois;
  });
}

/** Proximo numero sem consumir — para prever no formulario. */
export async function preverNumeroFatura(db: Database, tenantId: string) {
  const emitente = await emitenteDoTenant(db, tenantId);
  return { numero: await preverNumero(db, tenantId, 'FAT'), emitente };
}
