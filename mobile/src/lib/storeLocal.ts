import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';

/**
 * Base local da app.
 *
 * O canteiro perde rede; a base local e' o espelho do servidor
 * (mesmas entidades, mesmas chaves) mais a fila de escrita.
 *
 * Duas implementacoes, mesma interface:
 *  - SQLite (Android/iOS): uma tabela de registos, uma de fila,
 *    uma de meta. Dados persistem entre sessoes.
 *  - AsyncStorage (web, ou se o SQLite falhar): o mesmo modelo
 *    em chaves JSON. Na web o expo-sqlite e' alpha (precisa de
 *    wasm + cabecalhos COEP/COOP), pelo que a queda e' deliberada.
 */

export type Linha = Record<string, unknown>;

export type OperacaoSync = 'inserir' | 'actualizar' | 'apagar';

/** Uma alteracao pendente de enviar ao servidor (a "outbox"). */
export type AlteracaoLocal = {
  entidade: string;
  /** UUID gerado no dispositivo; chave de idempotencia do sync. */
  clientId: string;
  operacao: OperacaoSync;
  dados: Linha;
  /** Momento da alteracao local, ISO. */
  actualizadoEm: string;
};

export interface LocalStore {
  ler(entidade: string): Promise<Linha[]>;
  obter(entidade: string, id: string): Promise<Linha | null>;
  /** Upsert por `id`. */
  gravar(entidade: string, linha: Linha): Promise<void>;
  apagar(entidade: string, id: string): Promise<void>;
  enfileirar(alt: AlteracaoLocal): Promise<void>;
  fila(): Promise<AlteracaoLocal[]>;
  removerDaFila(clientIds: string[]): Promise<void>;
  meta(chave: string): Promise<string | null>;
  definirMeta(chave: string, valor: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* SQLite                                                              */
/* ------------------------------------------------------------------ */

const SQL_CRIAR = `
CREATE TABLE IF NOT EXISTS registos (
  entidade TEXT NOT NULL,
  id TEXT NOT NULL,
  dados TEXT NOT NULL,
  PRIMARY KEY (entidade, id)
);
CREATE TABLE IF NOT EXISTS fila (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entidade TEXT NOT NULL,
  client_id TEXT NOT NULL,
  operacao TEXT NOT NULL,
  dados TEXT NOT NULL,
  actualizado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

type LinhaFila = {
  entidade: string;
  client_id: string;
  operacao: string;
  dados: string;
  actualizado_em: string;
};

class LojaSqlite implements LocalStore {
  constructor(private db: SQLite.SQLiteDatabase) {}

  async ler(entidade: string): Promise<Linha[]> {
    const rows = await this.db.getAllAsync<{ dados: string }>(
      'SELECT dados FROM registos WHERE entidade = ?',
      [entidade],
    );
    return rows.map((r) => JSON.parse(r.dados) as Linha);
  }

  async obter(entidade: string, id: string): Promise<Linha | null> {
    const row = await this.db.getFirstAsync<{ dados: string }>(
      'SELECT dados FROM registos WHERE entidade = ? AND id = ?',
      [entidade, id],
    );
    return row ? (JSON.parse(row.dados) as Linha) : null;
  }

  async gravar(entidade: string, linha: Linha): Promise<void> {
    await this.db.runAsync(
      'INSERT OR REPLACE INTO registos (entidade, id, dados) VALUES (?, ?, ?)',
      [entidade, String(linha.id), JSON.stringify(linha)],
    );
  }

  async apagar(entidade: string, id: string): Promise<void> {
    await this.db.runAsync(
      'DELETE FROM registos WHERE entidade = ? AND id = ?',
      [entidade, id],
    );
  }

  async enfileirar(alt: AlteracaoLocal): Promise<void> {
    await this.db.runAsync(
      'INSERT INTO fila (entidade, client_id, operacao, dados, actualizado_em) VALUES (?, ?, ?, ?, ?)',
      [
        alt.entidade,
        alt.clientId,
        alt.operacao,
        JSON.stringify(alt.dados),
        alt.actualizadoEm,
      ],
    );
  }

  async fila(): Promise<AlteracaoLocal[]> {
    const rows = await this.db.getAllAsync<LinhaFila>(
      'SELECT * FROM fila ORDER BY seq',
    );
    return rows.map((r) => ({
      entidade: r.entidade,
      clientId: r.client_id,
      operacao: r.operacao as OperacaoSync,
      dados: JSON.parse(r.dados) as Linha,
      actualizadoEm: r.actualizado_em,
    }));
  }

  async removerDaFila(clientIds: string[]): Promise<void> {
    if (clientIds.length === 0) return;
    const marcas = clientIds.map(() => '?').join(',');
    await this.db.runAsync(
      `DELETE FROM fila WHERE client_id IN (${marcas})`,
      clientIds,
    );
  }

  async meta(chave: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ valor: string }>(
      'SELECT valor FROM meta WHERE chave = ?',
      [chave],
    );
    return row?.valor ?? null;
  }

  async definirMeta(chave: string, valor: string): Promise<void> {
    await this.db.runAsync(
      'INSERT OR REPLACE INTO meta (chave, valor) VALUES (?, ?)',
      [chave, valor],
    );
  }
}

/* ------------------------------------------------------------------ */
/* AsyncStorage (web / queda)                                          */
/* ------------------------------------------------------------------ */

const PREFIXO = 'obramz.local.';
const CHAVE_FILA = `${PREFIXO}fila`;

class LojaAsync implements LocalStore {
  private chave(entidade: string): string {
    return `${PREFIXO}reg.${entidade}`;
  }

  async ler(entidade: string): Promise<Linha[]> {
    const raw = await AsyncStorage.getItem(this.chave(entidade));
    if (!raw) return [];
    try {
      return JSON.parse(raw) as Linha[];
    } catch {
      return [];
    }
  }

  async obter(entidade: string, id: string): Promise<Linha | null> {
    const todas = await this.ler(entidade);
    return todas.find((l) => String(l.id) === id) ?? null;
  }

  async gravar(entidade: string, linha: Linha): Promise<void> {
    const todas = await this.ler(entidade);
    const i = todas.findIndex((l) => String(l.id) === String(linha.id));
    if (i >= 0) todas[i] = linha;
    else todas.push(linha);
    await AsyncStorage.setItem(this.chave(entidade), JSON.stringify(todas));
  }

  async apagar(entidade: string, id: string): Promise<void> {
    const todas = await this.ler(entidade);
    await AsyncStorage.setItem(
      this.chave(entidade),
      JSON.stringify(todas.filter((l) => String(l.id) !== id)),
    );
  }

  async enfileirar(alt: AlteracaoLocal): Promise<void> {
    const f = await this.fila();
    f.push(alt);
    await AsyncStorage.setItem(CHAVE_FILA, JSON.stringify(f));
  }

  async fila(): Promise<AlteracaoLocal[]> {
    const raw = await AsyncStorage.getItem(CHAVE_FILA);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as AlteracaoLocal[];
    } catch {
      return [];
    }
  }

  async removerDaFila(clientIds: string[]): Promise<void> {
    const f = await this.fila();
    const conjunto = new Set(clientIds);
    await AsyncStorage.setItem(
      CHAVE_FILA,
      JSON.stringify(f.filter((a) => !conjunto.has(a.clientId))),
    );
  }

  async meta(chave: string): Promise<string | null> {
    return AsyncStorage.getItem(`${PREFIXO}meta.${chave}`);
  }

  async definirMeta(chave: string, valor: string): Promise<void> {
    await AsyncStorage.setItem(`${PREFIXO}meta.${chave}`, valor);
  }
}

/* ------------------------------------------------------------------ */
/* Singleton                                                           */
/* ------------------------------------------------------------------ */

let inicializacao: Promise<LocalStore> | null = null;

/** Abre (ou reabre) a base local. SQLite quando possivel; AsyncStorage quando nao. */
export function inicializarLoja(): Promise<LocalStore> {
  if (!inicializacao) {
    inicializacao = (async (): Promise<LocalStore> => {
      try {
        const db = await SQLite.openDatabaseAsync('obramz.db');
        await db.execAsync(SQL_CRIAR);
        return new LojaSqlite(db);
      } catch {
        // Web sem wasm, ou erro nativo: AsyncStorage.
        return new LojaAsync();
      }
    })();
  }
  return inicializacao;
}
