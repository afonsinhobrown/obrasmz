import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, ApiError, comoArray } from './api';
import { inicializarLoja, type Linha } from './storeLocal';
import { escreverLocal, lojaPronta, sincronizar } from './sync';
import { uuidv4 } from './uuid';
import type {
  Custo,
  EntradaDiario,
  FotoDiario,
  Material,
  MovimentoStock,
  Obra,
  OrcamentoItem,
  Pagamento,
  Perfil,
  Presenca,
  StockResumo,
  Trabalhador,
} from './types';

/**
 * Acesso a dados da app: local-first.
 *
 * Leituras: pedem ao servidor e guardam o que vem (cache);
 * sem rede, devolvem o espelho local.
 *
 * Escritas: com rede, vao ao servidor (que aplica as regras
 * de negocio); sem rede, escrevem no espelho local e enfileiram
 * para o sync empurrar quando a rede voltar.
 */

const CHAVE_PERFIL = 'obramz.perfil.v1';

/* ------------------------------------------------------------------ */
/* Perfil guardado (para autorId/registadoPor nas escritas offline)    */
/* ------------------------------------------------------------------ */

export async function guardarPerfilLocal(p: Perfil | null): Promise<void> {
  if (p) await AsyncStorage.setItem(CHAVE_PERFIL, JSON.stringify(p));
  else await AsyncStorage.removeItem(CHAVE_PERFIL);
}

export async function lerPerfilLocal(): Promise<Perfil | null> {
  const raw = await AsyncStorage.getItem(CHAVE_PERFIL);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Perfil;
  } catch {
    return null;
  }
}

async function utilizadorId(): Promise<string> {
  const p = await lerPerfilLocal();
  return p?.sub ?? '';
}

async function tenantIdLocal(): Promise<string> {
  const p = await lerPerfilLocal();
  return p?.tid ?? '';
}

/* ------------------------------------------------------------------ */
/* Ajudantes                                                          */
/* ------------------------------------------------------------------ */

async function lojaOuAbrir() {
  return lojaPronta() ?? (await inicializarLoja());
}

async function cachear(entidade: string, linhas: Linha[]): Promise<void> {
  const l = await lojaOuAbrir();
  for (const linha of linhas) {
    if (linha && typeof linha.id === 'string') {
      await l.gravar(entidade, linha);
    }
  }
}

/** Filtra o espelho local por obra (e por intervalo de datas). */
function filtroLocal<T>(
  linhas: Linha[],
  obraId: string,
  de?: string,
  ate?: string,
): T[] {
  return linhas.filter((l) => {
    if (String(l.obraId ?? '') !== obraId) return false;
    if (l.deletedAt) return false;
    if (de && String(l.data ?? '') < de) return false;
    if (ate && String(l.data ?? '') > ate) return false;
    return true;
  }) as T[];
}

/** Queda offline: so' uma falha de rede (sem status HTTP) e' offline. */
function eSemRede(e: unknown): boolean {
  return e instanceof ApiError && e.status === undefined;
}

async function tentarOuLocal<T>(
  pedidos: () => Promise<T>,
  local: () => Promise<T>,
): Promise<T> {
  try {
    const res = await pedidos();
    return res;
  } catch {
    return local();
  }
}

/* ------------------------------------------------------------------ */
/* Obras                                                              */
/* ------------------------------------------------------------------ */

export async function listarObras(): Promise<Obra[]> {
  return tentarOuLocal(
    async () => {
      const res = await api.get<unknown>('/api/v1/obras?porPagina=200');
      const obras = comoArray<Obra>(res);
      await cachear('obras', obras);
      return obras;
    },
    async () => (await lojaOuAbrir()).ler('obras') as Promise<Obra[]>,
  );
}

/* ------------------------------------------------------------------ */
/* Trabalhadores e ponto                                              */
/* ------------------------------------------------------------------ */

export async function listarTrabalhadores(): Promise<Trabalhador[]> {
  return tentarOuLocal(
    async () => {
      const res = await api.get<unknown>('/api/v1/equipa/trabalhadores');
      const arr = comoArray<Trabalhador>(res);
      await cachear('trabalhadores', arr);
      return arr;
    },
    async () =>
      (await lojaOuAbrir()).ler('trabalhadores') as Promise<Trabalhador[]>,
  );
}

export async function presencasDia(
  obraId: string,
  data: string,
): Promise<Presenca[]> {
  return tentarOuLocal(
    async () => {
      const res = await api.get<unknown>(
        `/api/v1/equipa/presencas?obraId=${obraId}&de=${data}&ate=${data}`,
      );
      const arr = comoArray<Presenca>(res);
      await cachear('presencas', arr);
      return arr;
    },
    async () =>
      filtroLocal<Presenca>(
        await (await lojaOuAbrir()).ler('presencas'),
        obraId,
        data,
        data,
      ),
  );
}

/**
 * Marca a presenca. O servidor faz upsert em (obra, trabalhador, data);
 * offline, o mesmo upsert e' feito no espelho local e enfileirado.
 */
export async function marcarPresenca(
  obraId: string,
  trabalhadorId: string,
  data: string,
  presente = true,
): Promise<Presenca> {
  const l = await lojaOuAbrir();
  const existente = (await l.ler('presencas')).find(
    (p) =>
      String(p.obraId ?? '') === obraId &&
      String(p.trabalhadorId ?? '') === trabalhadorId &&
      String(p.data ?? '') === data &&
      !p.deletedAt,
  );

  const optimista: Presenca = {
    id: existente ? String(existente.id) : uuidv4(),
    tenantId: await tenantIdLocal(),
    obraId,
    trabalhadorId,
    data,
    presente,
    horasExtra: Number(existente?.horasExtra ?? 0),
    observacoes: (existente?.observacoes as string | null) ?? null,
    clientId: (existente?.clientId as string | null) ?? null,
    criadoEm: (existente?.criadoEm as string) ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };

  try {
    await api.post('/api/v1/equipa/presencas', {
      obraId,
      trabalhadorId,
      data,
      presente,
    });
    await cachear('presencas', [optimista]);
    return optimista;
  } catch (e) {
    if (!eSemRede(e)) throw e;

    // Sem rede: upsert local + fila para o sync.
    const uid = await utilizadorId();
    if (existente) {
      const dados = {
        id: String(existente.id),
        obraId,
        trabalhadorId,
        data,
        presente,
        horasExtra: Number(existente.horasExtra ?? 0),
        observacoes: (existente.observacoes as string | null) ?? null,
        registadoPor: uid,
      };
      return escreverLocal<Presenca>('presencas', 'actualizar', dados);
    }
    const dados = {
      id: optimista.id,
      obraId,
      trabalhadorId,
      data,
      presente,
      horasExtra: 0,
      observacoes: null,
      registadoPor: uid,
    };
    return escreverLocal<Presenca>('presencas', 'inserir', dados);
  }
}

/* ------------------------------------------------------------------ */
/* Diário de obra                                                     */
/* ------------------------------------------------------------------ */

export async function entradasDiario(
  obraId: string,
  de: string,
  ate: string,
): Promise<EntradaDiario[]> {
  return tentarOuLocal(
    async () => {
      const res = await api.get<unknown>(
        `/api/v1/diario?obraId=${obraId}&de=${de}&ate=${ate}`,
      );
      const arr = comoArray<EntradaDiario>(res);
      await cachear('diario_obra', arr);
      return arr;
    },
    async () =>
      filtroLocal<EntradaDiario>(
        await (await lojaOuAbrir()).ler('diario_obra'),
        obraId,
        de,
        ate,
      ),
  );
}

export async function criarEntradaDiario(input: {
  obraId: string;
  data: string;
  clima: string | null;
  trabalhos: string;
  ocorrencias: string | null;
  progressoPct: number | null;
}): Promise<EntradaDiario> {
  try {
    const res = await api.post<EntradaDiario>('/api/v1/diario', input);
    await cachear('diario_obra', [res]);
    return res;
  } catch (e) {
    if (!eSemRede(e)) throw e;
    const dados = {
      id: uuidv4(),
      obraId: input.obraId,
      data: input.data,
      clima: input.clima,
      trabalhos: input.trabalhos,
      ocorrencias: input.ocorrencias,
      progressoPct: input.progressoPct,
      semEfeito: false,
      autorId: await utilizadorId(),
    };
    return escreverLocal<EntradaDiario>('diario_obra', 'inserir', dados);
  }
}

/* ------------------------------------------------------------------ */
/* Orçamento                                                        */
/* ------------------------------------------------------------------ */

export async function itensOrcamento(
  obraId: string,
): Promise<OrcamentoItem[]> {
  return tentarOuLocal(
    async () => {
      const res = await api.get<unknown>(
        `/api/v1/orcamento/obras/${obraId}/itens`,
      );
      const arr = comoArray<OrcamentoItem>(res);
      await cachear('orcamento_itens', arr);
      return arr;
    },
    async () =>
      filtroLocal<OrcamentoItem>(
        await (await lojaOuAbrir()).ler('orcamento_itens'),
        obraId,
      ),
  );
}

/* ------------------------------------------------------------------ */
/* Custos                                                             */
/* ------------------------------------------------------------------ */

export async function custosObra(obraId: string): Promise<Custo[]> {
  return tentarOuLocal(
    async () => {
      const res = await api.get<unknown>(
        `/api/v1/custos?obraId=${obraId}&porPagina=200`,
      );
      const arr = comoArray<Custo>(res);
      await cachear('custos', arr);
      return arr;
    },
    async () =>
      filtroLocal<Custo>(
        await (await lojaOuAbrir()).ler('custos'),
        obraId,
      ),
  );
}

export async function lancarCusto(input: {
  obraId: string;
  tipo: Custo['tipo'];
  descricao: string;
  valor: number;
  moeda: string;
  data: string;
}): Promise<Custo> {
  try {
    const res = await api.post<Custo>('/api/v1/custos', input);
    await cachear('custos', [res]);
    return res;
  } catch (e) {
    if (!eSemRede(e)) throw e;
    const dados = {
      id: uuidv4(),
      obraId: input.obraId,
      tipo: input.tipo,
      descricao: input.descricao,
      valor: String(input.valor),
      moeda: input.moeda,
      taxaCambio: '1',
      data: input.data,
      orcamentoItemId: null,
      origemTabela: null,
      origemId: null,
    };
    return escreverLocal<Custo>('custos', 'inserir', dados);
  }
}

/* ------------------------------------------------------------------ */
/* Stock                                                              */
/* ------------------------------------------------------------------ */

export async function resumoStock(
  obraId: string,
): Promise<StockResumo | null> {
  try {
    const res = await api.get<unknown>(`/api/v1/stock/resumo?obraId=${obraId}`);
    const arr = comoArray<StockResumo>(res);
    return arr[0] ?? null;
  } catch {
    // Offline: aproximar do extrato local de movimentos.
    const l = await lojaOuAbrir();
    const movs = filtroLocal<Linha>(
      await l.ler('stock_movimentos'),
      obraId,
    );
    const porMaterial = new Map<string, { saldo: number; valor: number }>();
    for (const m of movs) {
      const qtd = Number(m.quantidade ?? 0);
      const preco = Number(m.precoUnitario ?? 0);
      const acc = porMaterial.get(String(m.materialId)) ?? {
        saldo: 0,
        valor: 0,
      };
      if (m.tipo === 'entrada') {
        acc.saldo += qtd;
        acc.valor += qtd * preco;
      } else if (m.tipo === 'saida' || m.tipo === 'transferencia') {
        acc.saldo -= qtd;
      } else if (m.tipo === 'ajuste') {
        acc.saldo += qtd;
      }
      porMaterial.set(String(m.materialId), acc);
    }
    let materiais = 0;
    let valor = 0;
    for (const a of porMaterial.values()) {
      if (a.saldo !== 0) {
        materiais += 1;
        valor += a.valor;
      }
    }
    const obras = await l.ler('obras');
    const obra = obras.find((o) => String(o.id) === obraId);
    return {
      obraId,
      obraCodigo: (obra?.codigo as string | null) ?? null,
      obraNome: (obra?.nome as string | null) ?? null,
      materiais,
      valor,
    };
  }
}

export async function movimentosStock(
  obraId: string,
): Promise<MovimentoStock[]> {
  return tentarOuLocal(
    async () => {
      const res = await api.get<unknown>(
        `/api/v1/stock/movimentos?obraId=${obraId}&limite=100`,
      );
      const arr = comoArray<MovimentoStock>(res);
      await cachear('stock_movimentos', arr);
      return arr;
    },
    async () =>
      filtroLocal<MovimentoStock>(
        await (await lojaOuAbrir()).ler('stock_movimentos'),
        obraId,
      ),
  );
}

export async function materiaisLista(): Promise<Material[]> {
  return tentarOuLocal(
    async () => {
      const res = await api.get<unknown>('/api/v1/materiais?porPagina=200');
      const arr = comoArray<Material>(res);
      await cachear('materiais', arr);
      return arr;
    },
    async () =>
      (await lojaOuAbrir()).ler('materiais') as Promise<Material[]>,
  );
}

/* ------------------------------------------------------------------ */
/* Fotos do diário                                                    */
/* ------------------------------------------------------------------ */

export async function fotosDaEntrada(
  entradaId: string,
): Promise<FotoDiario[]> {
  return tentarOuLocal(
    async () => {
      const res = await api.get<{ fotos?: FotoDiario[] }>(
        `/api/v1/diario/${entradaId}`,
      );
      const arr = res.fotos ?? [];
      await cachear('diario_fotos', arr);
      return arr;
    },
    async () =>
      (await lojaOuAbrir())
        .ler('diario_fotos')
        .then(
          (todas) =>
            todas.filter(
              (f) => String(f.diarioId ?? '') === entradaId && !f.deletedAt,
            ) as FotoDiario[],
        ),
  );
}

/* ------------------------------------------------------------------ */
/* Pagamentos                                                         */
/* ------------------------------------------------------------------ */

export async function pagamentosObra(
  obraId: string,
): Promise<Pagamento[]> {
  return tentarOuLocal(
    async () => {
      const res = await api.get<unknown>(
        `/api/v1/pagamentos?obraId=${obraId}&limite=200`,
      );
      const arr = comoArray<Pagamento>(res);
      await cachear('pagamentos', arr);
      return arr;
    },
    async () =>
      filtroLocal<Pagamento>(
        await (await lojaOuAbrir()).ler('pagamentos'),
        obraId,
      ),
  );
}

export async function registarPagamento(input: {
  obraId: string;
  beneficiarioTipo: 'trabalhador' | 'subempreiteiro' | 'fornecedor' | 'outro';
  beneficiarioId: string | null;
  valor: number;
  metodo: Pagamento['metodo'];
  descricao: string | null;
}): Promise<Pagamento> {
  try {
    const res = await api.post<Pagamento>('/api/v1/pagamentos', input);
    await cachear('pagamentos', [res]);
    return res;
  } catch (e) {
    if (!eSemRede(e)) throw e;
    const dados = {
      id: uuidv4(),
      obraId: input.obraId,
      beneficiarioTipo: input.beneficiarioTipo,
      beneficiarioId: input.beneficiarioId,
      contratoId: null,
      folhaId: null,
      descricao: input.descricao,
      valor: String(input.valor),
      moeda: 'MZN',
      taxaCambio: '1',
      metodo: input.metodo,
      referencia: null,
      comprovativoUrl: null,
      estado: 'registado',
      anuladoMotivo: null,
      pagoEm: new Date().toISOString(),
      registadoPor: await utilizadorId(),
    };
    return escreverLocal<Pagamento>('pagamentos', 'inserir', dados);
  }
}
