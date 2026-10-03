import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { getAccessToken } from './authStore';
import { API_URL } from './config';
import { uuidv4 } from './uuid';
import {
  inicializarLoja,
  type AlteracaoLocal,
  type Linha,
  type LocalStore,
  type OperacaoSync,
} from './storeLocal';

/**
 * Motor de sincronizacao offline.
 *
 * Modelo do servidor ("o dispositivo manda, o servidor responde"):
 *  - push: envia a fila de escritas em lotes de 200, com um
 *          `clientId` UUID por alteracao (idempotencia) e resolve
 *          conflitos por last-write-wins via `updated_at`.
 *  - pull: busca tudo com `updated_at` acima do cursor local,
 *          incluindo apagados, e aplica ao espelho local.
 *
 * Garantias que importam ao utilizador:
 *  - nada se perde quando a rede falha a meio de um canteiro;
 *  - reenviar um lote inteiro nao duplica (idempotencia por clientId);
 *  - dois dispositivos a escrever o mesmo registo convergem para o
 *    mais recente (last-write-wins), sem merge semantico.
 */

/** As mesmas 16 entidades que o endpoint /api/v1/sync aceita. */
export const ENTIDADES = [
  'obras',
  'orcamento_itens',
  'custos',
  'materiais',
  'fornecedores',
  'requisicoes',
  'stock_movimentos',
  'diario_obra',
  'diario_fotos',
  'trabalhadores',
  'presencas',
  'folhas_salario',
  'subempreiteiros',
  'contratos_subempreitada',
  'medicoes',
  'pagamentos',
] as const;

export type EntidadeSync = (typeof ENTIDADES)[number];

const LIMITE_LOTE = 200;
const LIMITE_PULL = 500;
const INTERVALO_MS = 60_000;

let loja: LocalStore | null = null;
let aSincronizar = false;
let timer: ReturnType<typeof setInterval> | null = null;
let pararNetInfo: (() => void) | null = null;

/** Abre a base local e garante o `dispositivoId` (identifica o aparelho no push). */
export async function inicializarOffline(): Promise<LocalStore> {
  loja = await inicializarLoja();
  const existe = await loja.meta('dispositivoId');
  if (!existe) await loja.definirMeta('dispositivoId', uuidv4());
  return loja;
}

/** A base local ja aberta (null ate `inicializarOffline` correr). */
export function lojaPronta(): LocalStore | null {
  return loja;
}

/**
 * Escreve uma alteracao no espelho local e enfileira-a para o servidor.
 * E' o caminho das escritas quando nao ha rede: a app continua a
 * funcionar e o sync empurra tudo quando a rede volta.
 */
export async function escreverLocal<T extends Linha>(
  entidade: string,
  operacao: OperacaoSync,
  dados: Linha,
): Promise<T> {
  if (!loja) await inicializarOffline();
  const l = loja!;
  const agora = new Date().toISOString();
  const clientId = uuidv4();

  if (operacao === 'apagar') {
    const id = String(dados.id);
    await l.apagar(entidade, id);
    await l.enfileirar({
      entidade,
      clientId,
      operacao,
      dados: { id },
      actualizadoEm: agora,
    });
    return { id } as unknown as T;
  }

  let linha: Linha;
  if (operacao === 'actualizar') {
    const id = String(dados.id);
    const existente = (await l.obter(entidade, id)) ?? {};
    linha = { ...existente, ...dados, updatedAt: agora };
  } else {
    linha = {
      tenantId: '',
      deletedAt: null,
      ...dados,
      clientId,
      criadoEm: agora,
      updatedAt: agora,
    };
  }
  await l.gravar(entidade, linha);
  await l.enfileirar({ entidade, clientId, operacao, dados, actualizadoEm: agora });
  return linha as T;
}

/** Envia a fila ao servidor. Sem rede (ou sem token), fica tudo intacto. */
export async function sincronizar(): Promise<void> {
  if (!loja) await inicializarOffline();
  const token = await getAccessToken();
  if (!token) return;
  if (aSincronizar) return;
  aSincronizar = true;
  try {
    await empurrar(token);
    await puxar(token);
  } catch {
    // Sem rede a meio: a fila e o cursor ficam como estavam;
    // tenta-se de novo no proximo ciclo ou quando a rede volta.
  } finally {
    aSincronizar = false;
  }
}

async function empurrar(token: string): Promise<void> {
  const l = loja!;
  const dispositivoId = (await l.meta('dispositivoId')) ?? '';

  for (;;) {
    const fila = await l.fila();
    if (fila.length === 0) return;
    const lote = fila.slice(0, LIMITE_LOTE);

    const res = await fetch(`${API_URL}/api/v1/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        dispositivoId,
        alteracoes: lote.map((a) => ({
          entidade: a.entidade,
          clientId: a.clientId,
          operacao: a.operacao,
          dados: a.dados,
          actualizadoEm: a.actualizadoEm,
        })),
      }),
    });
    if (!res.ok) return; // 401/5xx: parar; a fila fica intacta.

    const corpo = (await res.json()) as {
      aceites: { entidade: string; clientId: string; id: string }[];
      recusados: { entidade: string; clientId: string; erro: string }[];
    };

    // Aceites: ja estao aplicadas localmente; saem da fila.
    await l.removerDaFila(corpo.aceites.map((a) => a.clientId));

    // Recusadas: a recusa e' definitiva (validacao ou regra de
    // negocio). Se era uma insercao, o registo nunca existiu no
    // servidor — remove-se o fantasma local. Actualizar/apagar
    // ficam: o proximo pull traz a versao do servidor.
    for (const r of corpo.recusados) {
      const alt = lote.find((a) => a.clientId === r.clientId);
      if (!alt) continue;
      if (alt.operacao === 'inserir') {
        const id = String(alt.dados.id);
        const linha = await l.obter(r.entidade, id);
        if (linha && String(linha.clientId) === r.clientId) {
          await l.apagar(r.entidade, id);
        }
      }
    }
    await l.removerDaFila(corpo.recusados.map((r) => r.clientId));

    // Nada avancou: nao continuar a pedir (evita ciclo infinito).
    if (corpo.aceites.length + corpo.recusados.length === 0) return;
  }
}

async function puxar(token: string): Promise<void> {
  const l = loja!;
  let cursor = (await l.meta('cursor')) ?? undefined;

  for (;;) {
    const params = new URLSearchParams({
      incluirApagados: '1',
      limite: String(LIMITE_PULL),
    });
    if (cursor) params.set('desde', cursor);

    const res = await fetch(`${API_URL}/api/v1/sync/pull?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;

    const corpo = (await res.json()) as {
      alteracoes: { entidade: string; dados: Record<string, unknown>; deleted: boolean; atualizadoEm: string }[];
      cursor: string;
      temMais: boolean;
    };

    for (const alt of corpo.alteracoes) {
      const linha = snakeParaCamel(alt.dados);
      if (alt.deleted) {
        await l.apagar(alt.entidade, String(linha.id));
      } else {
        await l.gravar(alt.entidade, linha);
      }
    }
    await l.definirMeta('cursor', corpo.cursor);

    if (!corpo.temMais || corpo.alteracoes.length === 0) return;
    cursor = corpo.cursor;
  }
}

/** O pull devolve colunas em snake_case (to_jsonb); o espelho local e' camelCase. */
function snakeParaCamel(obj: Record<string, unknown>): Linha {
  const saida: Linha = {};
  for (const [chave, valor] of Object.entries(obj)) {
    saida[chave.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] =
      valor;
  }
  return saida;
}

/** Alteracoes na fila, para mostrar "N por sincronizar". */
export async function contagemPendentes(): Promise<number> {
  if (!loja) return 0;
  return (await loja.fila()).length;
}

/**
 * Sincroniza ao arrancar, a cada minuto e sempre que a rede volta.
 * Devolve a funcao que para tudo.
 */
export function iniciarSincronizacao(): () => void {
  if (timer) return () => {};
  void inicializarOffline().then(() => {
    void sincronizar();
  });
  timer = setInterval(() => {
    void sincronizar();
  }, INTERVALO_MS);
  pararNetInfo = NetInfo.addEventListener((estado) => {
    if (estado.isConnected) void sincronizar();
  });
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    pararNetInfo?.();
    pararNetInfo = null;
  };
}

/** Estado da ligacao, reativo. */
export function usarLigacao(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const unsub = NetInfo.addEventListener((e) =>
      setOnline(Boolean(e.isConnected)),
    );
    void NetInfo.fetch().then((e) => setOnline(Boolean(e.isConnected)));
    return unsub;
  }, []);
  return online;
}
