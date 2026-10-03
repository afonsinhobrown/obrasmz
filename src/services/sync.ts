import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  contratosSubempreitada,
  custos,
  diarioFotos,
  diarioObra,
  folhasSalario,
  fornecedores,
  materiais,
  medicoes,
  obras,
  orcamentoItens,
  pagamentos,
  presencas,
  requisicoes,
  stockMovimentos,
  subempreiteiros,
  trabalhadores,
} from '../db/schema.js';
import type { Ctx } from '../db/tx.js';
import { ErroSync } from '../lib/erros.js';
import { auditar } from './auditoria.js';
import type { Contexto } from './auth.js';

/**
 * Sincronizacao offline.
 *
 * O telefone perde rede no meio de um canteiro e nao pode perder o que o
 * encarregado escreveu. O modelo e "o dispositivo manda, o servidor responde":
 *
 *   push -> o cliente envia alteracoes em lote; o servidor deduplica por
 *          `client_id` e resolve conflitos por last-write-wins; devolve o que
 *          foi aceite e o que foi recusado, com a razao.
 *   pull -> o cliente pede tudo com `updated_at` acima do seu cursor.
 *
 * Duas garantias sustentam isto:
 *
 *  1. **Idempotencia por `client_id`.** O cliente pode reenviar um lote
 *     inteiro depois de uma resposta perdida. Como `client_id` tem indice
 *     unico por tenant, o reenvio devolve o registo ja existente em vez de
 *     criar um duplicado. E por isso que o `INSERT ... ON CONFLICT DO NOTHING`
 *     e usado em vez de um `INSERT` seguido de tratamento de erro: assim dois
 *     pedidos simultaneos com o mesmo `client_id` convergem para o mesmo
 *     registo sem nenhum deles falhar.
 *
 *  2. **Last-write-wins por `updated_at`.** Nao ha CRDT nem merge semantico.
 *     Se dois dispositivos escreveram o mesmo registo, ganha o mais recente.
 *     E uma escolha, nao uma limitacao esquecida: para dados de uma obra, um
 *     "ultimo a escrever" previsivel e auditavel vale mais do que um merge
 *     que ninguem consegue explicar ao cliente.
 */

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

const enumEntidade = z.enum(ENTIDADES);

export const schemaPush = z.object({
  /** Lote do dispositivo, para se poder dizer de que aparelho veio. */
  dispositivoId: z.string().uuid().optional(),
  alteracoes: z
    .array(
      z.object({
        entidade: enumEntidade,
        /** UUID gerado no dispositivo. Chave de idempotencia. */
        clientId: z.string().uuid(),
        operacao: z.enum(['inserir', 'actualizar', 'apagar']),
        dados: z.record(z.unknown()).default({}),
        /** Momento da alteracao no dispositivo, em ISO. */
        actualizadoEm: z.string().datetime(),
      }),
    )
    .min(1)
    .max(200),
});

export type Push = z.infer<typeof schemaPush>;
export type Alteracao = Push['alteracoes'][number];

/**
 * Tabela de cada entidade, com a indicacao de quem tem coluna de autor.
 *
 * E explicito em vez de deduzido por reflexao porque (a) impede que um cliente
 * escreva numa tabela inventando o nome da entidade e (b) permite usar o
 * `insert`/`update` tipado do drizzle, que valida os nomes das colunas em
 * tempo de compilacao.
 */
/**
 * Superficie minima de que o sync precisa de uma tabela.
 *
 * As 16 tabelas nao sao assignaveis uma a outra porque o drizzle parametriza
 * cada uma pelas suas colunas exactas. Declarar aqui so as cinco colunas que o
 * sync usa permite percorrer todas sem repetir o codigo 16 vezes.
 *
 * O que se perde e a validacao de nomes de coluna em tempo de compilacao
 * **dentro deste ficheiro**. O que a substitui e o `catch` por alteracao em
 * `fazerPush`: um nome de coluna errado volta ao cliente como recusa com a
 * mensagem do PostgreSQL, em vez de um 500 sem explicacao.
 */
type TabelaSync = PgTable & {
  id: PgColumn<any>;
  tenantId: PgColumn<any>;
  clientId: PgColumn<any>;
  updatedAt: PgColumn<any>;
  deletedAt: PgColumn<any>;
};

const TABELAS: Record<EntidadeSync, { tabela: TabelaSync; temAutor: boolean }> = {
  obras: { tabela: obras, temAutor: false },
  orcamento_itens: { tabela: orcamentoItens, temAutor: false },
  custos: { tabela: custos, temAutor: false },
  materiais: { tabela: materiais, temAutor: false },
  fornecedores: { tabela: fornecedores, temAutor: false },
  requisicoes: { tabela: requisicoes, temAutor: false },
  stock_movimentos: { tabela: stockMovimentos, temAutor: true },
  diario_obra: { tabela: diarioObra, temAutor: true },
  diario_fotos: { tabela: diarioFotos, temAutor: false },
  trabalhadores: { tabela: trabalhadores, temAutor: false },
  presencas: { tabela: presencas, temAutor: false },
  folhas_salario: { tabela: folhasSalario, temAutor: false },
  subempreiteiros: { tabela: subempreiteiros, temAutor: false },
  contratos_subempreitada: { tabela: contratosSubempreitada, temAutor: false },
  medicoes: { tabela: medicoes, temAutor: false },
  pagamentos: { tabela: pagamentos, temAutor: true },
};

/** Campos que o cliente nunca pode escrever, por razao de seguranca. */
const RESERVADAS = new Set([
  'tenantId',
  'tenant_id',
  'clientId',
  'client_id',
  'updatedAt',
  'updated_at',
  'deletedAt',
  'deleted_at',
  'criadoEm',
  'criado_em',
  'id',
]);

export type ResultadoSync = {
  /** `updated_at` a gravar como cursor no dispositivo. */
  cursor: string;
  aplicados: number;
  ignorados: number;
  /** Alteracoes que entraram, com o id que a base lhes deu. */
  aceites: { entidade: EntidadeSync; clientId: string; id: string }[];
  /**
   * Alteracoes recusadas. Vem com a razao porque um `sync` que falha em
   * silencio obriga o cliente a tentar para sempre e esconde o problema real.
   */
  recusados: { entidade: EntidadeSync; clientId: string; erro: string }[];
};

export async function fazerPush(
  db: Database,
  tenantId: string,
  utilizadorId: string,
  entrada: Push,
  ctx: Contexto,
): Promise<ResultadoSync> {
  const aceites: ResultadoSync['aceites'] = [];
  const recusados: ResultadoSync['recusados'] = [];

  // Cada alteracao e independente e NAO sao envolvidas numa transacao unica: um
  // `erro` a meio do lote nao pode deitar fora o que ja foi gravado. O cliente
  // precisa de saber exactamente o que entrou e o que nao entrou.
  for (const alt of entrada.alteracoes) {
    try {
      aceites.push(await aplicarAlteracao(db, tenantId, utilizadorId, alt));
    } catch (err) {
      recusados.push({
        entidade: alt.entidade,
        clientId: alt.clientId,
        erro: err instanceof Error ? err.message : 'Erro desconhecido',
      });
    }
  }

  // O cursor e o `now()` do servidor: devolve o que o servidor ja tem, nunca o
  // relogio do dispositivo, senao o cliente saltava registos que ainda nao
  // tinham sido gravados.
  const cursor = new Date().toISOString();

  await auditar(db, tenantId, utilizadorId, {
    accao: 'sync.push',
    entidade: 'sync',
    dadosAntes: { recebidas: entrada.alteracoes.length },
    dadosDepois: {
      aplicadas: aceites.length,
      recusadas: recusados.length,
      dispositivoId: entrada.dispositivoId ?? null,
      cursor,
    },
    ip: ctx.ip,
  });

  return {
    cursor,
    aplicados: aceites.length,
    ignorados: recusados.length,
    aceites,
    recusados,
  };
}

async function aplicarAlteracao(
  db: Ctx,
  tenantId: string,
  utilizadorId: string,
  alt: Alteracao,
): Promise<{ entidade: EntidadeSync; clientId: string; id: string }> {
  const { tabela } = TABELAS[alt.entidade];

  // Idempotencia: se ja existe um registo com este `client_id`, a alteracao ja
  // foi aplicada numa sincronizacao anterior. Devolvemos o registo existente.
  const [jaExiste] = await db
    .select({ id: tabela.id })
    .from(tabela)
    .where(and(eq(tabela.tenantId, tenantId), eq(tabela.clientId, alt.clientId)))
    .limit(1);

  if (jaExiste) {
    return { entidade: alt.entidade, clientId: alt.clientId, id: jaExiste.id };
  }

  const idExistente = typeof alt.dados.id === 'string' ? alt.dados.id : null;

  // Last-write-wins: se o registo que existe ja foi mexido depois da alteracao
  // do dispositivo, o servidor esta mais actualizado. Devolvemos o id para o
  // cliente ir buscar a versao do servidor no `pull` seguinte.
  if (idExistente && alt.operacao === 'actualizar') {
    const [atual] = await db
      .select({ updatedAt: tabela.updatedAt })
      .from(tabela)
      .where(and(eq(tabela.id, idExistente), eq(tabela.tenantId, tenantId)))
      .limit(1);

    if (atual && new Date(atual.updatedAt).getTime() > new Date(alt.actualizadoEm).getTime()) {
      return { entidade: alt.entidade, clientId: alt.clientId, id: idExistente };
    }
  }

  const valores = montarValores(alt, tenantId, utilizadorId, TABELAS[alt.entidade].temAutor);

  if (alt.operacao === 'apagar') {
    if (!idExistente) throw new ErroSync('Apagar exige o id do registo.');
    const [apagado] = await db
      .update(tabela)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tabela.id, idExistente), eq(tabela.tenantId, tenantId)))
      .returning({ id: tabela.id });

    if (!apagado) throw new ErroSync('O registo a apagar nao existe neste tenant.');
    return { entidade: alt.entidade, clientId: alt.clientId, id: apagado.id };
  }

  if (alt.operacao === 'inserir') {
    const [criado] = await db
      .insert(tabela)
      .values({ ...valores, id: idExistente ?? randomUUID() } as never)
      .onConflictDoNothing({ target: [tabela.tenantId, tabela.clientId] })
      .returning({ id: tabela.id });

    if (!criado) {
      // Outro pedido inseriu o mesmo `client_id` em paralelo.
      const [ja] = await db
        .select({ id: tabela.id })
        .from(tabela)
        .where(and(eq(tabela.tenantId, tenantId), eq(tabela.clientId, alt.clientId)))
        .limit(1);
      if (!ja) throw new ErroSync('Nao foi possivel gravar a alteracao.');
      return { entidade: alt.entidade, clientId: alt.clientId, id: ja.id };
    }

    return { entidade: alt.entidade, clientId: alt.clientId, id: criado.id };
  }

  if (!idExistente) throw new ErroSync('Actualizar exige o id do registo.');

  const [alterado] = await db
    .update(tabela)
    .set({ ...valores, updatedAt: new Date() } as never)
    .where(and(eq(tabela.id, idExistente), eq(tabela.tenantId, tenantId)))
    .returning({ id: tabela.id });

  if (!alterado) throw new ErroSync('O registo a actualizar nao existe neste tenant.');
  return { entidade: alt.entidade, clientId: alt.clientId, id: alterado.id };
}

/**
 * Monta o INSERT/UPDATE.
 *
 * Tres protecoes deliberadas:
 *  - `tenantId`, `updatedAt` e `clientId` nunca vem dos `dados` do cliente. Se
 *    viessem, um dispositivo poderia escrever noutro tenant — que e
 *    precisamente o que o `tenant_id` do JWT existe para impedir.
 *  - `registadoPor` so e posto nas tabelas que tem essa coluna. Sem esta
 *    distincao, o `INSERT` numa tabela sem a coluna rebentava com um erro de
 *    SQL que nada dizia sobre a causa.
 *  - chaves desconhecidas sao deitadas fora, para nao acabar num erro de coluna
 *    inexistente em vez de um erro que diga o que o cliente fez de errado.
 */
function montarValores(
  alt: Alteracao,
  tenantId: string,
  utilizadorId: string,
  temAutor: boolean,
): Record<string, unknown> {
  const dados: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(alt.dados)) {
    if (RESERVADAS.has(chave)) continue;
    dados[chave] = valor;
  }
  return {
    ...dados,
    tenantId,
    clientId: alt.clientId,
    updatedAt: new Date(),
    // Registos que nascem offline precisam de saber de quem sao, senao a
    // auditoria fica orfa.
    ...(temAutor ? { registadoPor: utilizadorId } : {}),
  };
}

export type AlteracaoPuxada = {
  entidade: EntidadeSync;
  dados: unknown;
  deleted: boolean;
  atualizadoEm: string;
};

/**
 * `pull`: tudo o que mudou depois do cursor do dispositivo.
 *
 * Por defeito devolve apenas registos **nao apagados**. `incluirApagados` existe
 * para uma unica situacao: o dispositivo apaga uma obra enquanto esta offline e,
 * ao voltar, tem de aprender que ela sumiu. Sem o registo do apagamento, o
 * telefone mostraria uma obra que ja nao existe no servidor e voltaria a
 * tentar envia-la, infinidamente.
 */
export async function fazerPull(
  db: Database,
  tenantId: string,
  opcoes: { desde?: string; limite?: number; incluirApagados?: boolean } = {},
) {
  const limite = Math.min(opcoes.limite ?? 500, 2000);
  const desde = opcoes.desde ? new Date(opcoes.desde) : new Date(0);

  const recolhidas: AlteracaoPuxada[] = [];

  for (const entidade of ENTIDADES) {
    const { tabela } = TABELAS[entidade];

    const cond = [eq(tabela.tenantId, tenantId), gt(tabela.updatedAt, desde)];
    if (!opcoes.incluirApagados) cond.push(isNull(tabela.deletedAt));

    const linhas = await db
      .select({
        dados: sql<string>`to_jsonb(${tabela})`,
        apagado: sql<boolean>`${tabela.deletedAt} is not null`,
        atualizadoEm: sql<string>`${tabela.updatedAt}::text`,
      })
      .from(tabela)
      .where(and(...cond))
      .orderBy(tabela.updatedAt)
      .limit(limite);

    for (const l of linhas) {
      recolhidas.push({
        entidade,
        dados: l.dados,
        deleted: Boolean(l.apagado),
        atualizadoEm: l.atualizadoEm,
      });
    }
  }

  // Ordenar por data de alteracao e o que permite ao cliente aplicar tudo na
  // ordem certa e manter o cursor coerente.
  recolhidas.sort((a, b) => a.atualizadoEm.localeCompare(b.atualizadoEm));

  const ultima = recolhidas[recolhidas.length - 1];

  return {
    alteracoes: recolhidas,
    cursor: ultima?.atualizadoEm ?? new Date().toISOString(),
    /** Ha mais para buscar? O cliente repete com o novo cursor. */
    temMais: recolhidas.length >= limite,
  };
}

/** Contagem por entidade — o ecra mostra "12 alteracoes por sincronizar". */
export async function estadoSync(db: Database, tenantId: string, dispositivoId: string) {
  const r = await db.execute<{ entidade: string; n: string; ultimo: string | null }>(sql`
    SELECT 'obras' AS entidade, count(*) AS n, max(updated_at)::text AS ultimo
      FROM obras WHERE tenant_id = ${tenantId}
    UNION ALL
    SELECT 'custos', count(*), max(updated_at)::text
      FROM custos WHERE tenant_id = ${tenantId}
    UNION ALL
    SELECT 'presencas', count(*), max(updated_at)::text
      FROM presencas WHERE tenant_id = ${tenantId}
    UNION ALL
    SELECT 'diario_obra', count(*), max(updated_at)::text
      FROM diario_obra WHERE tenant_id = ${tenantId}
    UNION ALL
    SELECT 'stock_movimentos', count(*), max(updated_at)::text
      FROM stock_movimentos WHERE tenant_id = ${tenantId}
    UNION ALL
    SELECT 'pagamentos', count(*), max(updated_at)::text
      FROM pagamentos WHERE tenant_id = ${tenantId}`);

  return {
    dispositivoId,
    porEntidade: (r.rows ?? []).map((x) => ({
      entidade: x.entidade,
      registos: Number(x.n),
      ultimaAlteracao: x.ultimo,
    })),
  };
}
