/**
 * Permissoes por papel. Nao e "se papel == X" espalhado pelo codigo: cada rota
 * declara a permissao que exige e o plugin decide.
 */
export const PERMISSOES = [
  // Obras
  'obras:ler',
  'obras:escrever',
  'obras:apagar',
  // Orçamento e custos
  'orcamento:ler',
  'orcamento:escrever',
  'custos:ler',
  'custos:escrever',
  'custos:apagar',
  // Materiais e stock
  'materiais:ler',
  'materiais:escrever',
  'fornecedores:ler',
  'fornecedores:escrever',
  'stock:ler',
  'stock:movimentar',
  'requisicoes:ler',
  'requisicoes:criar',
  'requisicoes:aprovar',
  'requisicoes:atender',
  // Diário
  'diario:ler',
  'diario:escrever',
  // Ponto e folhas
  'ponto:ler',
  'ponto:registar',
  'folhas:ler',
  'folhas:gerar',
  // Subempreitada
  'subempreitada:ler',
  'subempreitada:escrever',
  // Pagamentos
  'pagamentos:ler',
  'pagamentos:registar',
  'pagamentos:anular',
  // Faturação
  'faturas:ler',
  'faturas:escrever',
  'faturas:anular',
  // Relatórios
  'relatorios:ler',
  // Administração
  'utilizadores:ler',
  'utilizadores:escrever',
  'tenant:configurar',
  'cambio:escrever',
] as const;

export type Permissao = (typeof PERMISSOES)[number];

const TODAS = new Set<string>(PERMISSOES);

const GESTAO_COMPLETA: Permissao[] = [
  ...PERMISSOES.filter((p) => !p.startsWith('tenant:') && p !== 'utilizadores:escrever'),
];

export const PERMISSOES_POR_PAPEL: Record<string, readonly Permissao[]> = {
  // Dono da empresa: tudo, incluindo configuracao do tenant.
  admin: [...TODAS] as Permissao[],

  // Gestor de obra: opera obras, orcamento, requisicoes, relatorios. Nao mexe
  // em utilizadores, nao anula pagamentos.
  gestor: GESTAO_COMPLETA,

  // Fiscal: aponta ponto, lanca custos, confirma pagamentos, relatorios.
  // Nao cria nem apaga obras, nao aprova requisicoes.
  fiscal: [
    'obras:ler',
    'orcamento:ler',
    'custos:ler',
    'custos:escrever',
    'materiais:ler',
    'stock:ler',
    'requisicoes:ler',
    'diario:ler',
    'ponto:ler',
    'ponto:registar',
    'folhas:ler',
    'folhas:gerar',
    'subempreitada:ler',
    'pagamentos:ler',
    'pagamentos:registar',
    'faturas:ler',
    'faturas:escrever',
    'relatorios:ler',
    'utilizadores:ler',
  ],

  // Encarregado de obra no terreno: diario e ponto. Opera offline.
  encarregado: [
    'obras:ler',
    'orcamento:ler',
    'materiais:ler',
    'stock:ler',
    'requisicoes:ler',
    'requisicoes:criar',
    'diario:ler',
    'diario:escrever',
    'ponto:ler',
    'ponto:registar',
    'subempreitada:ler',
    'relatorios:ler',
  ],

  // Armazem: materiais, entradas/saidas, atende requisicoes aprovadas.
  armazem: [
    'obras:ler',
    'materiais:ler',
    'materiais:escrever',
    'stock:ler',
    'stock:movimentar',
    'requisicoes:ler',
    'requisicoes:atender',
    'custos:ler',
    'diario:ler',
  ],

  // Financeiro: custos, pagamentos, cambio, relatorios. Nao opera obras.
  financeiro: [
    'obras:ler',
    'orcamento:ler',
    'custos:ler',
    'custos:escrever',
    'custos:apagar',
    'materiais:ler',
    'fornecedores:ler',
    'stock:ler',
    'requisicoes:ler',
    'subempreitada:ler',
    'subempreitada:escrever',
    'pagamentos:ler',
    'pagamentos:registar',
    'pagamentos:anular',
    'faturas:ler',
    'faturas:escrever',
    'faturas:anular',
    'relatorios:ler',
    'cambio:escrever',
    'utilizadores:ler',
  ],
};

export function permissoesDoPapel(papel: string): readonly Permissao[] {
  return PERMISSOES_POR_PAPEL[papel] ?? [];
}

export function temPermissao(papel: string, permissao: Permissao): boolean {
  return permissoesDoPapel(papel).includes(permissao);
}

/**
 * Leitura livre: quem pode ler uma tabela, pode ler o tenant inteiro dela.
 * Em vez de repetir a lista, derivamos do prefixo.
 */
export function podeLerPrefixo(papel: string, prefixo: string): boolean {
  return permissoesDoPapel(papel).some((p) => p === `${prefixo}:ler` || p === prefixo);
}