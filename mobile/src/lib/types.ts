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
