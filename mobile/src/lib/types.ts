/** Modelos partilhados com a API. Campos em camelCase, tal como a API devolve. */

export type Obra = {
  id: string;
  tenantId: string;
  codigo: string | null;
  nome: string;
  cliente: string | null;
  localizacao: string | null;
  latitude: number | null;
  longitude: number | null;
  moeda: string;
  orcamentoTotal: string;
  dataInicio: string | null;
  dataFimPrevista: string | null;
  estado: 'planeada' | 'em_curso' | 'suspensa' | 'concluida';
  progressoPct: string | null;
  descricao: string | null;
  clientId: string | null;
  criadoEm: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type Trabalhador = {
  id: string;
  tenantId: string;
  nome: string;
  funcao: string | null;
  documento: string | null;
  telefone: string | null;
  tipo: 'diarista' | 'efectivo';
  valorDia: string;
  moeda: string;
  ativo: boolean;
  criadoEm: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type Presenca = {
  id: string;
  tenantId: string;
  obraId: string;
  trabalhadorId: string;
  trabalhadorNome?: string;
  data: string;
  presente: boolean;
  horasExtra: number;
  observacoes: string | null;
  clientId: string | null;
  criadoEm: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type EntradaDiario = {
  id: string;
  tenantId: string;
  obraId: string;
  data: string;
  clima: string | null;
  trabalhos: string;
  ocorrencias: string | null;
  progressoPct: number | null;
  semEfeito: boolean;
  registadoPor: string;
  registadoPorNome?: string;
  /** Numero de fotos anexadas (listagem). */
  nFotos?: number;
  clientId: string | null;
  criadoEm: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** Foto anexada a uma entrada do diário. */
export type FotoDiario = {
  id: string;
  tenantId: string;
  diarioId: string;
  url: string;
  legenda: string | null;
  latitude: number | null;
  longitude: number | null;
  tiradaEm: string;
  clientId: string | null;
  criadoEm: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** Perfil do utilizador autenticado (GET /auth/eu). */
export type Perfil = {
  sub: string;
  tid: string;
  papel: string;
  nome: string;
  email: string | null;
};

/** Item do orçamento de uma obra. */
export type OrcamentoItem = {
  id: string;
  tenantId: string;
  obraId: string;
  capitulo: string | null;
  descricao: string;
  unidade: string | null;
  quantidade: string;
  precoUnitario: string;
  totalOrcado: string;
  qtdExecutada: string;
  ordem: number;
  clientId: string | null;
  criadoEm: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** Custo lançado numa obra. */
export type Custo = {
  id: string;
  tenantId: string;
  obraId: string;
  orcamentoItemId: string | null;
  tipo: 'material' | 'mao_de_obra' | 'subempreitada' | 'equipamento' | 'outro';
  descricao: string;
  valor: string;
  moeda: string;
  taxaCambio: string;
  data: string;
  origemTabela: string | null;
  origemId: string | null;
  clientId: string | null;
  criadoEm: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** Movimento de stock. */
export type MovimentoStock = {
  id: string;
  tenantId: string;
  obraId: string;
  materialId: string;
  materialNome?: string;
  tipo: 'entrada' | 'saida' | 'ajuste' | 'transferencia';
  quantidade: string;
  precoUnitario: string | null;
  fornecedorId: string | null;
  requisicaoId: string | null;
  utilizadorId: string;
  transferenciaParaObraId: string | null;
  observacoes: string | null;
  data: string;
  clientId: string | null;
  criadoEm: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** Resumo de stock (agregado por obra). */
export type StockResumo = {
  obraId: string;
  obraCodigo: string | null;
  obraNome: string | null;
  materiais: number;
  valor: number;
};

/** Material do catálogo. */
export type Material = {
  id: string;
  tenantId: string;
  nome: string;
  unidade: string;
  categoria: string | null;
  stockMinimo: string;
  precoRef: string | null;
  clientId: string | null;
  criadoEm: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** Pagamento registado. */
export type Pagamento = {
  id: string;
  tenantId: string;
  obraId: string;
  beneficiarioTipo: 'trabalhador' | 'subempreiteiro' | 'fornecedor' | 'outro';
  beneficiarioId: string | null;
  contratoId: string | null;
  folhaId: string | null;
  descricao: string | null;
  valor: string;
  moeda: string;
  taxaCambio: string;
  metodo: 'numerario' | 'mpesa' | 'emola' | 'transferencia' | 'cheque';
  referencia: string | null;
  comprovativoUrl: string | null;
  estado: 'registado' | 'confirmado' | 'anulado';
  anuladoMotivo: string | null;
  pagoEm: string;
  registadoPor: string;
  clientId: string | null;
  criadoEm: string;
  updatedAt: string;
  deletedAt: string | null;
};
