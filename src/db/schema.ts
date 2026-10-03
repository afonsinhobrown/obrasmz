import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* ==========================================================================
   COLUNAS DE SINCRONIZACAO
   Toda tabela operacional repete estes tres campos:
     client_id  -> UUID gerado no dispositivo; base da idempotencia do sync
     updated_at -> resolucao de conflitos (last-write-wins)
     deleted_at -> soft delete, para propagar apagamentos
   ========================================================================== */

const clientId = () => uuid('client_id');
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const deletedAt = () => timestamp('deleted_at', { withTimezone: true });

/**
 * `criado_em` e imutavel. Sem ele nao ha ordenacao estavel de listas (dois
 * registos com a mesma `updated_at` trocam de pagina entre pedidos) nem como
 * saber quando um custo ou um pagamento nasceu.
 */
const criadoEm = () =>
  timestamp('criado_em', { withTimezone: true }).notNull().defaultNow();

/* ==========================================================================
   ENUMS
   ========================================================================== */

export const planosEnum = pgEnum('planos', ['starter', 'pro', 'enterprise']);
export const papeisEnum = pgEnum('papeis', [
  'admin',
  'gestor',
  'fiscal',
  'encarregado',
  'armazem',
  'financeiro',
]);
export const estadosObraEnum = pgEnum('estados_obra', [
  'planeada',
  'em_curso',
  'suspensa',
  'concluida',
]);
export const tiposCustoEnum = pgEnum('tipos_custo', [
  'material',
  'mao_de_obra',
  'subempreitada',
  'equipamento',
  'outro',
]);
export const tiposMovimentoEnum = pgEnum('tipos_movimento', [
  'entrada',
  'saida',
  'ajuste',
  'transferencia',
]);
export const estadosRequisicaoEnum = pgEnum('estados_requisicao', [
  'pendente',
  'aprovada',
  'rejeitada',
  'atendida',
]);
export const tiposTrabalhadorEnum = pgEnum('tipos_trabalhador', [
  'diarista',
  'efectivo',
]);
export const estadosContratoEnum = pgEnum('estados_contrato', [
  'activo',
  'concluido',
  'cancelado',
]);
export const tiposBeneficiarioEnum = pgEnum('tipos_beneficiario', [
  'trabalhador',
  'subempreiteiro',
  'fornecedor',
  'outro',
]);
export const metodosPagamentoEnum = pgEnum('metodos_pagamento', [
  'numerario',
  'mpesa',
  'emola',
  'transferencia',
  'cheque',
]);
export const estadosPagamentoEnum = pgEnum('estados_pagamento', [
  'registado',
  'confirmado',
  'anulado',
]);
export const estadosFolhaEnum = pgEnum('estados_folha', [
  'gerada',
  'lancada',
  'paga',
  'anulada',
]);
export const tiposTransacaoExternaEnum = pgEnum('tipos_transacao_externa', [
  'payment_request',
  'payout',
  'refund',
]);
export const metodosPaySuiteEnum = pgEnum('metodos_paysuite', [
  'mpesa',
  'emola',
  'mkesh',
  'credit_card',
  'bank',
  'bank_transfer',
]);
export const estadosTransacaoExternaEnum = pgEnum(
  'estados_transacao_externa',
  ['pending', 'processing', 'paid', 'completed', 'failed', 'cancelled'],
);

/* ==========================================================================
   BASE / MULTI-TENANT
   ========================================================================== */

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  nome: text('nome').notNull(),
  nuit: text('nuit'),
  moedaBase: char('moeda_base', { length: 3 }).notNull().default('MZN'),
  logoUrl: text('logo_url'),
  plano: planosEnum('plano').notNull().default('starter'),
  activo: boolean('activo').notNull().default(true),
  /** Teto de obras por plano. Aplicado no onboarding e na criacao de obra. */
  maxObras: integer('max_obras').notNull().default(5),
  /** Teto de utilizadores por plano. */
  maxUtilizadores: integer('max_utilizadores').notNull().default(3),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

export const utilizadores = pgTable(
  'utilizadores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    nome: text('nome').notNull(),
    email: text('email'),
    telefone: text('telefone'),
    senhaHash: text('senha_hash').notNull(),
    papel: papeisEnum('papel').notNull(),
    activo: boolean('activo').notNull().default(true),
    ultimoAcessoEm: timestamp('ultimo_acesso_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    // `email` e `nome` sao gravados ja normalizados (minusculas, sem espacos)
    // pela camada de servico, por isso o indice composto e suficiente.
    uniqueIndex('uq_utilizadores_tenant_email').on(t.tenantId, t.email),
    uniqueIndex('uq_utilizadores_tenant_telefone').on(t.tenantId, t.telefone),
    index('idx_utilizadores_tenant').on(t.tenantId),
  ],
);

/**
 * Sessoes = refresh tokens. Guardamos apenas o hash: quem roubar a base de
 * dados nao consegue forjar sessoes. `rodar` encadeia rotacao — quando um
 * refresh e usado, o anterior fica revogado e um novo e emitido.
 */
export const sessoes = pgTable(
  'sessoes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    utilizadorId: uuid('utilizador_id')
      .notNull()
      .references(() => utilizadores.id),
    refreshHash: text('refresh_hash').notNull(),
    dispositivoId: uuid('dispositivo_id').references(() => dispositivos.id),
    expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
    revogadaEm: timestamp('revogada_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_sessoes_refresh').on(t.refreshHash),
    index('idx_sessoes_utilizador').on(t.utilizadorId),
  ],
);

/** Aparelho cliente. Guarda o ultimo cursor de sync para permitir resumes. */
export const dispositivos = pgTable(
  'dispositivos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    utilizadorId: uuid('utilizador_id')
      .notNull()
      .references(() => utilizadores.id),
    nome: text('nome').notNull(),
    plataforma: text('plataforma'),
    ultimoSyncEm: timestamp('ultimo_sync_em', { withTimezone: true }),
    syncCursor: timestamp('sync_cursor', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_dispositivos_utilizador').on(t.utilizadorId)],
);

/** Trilha de auditoria. Acoes destrutivas e financeiras escrevem aqui. */
export const logAuditoria = pgTable(
  'log_auditoria',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    utilizadorId: uuid('utilizador_id').references(() => utilizadores.id),
    accao: text('accao').notNull(),
    entidade: text('entidade').notNull(),
    entidadeId: uuid('entidade_id'),
    dadosAntes: jsonb('dados_antes'),
    dadosDepois: jsonb('dados_depois'),
    ip: text('ip'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_auditoria_tenant_data').on(t.tenantId, t.criadoEm),
    index('idx_auditoria_entidade').on(t.entidade, t.entidadeId),
  ],
);

/**
 * Contadores de numeracao por tenant e ano (OBR-2026-0001).
 * `numero` e incrementado com UPDATE ... RETURNING dentro da mesma
 * transacao que cria o registo, portanto nao ha colisao sob concorrencia.
 */
export const numerosDocumento = pgTable(
  'numeros_documento',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    tipo: text('tipo').notNull(),
    ano: integer('ano').notNull(),
    numero: integer('numero').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('uq_numeros_documento').on(t.tenantId, t.tipo, t.ano)],
);

/**
 * Taxas de cambio historicas. `taxa` = unidades da moeda base do tenant por
 * 1 unidade da moeda cotada. Ex.: 1 USD = 63,50 MZN.
 */
export const taxasCambio = pgTable(
  'taxas_cambio',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    moeda: char('moeda', { length: 3 }).notNull(),
    data: date('data').notNull(),
    taxa: numeric('taxa', { precision: 12, scale: 6 }).notNull(),
    fonte: text('fonte'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_taxas_cambio').on(t.tenantId, t.moeda, t.data),
    index('idx_taxas_cambio_lookup').on(t.tenantId, t.moeda, t.data),
  ],
);

/* ==========================================================================
   OBRAS E ORCAMENTO
   ========================================================================== */

export const obras = pgTable(
  'obras',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    codigo: text('codigo').notNull(),
    nome: text('nome').notNull(),
    cliente: text('cliente'),
    localizacao: text('localizacao'),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    moeda: char('moeda', { length: 3 }).notNull().default('MZN'),
    orcamentoTotal: numeric('orcamento_total', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    dataInicio: date('data_inicio'),
    dataFimPrevista: date('data_fim_prevista'),
    estado: estadosObraEnum('estado').notNull().default('planeada'),
    progressoPct: numeric('progresso_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),
    descricao: text('descricao'),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('uq_obras_tenant_codigo').on(t.tenantId, t.codigo),
    index('idx_obras_tenant')
      .on(t.tenantId)
      .where(sql`${t.deletedAt} is null`),
    index('idx_sync_obras').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_obras_client').on(t.tenantId, t.clientId),
  ],
);

export const obraMembros = pgTable(
  'obra_membros',
  {
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id, { onDelete: 'cascade' }),
    utilizadorId: uuid('utilizador_id')
      .notNull()
      .references(() => utilizadores.id, { onDelete: 'cascade' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.obraId, t.utilizadorId] })],
);

export const orcamentoItens = pgTable(
  'orcamento_itens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    capitulo: text('capitulo'),
    descricao: text('descricao').notNull(),
    unidade: text('unidade').notNull(),
    quantidade: numeric('quantidade', { precision: 14, scale: 3 }).notNull(),
    precoUnitario: numeric('preco_unitario', { precision: 14, scale: 2 }).notNull(),
    // Referencia por nome: dentro do literal de colunas ainda nao existe
    // handle para a propria tabela (auto-referencia). Equivalente a
    // `quantidade * preco_unitario` gerado pelo PostgreSQL.
    totalOrcado: numeric('total_orcado', { precision: 14, scale: 2 }).generatedAlwaysAs(
      sql`"quantidade" * "preco_unitario"`,
    ),
    qtdExecutada: numeric('qtd_executada', { precision: 14, scale: 3 }).notNull().default('0'),
    ordem: integer('ordem').notNull().default(0),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_orcamento_itens_obra').on(t.obraId),
    index('idx_sync_orcamento_itens').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_orcamento_itens_client').on(t.tenantId, t.clientId),
  ],
);

/**
 * Custos reais. `origem_tabela`/`origem_id` ligam o custo ao documento que o
 * originou (movimento de stock, folha de salario, medicao). E o que garante
 * idempotencia: lancar a mesma folha duas vezes nao duplica custo.
 */
export const custos = pgTable(
  'custos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    orcamentoItemId: uuid('orcamento_item_id').references(() => orcamentoItens.id),
    tipo: tiposCustoEnum('tipo').notNull(),
    descricao: text('descricao').notNull(),
    valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
    moeda: char('moeda', { length: 3 }).notNull().default('MZN'),
    taxaCambio: numeric('taxa_cambio', { precision: 12, scale: 6 }).notNull().default('1'),
    data: date('data').notNull().defaultNow(),
    origemTabela: text('origem_tabela'),
    origemId: uuid('origem_id'),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_custos_obra').on(t.obraId, t.data),
    index('idx_custos_tenant_data').on(t.tenantId, t.data),
    index('idx_sync_custos').on(t.tenantId, t.updatedAt),
    // Idempotencia por origem: uma folha de salario gera um custo por obra, por
    // isso a obra entra na chave — sem ela, a segunda obra seria rejeitada.
    uniqueIndex('uq_custos_origem').on(t.tenantId, t.origemTabela, t.origemId, t.obraId),
    uniqueIndex('uq_sync_custos_client').on(t.tenantId, t.clientId),
  ],
);

/* ==========================================================================
   MATERIAIS E STOCK
   ========================================================================== */

export const materiais = pgTable(
  'materiais',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    nome: text('nome').notNull(),
    unidade: text('unidade').notNull(),
    categoria: text('categoria'),
    stockMinimo: numeric('stock_minimo', { precision: 14, scale: 3 }).notNull().default('0'),
    precoRef: numeric('preco_ref', { precision: 14, scale: 2 }),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    // `nome` gravado ja normalizado pela camada de servico (trim + collapse).
    uniqueIndex('uq_materiais_tenant_nome').on(t.tenantId, t.nome),
    index('idx_sync_materiais').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_materiais_client').on(t.tenantId, t.clientId),
  ],
);

export const fornecedores = pgTable(
  'fornecedores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    nome: text('nome').notNull(),
    nuit: text('nuit'),
    telefone: text('telefone'),
    email: text('email'),
    categoria: text('categoria'),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_fornecedores_tenant').on(t.tenantId),
    index('idx_sync_fornecedores').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_fornecedores_client').on(t.tenantId, t.clientId),
  ],
);

export const requisicoes = pgTable(
  'requisicoes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    solicitanteId: uuid('solicitante_id')
      .notNull()
      .references(() => utilizadores.id),
    aprovadorId: uuid('aprovador_id').references(() => utilizadores.id),
    estado: estadosRequisicaoEnum('estado').notNull().default('pendente'),
    observacoes: text('observacoes'),
    motivoRejeicao: text('motivo_rejeicao'),
    aprovadaEm: timestamp('aprovada_em', { withTimezone: true }),
    codigo: text('codigo'),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_requisicoes_tenant_estado').on(t.tenantId, t.estado),
    index('idx_requisicoes_obra').on(t.obraId),
    index('idx_sync_requisicoes').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_requisicoes_client').on(t.tenantId, t.clientId),
  ],
);

export const requisicaoItens = pgTable(
  'requisicao_itens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requisicaoId: uuid('requisicao_id')
      .notNull()
      .references(() => requisicoes.id, { onDelete: 'cascade' }),
    materialId: uuid('material_id')
      .notNull()
      .references(() => materiais.id),
    quantidade: numeric('quantidade', { precision: 14, scale: 3 }).notNull(),
    quantidadeAtendida: numeric('quantidade_atendida', { precision: 14, scale: 3 })
      .notNull()
      .default('0'),
    criadoEm: criadoEm(),
  },
  (t) => [index('idx_requisicao_itens_req').on(t.requisicaoId)],
);

export const stockMovimentos = pgTable(
  'stock_movimentos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    materialId: uuid('material_id')
      .notNull()
      .references(() => materiais.id),
    tipo: tiposMovimentoEnum('tipo').notNull(),
    quantidade: numeric('quantidade', { precision: 14, scale: 3 }).notNull(),
    precoUnitario: numeric('preco_unitario', { precision: 14, scale: 2 }),
    fornecedorId: uuid('fornecedor_id').references(() => fornecedores.id),
    requisicaoId: uuid('requisicao_id').references(() => requisicoes.id),
    utilizadorId: uuid('utilizador_id')
      .notNull()
      .references(() => utilizadores.id),
    /** Material a Transferencia: identifica a origem para poder estornar. */
    transferenciaParaObraId: uuid('transferencia_para_obra_id').references(() => obras.id),
    observacoes: text('observacoes'),
    data: timestamp('data', { withTimezone: true }).notNull().defaultNow(),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_stock_obra_mat').on(t.obraId, t.materialId),
    index('idx_stock_tenant_data').on(t.tenantId, t.data),
    index('idx_sync_stock').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_stock_client').on(t.tenantId, t.clientId),
  ],
);

/* ==========================================================================
   DIARIO DE OBRA
   ========================================================================== */

export const diarioObra = pgTable(
  'diario_obra',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    autorId: uuid('autor_id')
      .notNull()
      .references(() => utilizadores.id),
    data: date('data').notNull().defaultNow(),
    clima: text('clima'),
    trabalhos: text('trabalhos').notNull(),
    ocorrencias: text('ocorrencias'),
    progressoPct: numeric('progresso_pct', { precision: 5, scale: 2 }),
    /** Anula o efeito do progresso quando a entrada e corrigida. */
    semEfeito: boolean('sem_efeito').notNull().default(false),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_diario_obra_data').on(t.obraId, t.data),
    index('idx_sync_diario').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_diario_client').on(t.tenantId, t.clientId),
  ],
);

export const diarioFotos = pgTable(
  'diario_fotos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    diarioId: uuid('diario_id')
      .notNull()
      .references(() => diarioObra.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    legenda: text('legenda'),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    tiradaEm: timestamp('tirada_em', { withTimezone: true }).notNull().defaultNow(),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_diario_fotos_diario').on(t.diarioId),
    uniqueIndex('uq_sync_diario_fotos_client').on(t.tenantId, t.clientId),
  ],
);

/* ==========================================================================
   EQUIPAS, PONTO E SUBEMPREITEIROS
   ========================================================================== */

export const trabalhadores = pgTable(
  'trabalhadores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    nome: text('nome').notNull(),
    funcao: text('funcao'),
    documento: text('documento'),
    telefone: text('telefone'),
    tipo: tiposTrabalhadorEnum('tipo').notNull().default('diarista'),
    valorDia: numeric('valor_dia', { precision: 12, scale: 2 }).notNull().default('0'),
    moeda: char('moeda', { length: 3 }).notNull().default('MZN'),
    ativo: boolean('ativo').notNull().default(true),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_trabalhadores_tenant').on(t.tenantId),
    index('idx_sync_trabalhadores').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_trabalhadores_client').on(t.tenantId, t.clientId),
  ],
);

export const presencas = pgTable(
  'presencas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    trabalhadorId: uuid('trabalhador_id')
      .notNull()
      .references(() => trabalhadores.id),
    data: date('data').notNull().defaultNow(),
    presente: boolean('presente').notNull().default(true),
    horasExtra: numeric('horas_extra', { precision: 4, scale: 1 }).notNull().default('0'),
    registadoPor: uuid('registado_por')
      .notNull()
      .references(() => utilizadores.id),
    observacoes: text('observacoes'),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('uq_presencas_obra_trab_data').on(t.obraId, t.trabalhadorId, t.data),
    index('idx_presencas_obra_data').on(t.obraId, t.data),
    index('idx_presencas_trabalhador').on(t.trabalhadorId, t.data),
    index('idx_sync_presencas').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_presencas_client').on(t.tenantId, t.clientId),
  ],
);

/**
 * Folha de salario por periodo. Ao gerar a folha congelamos dias e horas; ao
 * lancar, criamos um custo `mao_de_obra` por obra com origem_id = folha.id,
 * o que torna a operacao idempotente.
 */
export const folhasSalario = pgTable(
  'folhas_salario',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    trabalhadorId: uuid('trabalhador_id')
      .notNull()
      .references(() => trabalhadores.id),
    periodoInicio: date('periodo_inicio').notNull(),
    periodoFim: date('periodo_fim').notNull(),
    dias: integer('dias').notNull().default(0),
    horasExtra: numeric('horas_extra', { precision: 6, scale: 1 }).notNull().default('0'),
    valor: numeric('valor', { precision: 14, scale: 2 }).notNull().default('0'),
    moeda: char('moeda', { length: 3 }).notNull().default('MZN'),
    estado: estadosFolhaEnum('estado').notNull().default('gerada'),
    lancadaEm: timestamp('lancada_em', { withTimezone: true }),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_folhas_trabalhador').on(t.trabalhadorId, t.periodoInicio),
    index('idx_sync_folhas').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_folhas_client').on(t.tenantId, t.clientId),
  ],
);

export const subempreiteiros = pgTable(
  'subempreiteiros',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    nome: text('nome').notNull(),
    nuit: text('nuit'),
    telefone: text('telefone'),
    especialidade: text('especialidade'),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_subempreiteiros_tenant').on(t.tenantId),
    index('idx_sync_subempreiteiros').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_subempreiteiros_client').on(t.tenantId, t.clientId),
  ],
);

export const contratosSubempreitada = pgTable(
  'contratos_subempreitada',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    subempreiteiroId: uuid('subempreiteiro_id')
      .notNull()
      .references(() => subempreiteiros.id),
    descricao: text('descricao').notNull(),
    valorContratado: numeric('valor_contratado', { precision: 14, scale: 2 }).notNull(),
    moeda: char('moeda', { length: 3 }).notNull().default('MZN'),
    dataInicio: date('data_inicio'),
    prazoDias: integer('prazo_dias'),
    estado: estadosContratoEnum('estado').notNull().default('activo'),
    codigo: text('codigo'),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_contratos_obra').on(t.obraId),
    index('idx_contratos_subempreiteiro').on(t.subempreiteiroId),
    index('idx_sync_contratos').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_contratos_client').on(t.tenantId, t.clientId),
  ],
);

/**
 * Medicao de obra por parte do subempreiteiro. E a medicao que vira custo
 * `subempreitada` (origem_id = medicao.id) e o limite do que se pode pagar.
 */
export const medicoes = pgTable(
  'medicoes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    contratoId: uuid('contrato_id')
      .notNull()
      .references(() => contratosSubempreitada.id),
    numero: integer('numero').notNull(),
    descricao: text('descricao'),
    valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
    data: date('data').notNull().defaultNow(),
    aprovadaEm: timestamp('aprovada_em', { withTimezone: true }),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('uq_medicoes_contrato_numero').on(t.contratoId, t.numero),
    index('idx_sync_medicoes').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_medicoes_client').on(t.tenantId, t.clientId),
  ],
);

/* ==========================================================================
   PAGAMENTOS
   ========================================================================== */

export const pagamentos = pgTable(
  'pagamentos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    obraId: uuid('obra_id')
      .notNull()
      .references(() => obras.id),
    beneficiarioTipo: tiposBeneficiarioEnum('beneficiario_tipo').notNull(),
    /** Aponta para trabalhadores/subempreiteiros/fornecedores conforme o tipo. */
    beneficiarioId: uuid('beneficiario_id'),
    /**
     * Quando o beneficiario e um subempreiteiro, o contrato que este pagamento
     * liquida. E o que impede pagar acima do contratado e o que permite fechar
     * a posicao por contrato.
     */
    contratoId: uuid('contrato_id').references(() => contratosSubempreitada.id),
    /**
     * Folha de salario que este pagamento liquida. Uma folha paga-se inteira,
     * por isso este campo existe para impedir que as horas sejam pagas duas
     * vezes (o estado da folha e a verdade, este campo e a pista de auditoria).
     */
    folhaId: uuid('folha_id').references(() => folhasSalario.id),
    descricao: text('descricao'),
    valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
    moeda: char('moeda', { length: 3 }).notNull().default('MZN'),
    taxaCambio: numeric('taxa_cambio', { precision: 12, scale: 6 }).notNull().default('1'),
    metodo: metodosPagamentoEnum('metodo').notNull(),
    referencia: text('referencia'),
    comprovativoUrl: text('comprovativo_url'),
    estado: estadosPagamentoEnum('estado').notNull().default('registado'),
    anuladoMotivo: text('anulado_motivo'),
    pagoEm: timestamp('pago_em', { withTimezone: true }).notNull().defaultNow(),
    registadoPor: uuid('registado_por')
      .notNull()
      .references(() => utilizadores.id),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_pagamentos_obra').on(t.obraId, t.pagoEm),
    index('idx_pagamentos_beneficiario').on(t.tenantId, t.beneficiarioTipo, t.beneficiarioId),
    index('idx_pagamentos_folha').on(t.folhaId),
    index('idx_sync_pagamentos').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_pagamentos_client').on(t.tenantId, t.clientId),
  ],
);

/* ==========================================================================
   TRANSACOES EXTERNAS (PaySuite)
   Registo de cada pedido de pagamento / payout / reembolso enviado ao
   gateway. E o ponto de reconciliacao entre a obra e o extracto do
   gateway: `external_id` e o ULID do PaySuite, `pagamento_id` e o
   pagamento interno que esta transacao liquida.
   ========================================================================== */

export const transacoesExternas = pgTable(
  'transacoes_externas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    tipo: tiposTransacaoExternaEnum('tipo').notNull(),
    /** Pagamento interno que esta transacao liquida (quando aplicavel). */
    pagamentoId: uuid('pagamento_id').references(() => pagamentos.id),
    metodo: metodosPaySuiteEnum('metodo').notNull(),
    valor: numeric('valor', { precision: 14, scale: 2 }).notNull(),
    moeda: char('moeda', { length: 3 }).notNull().default('MZN'),
    /** Referencia nossa, enviada ao gateway. Unica por tenant. */
    referencia: text('referencia').notNull(),
    /** ULID devolvido pelo PaySuite. */
    externalId: text('external_id'),
    status: estadosTransacaoExternaEnum('status').notNull().default('pending'),
    /** URL de checkout (payment requests). */
    checkoutUrl: text('checkout_url'),
    /** Id da transaccao no operador (ex.: MPESA123456). */
    transactionId: text('transaction_id'),
    pagoEm: timestamp('pago_em', { withTimezone: true }),
    beneficiarioTelefone: text('beneficiario_telefone'),
    beneficiarioTitular: text('beneficiario_titular'),
    beneficiarioNib: text('beneficiario_nib'),
    erro: text('erro'),
    /** Eventos de webhook ja processados, para idempotencia. */
    eventos: jsonb('eventos').notNull().default([]),
    registadoPor: uuid('registado_por')
      .notNull()
      .references(() => utilizadores.id),
    clientId: clientId(),
    criadoEm: criadoEm(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('idx_sync_transacoes_externas').on(t.tenantId, t.updatedAt),
    uniqueIndex('uq_sync_transacoes_externas_client').on(t.tenantId, t.clientId),
    uniqueIndex('uq_transacoes_externas_ref').on(t.tenantId, t.referencia),
    index('idx_transacoes_externas_pagamento').on(t.pagamentoId),
    index('idx_transacoes_externas_external').on(t.tenantId, t.externalId),
  ],
);

/* ==========================================================================
   RELACOES (para os query builder relacionais do drizzle)
   ========================================================================== */

export const tenantsRelations = relations(tenants, ({ many }) => ({
  utilizadores: many(utilizadores),
  obras: many(obras),
}));

export const utilizadoresRelations = relations(utilizadores, ({ one, many }) => ({
  tenant: one(tenants, { fields: [utilizadores.tenantId], references: [tenants.id] }),
  sessoes: many(sessoes),
}));

export const obrasRelations = relations(obras, ({ one, many }) => ({
  tenant: one(tenants, { fields: [obras.tenantId], references: [tenants.id] }),
  itens: many(orcamentoItens),
  custos: many(custos),
  movimentos: many(stockMovimentos),
}));

export const orcamentoItensRelations = relations(orcamentoItens, ({ one }) => ({
  obra: one(obras, { fields: [orcamentoItens.obraId], references: [obras.id] }),
}));

export const custosRelations = relations(custos, ({ one }) => ({
  obra: one(obras, { fields: [custos.obraId], references: [obras.id] }),
  orcamentoItem: one(orcamentoItens, {
    fields: [custos.orcamentoItemId],
    references: [orcamentoItens.id],
  }),
}));

export const materiaisRelations = relations(materiais, ({ many }) => ({
  movimentos: many(stockMovimentos),
}));

export const requisicoesRelations = relations(requisicoes, ({ one, many }) => ({
  obra: one(obras, { fields: [requisicoes.obraId], references: [obras.id] }),
  itens: many(requisicaoItens),
}));

export const requisicaoItensRelations = relations(requisicaoItens, ({ one }) => ({
  requisicao: one(requisicoes, {
    fields: [requisicaoItens.requisicaoId],
    references: [requisicoes.id],
  }),
  material: one(materiais, {
    fields: [requisicaoItens.materialId],
    references: [materiais.id],
  }),
}));

export const stockMovimentosRelations = relations(stockMovimentos, ({ one }) => ({
  obra: one(obras, { fields: [stockMovimentos.obraId], references: [obras.id] }),
  material: one(materiais, {
    fields: [stockMovimentos.materialId],
    references: [materiais.id],
  }),
}));

export const diarioObraRelations = relations(diarioObra, ({ one, many }) => ({
  obra: one(obras, { fields: [diarioObra.obraId], references: [obras.id] }),
  fotos: many(diarioFotos),
}));

export const diarioFotosRelations = relations(diarioFotos, ({ one }) => ({
  diario: one(diarioObra, { fields: [diarioFotos.diarioId], references: [diarioObra.id] }),
}));

export const trabalhadoresRelations = relations(trabalhadores, ({ many }) => ({
  presencas: many(presencas),
  folhas: many(folhasSalario),
}));

export const presencasRelations = relations(presencas, ({ one }) => ({
  trabalhador: one(trabalhadores, {
    fields: [presencas.trabalhadorId],
    references: [trabalhadores.id],
  }),
  obra: one(obras, { fields: [presencas.obraId], references: [obras.id] }),
}));

export const folhasSalarioRelations = relations(folhasSalario, ({ one }) => ({
  trabalhador: one(trabalhadores, {
    fields: [folhasSalario.trabalhadorId],
    references: [trabalhadores.id],
  }),
}));

export const contratosSubempreitadaRelations = relations(
  contratosSubempreitada,
  ({ one, many }) => ({
    obra: one(obras, { fields: [contratosSubempreitada.obraId], references: [obras.id] }),
    subempreiteiro: one(subempreiteiros, {
      fields: [contratosSubempreitada.subempreiteiroId],
      references: [subempreiteiros.id],
    }),
    medicoes: many(medicoes),
  }),
);

export const medicoesRelations = relations(medicoes, ({ one }) => ({
  contrato: one(contratosSubempreitada, {
    fields: [medicoes.contratoId],
    references: [contratosSubempreitada.id],
  }),
}));

export const pagamentosRelations = relations(pagamentos, ({ one }) => ({
  obra: one(obras, { fields: [pagamentos.obraId], references: [obras.id] }),
}));
