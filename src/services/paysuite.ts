import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { pagamentos, transacoesExternas } from '../db/schema.js';
import type { Ctx } from '../db/tx.js';
import { config } from '../config.js';
import {
  ErroGateway,
  ErroNaoEncontrado,
  ErroRegraNegocio,
  ErroValidacao,
} from '../lib/erros.js';
import { arred2, paraNum } from '../lib/money.js';
import type { Contexto } from './auth.js';

/**
 * Integração com a PaySuite (paysuite.tech), gateway de pagamentos de
 * Moçambique (M-Pesa, e-Mola, Mkesh, cartões, bancos).
 *
 * A integração fica desligada enquanto nao houver `PAYSUITE_API_KEY`:
 * nenhuma transaccao real e tentada. ATENCAO: a PaySuite nao tem
 * sandbox — com a key definida, todas as transaccoes sao reais.
 */

const METODOS_PAGAMENTO = ['mpesa', 'emola', 'credit_card'] as const;
const METODOS_PAYOUT = ['mpesa', 'emola', 'mkesh', 'bank', 'bank_transfer'] as const;

type MetodoPagamento = (typeof METODOS_PAGAMENTO)[number];
type MetodoPayout = (typeof METODOS_PAYOUT)[number];

export const STATUS_VALIDOS = [
  'pending',
  'processing',
  'paid',
  'completed',
  'failed',
  'cancelled',
] as const;
type StatusTransacao = (typeof STATUS_VALIDOS)[number];

const STATUS_SUCESSO = new Set([
  'paid',
  'pago',
  'succeeded',
  'success',
  'completed',
  'confirmed',
]);
const STATUS_FALHA = new Set([
  'failed',
  'falhou',
  'cancelled',
  'cancelado',
  'expired',
  'declined',
  'rejected',
]);

/** Classifica um status do gateway no nosso enum interno. */
function classificarStatus(status: string): StatusTransacao | null {
  const s = status.toLowerCase();
  if (s === 'pending' || s === 'pendente') return 'pending';
  if (s === 'processing' || s === 'processando') return 'processing';
  if (STATUS_SUCESSO.has(s)) {
    return s === 'paid' || s === 'pago' ? 'paid' : 'completed';
  }
  if (STATUS_FALHA.has(s)) {
    return s === 'cancelled' || s === 'cancelado' || s === 'expired'
      ? 'cancelled'
      : 'failed';
  }
  return null;
}

/**
 * O gateway devolve strings; so aceitamos estados conhecidos.
 * Qualquer outro valor cai em `fallback` para nao corromper a
 * coluna enum.
 */
function normalizarStatus(
  valor: unknown,
  fallback: StatusTransacao = 'pending',
): StatusTransacao {
  return classificarStatus(String(valor ?? '')) ?? fallback;
}

/** Levanta se a integração nao estiver configurada. */
function assertActivo(): string {
  const chave = config.paysuite.apiToken;
  if (!chave) {
    throw new ErroRegraNegocio(
      'Integração PaySuite nao configurada. Defina PAYSUITE_API_TOKEN.',
    );
  }
  return chave;
}

interface Resposta {
  status: 'success' | 'error';
  data?: Record<string, unknown>;
  message?: string;
  error?: string;
  errors?: Record<string, unknown>;
}

/** Pedido autenticado ao gateway. Devolve `data` ou lança ErroGateway. */
async function pedir(
  metodoHttp: 'GET' | 'POST',
  caminho: string,
  corpo?: unknown,
): Promise<Record<string, unknown>> {
  const chave = assertActivo();
  const url = `${config.paysuite.baseUrl}${caminho}`;
  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: metodoHttp,
      headers: {
        Authorization: `Bearer ${chave}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(15000),
    });
  } catch (erro) {
    throw new ErroGateway('Impossivel contactar o gateway de pagamentos.', {
      causa: erro instanceof Error ? erro.message : String(erro),
    });
  }
  let json: Resposta;
  try {
    json = (await resposta.json()) as Resposta;
  } catch {
    throw new ErroGateway('Resposta invalida do gateway de pagamentos.', {
      statusHttp: resposta.status,
    });
  }
  if (!resposta.ok || json.status === 'error') {
    // Detalhes: a PaySuite devolve `errors` como objecto de listas.
    const erros = json.errors;
    const detalhe =
      erros && typeof erros === 'object'
        ? Object.values(erros)
            .map((v) => (Array.isArray(v) ? v.join(', ') : String(v)))
            .join('; ')
        : '';
    const mensagem =
      json.message ?? json.error ?? 'O gateway de pagamentos recusou o pedido.';
    throw new ErroGateway(
      detalhe ? `${mensagem} (${detalhe})` : mensagem,
      { statusHttp: resposta.status, erros: json.errors },
    );
  }
  return json.data ?? {};
}

/**
 * Referência nossa, unica por tenant. ALFANUMÉRICA — a PaySuite
 * recusa "_" e "-" em references (verificado contra a API real).
 * Respeita o limite mais apertado (payouts: 30) para servir
 * ambos os fluxos. A unicidade no gateway e a rede de segurança
 * contra pagamentos duplicados.
 */
function gerarReferencia(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `OMZ${stamp}${rand}`;
}

/* ------------------------------------------------------------------ */
/* Payment request (receber dinheiro)                                  */
/* ------------------------------------------------------------------ */

export interface DadosPaymentRequest {
  valor: number;
  metodo?: MetodoPagamento;
  referencia?: string;
  descricao?: string;
  returnUrl?: string;
  webhookUrl?: string;
  contactId?: string;
  /** Pagamento interno que este pedido liquida (opcional). */
  pagamentoId?: string;
}

export async function criarPaymentRequest(
  db: Database,
  tenantId: string,
  dados: DadosPaymentRequest,
  ctx: Contexto,
) {
  const valor = arred2(dados.valor).toFixed(2);
  const referencia = dados.referencia?.trim() || gerarReferencia();
  const metodo = dados.metodo ?? 'mpesa';

  const [tx] = await db
    .insert(transacoesExternas)
    .values({
      tenantId,
      tipo: 'payment_request',
      pagamentoId: dados.pagamentoId ?? null,
      metodo,
      valor,
      moeda: config.dominio.moedaBase,
      referencia,
      status: 'pending',
      registadoPor: ctx.utilizadorId,
    })
    .returning();
  if (!tx) throw new ErroValidacao('Falha ao registar a transacao');

  try {
    const resposta = await pedir('POST', '/payments', {
      amount: valor,
      method: metodo,
      reference: referencia,
      description: dados.descricao,
      return_url: dados.returnUrl,
      webhook_url: dados.webhookUrl,
      contact_id: dados.contactId,
    });
    const externalId = String(resposta.id ?? '');
    const status = normalizarStatus(resposta.status);
    const checkoutUrl = (resposta.checkout_url as string | undefined) ?? null;
    await db
      .update(transacoesExternas)
      .set({ externalId, status, checkoutUrl, updatedAt: new Date() })
      .where(eq(transacoesExternas.id, tx.id));
    return { ...tx, externalId, status, checkoutUrl };
  } catch (erro) {
    await db
      .update(transacoesExternas)
      .set({
        erro: erro instanceof Error ? erro.message : String(erro),
        updatedAt: new Date(),
      })
      .where(eq(transacoesExternas.id, tx.id));
    throw erro;
  }
}

/* ------------------------------------------------------------------ */
/* Payout (pagar dinheiro)                                             */
/* ------------------------------------------------------------------ */

export interface DadosPayout {
  valor: number;
  metodo: MetodoPayout;
  referencia?: string;
  descricao?: string;
  /** 9 digitos, sem indicativo (M-Pesa/e-Mola/Mkesh). */
  telefone?: string;
  titular?: string;
  /** 21 digitos (pagamento bancario). */
  nib?: string;
  webhookUrl?: string;
  pagamentoId?: string;
}

export async function criarPayout(
  db: Database,
  tenantId: string,
  dados: DadosPayout,
  ctx: Contexto,
) {
  if (dados.metodo === 'bank') {
    if (!dados.nib?.trim()) {
      throw new ErroValidacao('Payout bancario precisa do NIB (21 digitos).');
    }
  } else if (!dados.telefone?.trim()) {
    throw new ErroValidacao(
      `Payout ${dados.metodo} precisa do telefone (9 digitos).`,
    );
  }

  const valor = arred2(dados.valor).toFixed(2);
  const referencia = dados.referencia?.trim() || gerarReferencia();

  const [tx] = await db
    .insert(transacoesExternas)
    .values({
      tenantId,
      tipo: 'payout',
      pagamentoId: dados.pagamentoId ?? null,
      metodo: dados.metodo,
      valor,
      moeda: config.dominio.moedaBase,
      referencia,
      status: 'pending',
      beneficiarioTelefone: dados.telefone ?? null,
      beneficiarioTitular: dados.titular ?? null,
      beneficiarioNib: dados.nib ?? null,
      registadoPor: ctx.utilizadorId,
    })
    .returning();
  if (!tx) throw new ErroValidacao('Falha ao registar a transacao');

  try {
    const resposta = await pedir('POST', '/payouts', {
      amount: valor,
      currency: 'MZN',
      reference: referencia,
      description: dados.descricao,
      method: dados.metodo,
      beneficiary:
        dados.metodo === 'bank'
          ? { nib: dados.nib, holder: dados.titular }
          : { phone: dados.telefone, holder: dados.titular },
      webhook_url: dados.webhookUrl,
    });
    const externalId = String(resposta.id ?? '');
    const status = normalizarStatus(resposta.status);
    await db
      .update(transacoesExternas)
      .set({ externalId, status, updatedAt: new Date() })
      .where(eq(transacoesExternas.id, tx.id));
    return { ...tx, externalId, status };
  } catch (erro) {
    await db
      .update(transacoesExternas)
      .set({
        erro: erro instanceof Error ? erro.message : String(erro),
        updatedAt: new Date(),
      })
      .where(eq(transacoesExternas.id, tx.id));
    throw erro;
  }
}

/* ------------------------------------------------------------------ */
/* Consulta de estado                                                  */
/* ------------------------------------------------------------------ */

async function buscarOuErro(
  db: Ctx,
  tenantId: string,
  id: string,
) {
  const [tx] = await db
    .select()
    .from(transacoesExternas)
    .where(
      and(
        eq(transacoesExternas.id, id),
        eq(transacoesExternas.tenantId, tenantId),
        isNull(transacoesExternas.deletedAt),
      ),
    )
    .limit(1);
  if (!tx) throw new ErroNaoEncontrado('Transacao', id);
  return tx;
}

export async function consultar(
  db: Database,
  tenantId: string,
  id: string,
) {
  const tx = await buscarOuErro(db, tenantId, id);
  if (!tx.externalId) {
    throw new ErroRegraNegocio(
      'Transacao ainda nao foi enviada ao gateway.',
    );
  }
  const caminho =
    tx.tipo === 'payout'
      ? `/payouts/${tx.externalId}`
      : tx.tipo === 'refund'
        ? `/refunds/${tx.externalId}`
        : `/payments/${tx.externalId}`;
  const dados = await pedir('GET', caminho);

  const status = normalizarStatus(dados.status, tx.status);
  const transaccao = (dados.transaction as Record<string, unknown> | undefined) ?? {};
  const transactionId =
    (transaccao.transaction_id as string | undefined) ??
    (dados.transaction_id as string | undefined) ??
    tx.transactionId ??
    null;
  const pagoEmRaw =
    (transaccao.paid_at as string | undefined) ??
    (dados.paid_at as string | undefined);
  const pagoEm = pagoEmRaw ? new Date(pagoEmRaw) : tx.pagoEm ?? null;

  await db
    .update(transacoesExternas)
    .set({ status, transactionId, pagoEm, updatedAt: new Date() })
    .where(eq(transacoesExternas.id, tx.id));

  return { ...tx, status, transactionId, pagoEm };
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

/**
 * Verifica o `X-Signature` (HMAC-SHA256 do corpo bruto, em hex).
 *
 * O segredo da conta vem prefixado com `whsec_` e a PaySuite assina
 * tanto com o segredo completo como sem o prefixo — validamos contra
 * ambos. A assinatura pode tambem vir com prefixo `sha256=`.
 */
export function verificarAssinatura(
  corpoBruto: string,
  assinatura: string | undefined,
): boolean {
  const segredo = config.paysuite.webhookSecret;
  if (!segredo || !assinatura) return false;
  const fornecida = assinatura.replace(/^sha256=/i, '').trim();
  const segredos = new Set([segredo]);
  if (segredo.startsWith('whsec_')) segredos.add(segredo.slice(6));
  for (const s of segredos) {
    const esperada = createHmac('sha256', s)
      .update(corpoBruto, 'utf8')
      .digest('hex');
    const a = Buffer.from(fornecida, 'utf8');
    const b = Buffer.from(esperada, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** Estado interno resultante de um evento de webhook. */
function estadoDoEvento(evento: string): StatusTransacao | null {
  const e = evento.toLowerCase();
  if (
    e.endsWith('.success') ||
    e.endsWith('.succeeded') ||
    e.endsWith('.paid') ||
    e.endsWith('.completed') ||
    e.endsWith('.confirmed')
  ) {
    return e.startsWith('payment.') ? 'paid' : 'completed';
  }
  if (
    e.endsWith('.failed') ||
    e.endsWith('.cancelled') ||
    e.endsWith('.canceled') ||
    e.endsWith('.expired') ||
    e.endsWith('.declined') ||
    e.endsWith('.rejected')
  ) {
    return 'failed';
  }
  return null;
}

/**
 * Processa um evento de webhook da PaySuite.
 *
 * A PaySuite ecoa a nossa `reference` (chave unica nossa) e devolve
 * o `id` (ULID). Procuramos por referencia e, na sua ausencia, pelo
 * external_id. Idempotente: o mesmo evento (reenviado ate 5 vezes) e
 * registado em `eventos` e nao e aplicado duas vezes. Quando a
 * transacao termina com sucesso e esta ligada a um pagamento interno,
 * esse pagamento passa a `confirmado` — a ponte entre o gateway e a
 * obra.
 */
export async function processarWebhook(
  db: Database,
  evento: string,
  dados: Record<string, unknown>,
) {
  const referencia = dados.reference ? String(dados.reference) : null;
  const externalId = dados.id ? String(dados.id) : null;
  if (!referencia && !externalId) {
    return { transacaoId: null, aplicado: false };
  }

  // Estado: do evento ou, se o evento vier vazio, do `status`.
  const statusDado = dados.status ? String(dados.status) : null;
  let novoStatus = estadoDoEvento(evento);
  if (!novoStatus && statusDado) {
    novoStatus = classificarStatus(statusDado);
  }

  return db.transaction(async (tx) => {
    const cond = referencia
      ? eq(transacoesExternas.referencia, referencia)
      : eq(transacoesExternas.externalId, externalId!);
    const [registo] = await tx
      .select()
      .from(transacoesExternas)
      .where(and(cond, isNull(transacoesExternas.deletedAt)))
      .limit(1);
    if (!registo) return { transacaoId: null, aplicado: false };

    // Anti-fraude: o valor do webhook tem de coincidir com o nosso.
    const amount = dados.amount !== undefined ? Number(dados.amount) : null;
    if (amount !== null && Number.isFinite(amount)) {
      if (Math.abs(amount - paraNum(registo.valor)) > 0.01) {
        return {
          transacaoId: registo.id,
          aplicado: false,
          ignorado: 'amount mismatch',
        };
      }
    }

    // Idempotencia: ja processamos este evento/estado?
    const eventos = Array.isArray(registo.eventos)
      ? (registo.eventos as unknown[])
      : [];
    const chave = evento || `status:${statusDado ?? ''}`;
    if (eventos.includes(chave)) {
      return { transacaoId: registo.id, aplicado: false };
    }

    if (novoStatus) {
      await tx
        .update(transacoesExternas)
        .set({
          status: novoStatus,
          externalId: externalId ?? registo.externalId,
          eventos: [...eventos, chave],
          updatedAt: new Date(),
        })
        .where(eq(transacoesExternas.id, registo.id));

      // Pagamento interno ligado passa a confirmado no sucesso.
      if (
        (novoStatus === 'paid' || novoStatus === 'completed') &&
        registo.pagamentoId
      ) {
        await tx
          .update(pagamentos)
          .set({ estado: 'confirmado', updatedAt: new Date() })
          .where(
            and(
              eq(pagamentos.id, registo.pagamentoId),
              eq(pagamentos.tenantId, registo.tenantId),
              ne(pagamentos.estado, 'anulado'),
            ),
          );
      }
    }

    return { transacaoId: registo.id, aplicado: true };
  });
}

/* ------------------------------------------------------------------ */
/* Listagem / detalhe                                                  */
/* ------------------------------------------------------------------ */

export async function listarTransacoes(
  db: Database,
  tenantId: string,
  filtro: {
    tipo?: 'payment_request' | 'payout' | 'refund';
    status?: StatusTransacao;
    pagamentoId?: string;
    limite?: number;
  } = {},
) {
  const cond = [
    eq(transacoesExternas.tenantId, tenantId),
    isNull(transacoesExternas.deletedAt),
  ];
  if (filtro.tipo) cond.push(eq(transacoesExternas.tipo, filtro.tipo));
  if (filtro.status) cond.push(eq(transacoesExternas.status, filtro.status));
  if (filtro.pagamentoId)
    cond.push(eq(transacoesExternas.pagamentoId, filtro.pagamentoId));

  return db
    .select()
    .from(transacoesExternas)
    .where(and(...cond))
    .orderBy(desc(transacoesExternas.criadoEm))
    .limit(filtro.limite ?? 100);
}
