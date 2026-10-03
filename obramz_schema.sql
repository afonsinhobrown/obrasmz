-- ObraMZ (nome provisório) — SaaS de gestão de obras
-- PostgreSQL | multi-tenant | offline-first (client_id + updated_at + deleted_at)
-- TECNOINCUBADORA

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============ BASE / MULTI-TENANT ============
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome        TEXT NOT NULL,
  nuit        TEXT,
  moeda_base  CHAR(3) NOT NULL DEFAULT 'MZN',
  logo_url    TEXT,
  plano       TEXT NOT NULL DEFAULT 'starter' CHECK (plano IN ('starter','pro','enterprise')),
  activo      BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE utilizadores (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  nome        TEXT NOT NULL,
  email       TEXT,
  telefone    TEXT,
  senha_hash  TEXT NOT NULL,
  papel       TEXT NOT NULL CHECK (papel IN ('admin','gestor','fiscal','encarregado','armazem','financeiro')),
  activo      BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, telefone)
);

-- Macro para colunas de sincronização (repetidas em cada tabela operacional):
--   client_id  UUID  -> id gerado no dispositivo (idempotência no sync)
--   updated_at TIMESTAMPTZ -> resolução de conflitos (last-write-wins)
--   deleted_at TIMESTAMPTZ -> soft delete para propagar apagamentos

-- ============ OBRAS E ORÇAMENTO ============
CREATE TABLE obras (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  codigo        TEXT NOT NULL,
  nome          TEXT NOT NULL,
  cliente       TEXT,
  localizacao   TEXT,
  latitude      NUMERIC(9,6),
  longitude     NUMERIC(9,6),
  moeda         CHAR(3) NOT NULL DEFAULT 'MZN',
  orcamento_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  data_inicio   DATE,
  data_fim_prevista DATE,
  estado        TEXT NOT NULL DEFAULT 'planeada' CHECK (estado IN ('planeada','em_curso','suspensa','concluida')),
  progresso_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (progresso_pct BETWEEN 0 AND 100),
  client_id     UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (tenant_id, codigo)
);

CREATE TABLE obra_membros (
  obra_id       UUID NOT NULL REFERENCES obras(id),
  utilizador_id UUID NOT NULL REFERENCES utilizadores(id),
  PRIMARY KEY (obra_id, utilizador_id)
);

-- Mapa de quantidades / orçamento por item
CREATE TABLE orcamento_itens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  obra_id       UUID NOT NULL REFERENCES obras(id),
  capitulo      TEXT,
  descricao     TEXT NOT NULL,
  unidade       TEXT NOT NULL,
  quantidade    NUMERIC(14,3) NOT NULL,
  preco_unitario NUMERIC(14,2) NOT NULL,
  total_orcado  NUMERIC(14,2) GENERATED ALWAYS AS (quantidade * preco_unitario) STORED,
  qtd_executada NUMERIC(14,3) NOT NULL DEFAULT 0,
  client_id     UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- Custos reais lançados contra a obra (base do "orçado vs real")
CREATE TABLE custos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  obra_id       UUID NOT NULL REFERENCES obras(id),
  orcamento_item_id UUID REFERENCES orcamento_itens(id),
  tipo          TEXT NOT NULL CHECK (tipo IN ('material','mao_de_obra','subempreitada','equipamento','outro')),
  descricao     TEXT NOT NULL,
  valor         NUMERIC(14,2) NOT NULL,
  moeda         CHAR(3) NOT NULL DEFAULT 'MZN',
  taxa_cambio   NUMERIC(12,6) NOT NULL DEFAULT 1,
  data          DATE NOT NULL DEFAULT CURRENT_DATE,
  origem_tabela TEXT,
  origem_id     UUID,
  client_id     UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- ============ MATERIAIS E STOCK ============
CREATE TABLE materiais (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  nome        TEXT NOT NULL,
  unidade     TEXT NOT NULL,
  stock_minimo NUMERIC(14,3) NOT NULL DEFAULT 0,
  preco_ref   NUMERIC(14,2),
  client_id   UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE (tenant_id, nome)
);

CREATE TABLE fornecedores (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  nome        TEXT NOT NULL,
  nuit        TEXT,
  telefone    TEXT,
  client_id   UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE requisicoes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  obra_id       UUID NOT NULL REFERENCES obras(id),
  solicitante_id UUID NOT NULL REFERENCES utilizadores(id),
  aprovador_id  UUID REFERENCES utilizadores(id),
  estado        TEXT NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente','aprovada','rejeitada','atendida')),
  observacoes   TEXT,
  criada_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_id     UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE requisicao_itens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisicao_id UUID NOT NULL REFERENCES requisicoes(id),
  material_id   UUID NOT NULL REFERENCES materiais(id),
  quantidade    NUMERIC(14,3) NOT NULL CHECK (quantidade > 0)
);

-- Stock = soma dos movimentos por (obra, material)
CREATE TABLE stock_movimentos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  obra_id       UUID NOT NULL REFERENCES obras(id),
  material_id   UUID NOT NULL REFERENCES materiais(id),
  tipo          TEXT NOT NULL CHECK (tipo IN ('entrada','saida','ajuste','transferencia')),
  quantidade    NUMERIC(14,3) NOT NULL,
  preco_unitario NUMERIC(14,2),
  fornecedor_id UUID REFERENCES fornecedores(id),
  requisicao_id UUID REFERENCES requisicoes(id),
  utilizador_id UUID NOT NULL REFERENCES utilizadores(id),
  data          TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_id     UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE VIEW v_stock_actual AS
SELECT tenant_id, obra_id, material_id,
       SUM(CASE WHEN tipo IN ('entrada','ajuste') THEN quantidade
                WHEN tipo = 'saida' THEN -quantidade ELSE 0 END) AS saldo
FROM stock_movimentos
WHERE deleted_at IS NULL
GROUP BY tenant_id, obra_id, material_id;

-- ============ DIÁRIO DE OBRA ============
CREATE TABLE diario_obra (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  obra_id       UUID NOT NULL REFERENCES obras(id),
  autor_id      UUID NOT NULL REFERENCES utilizadores(id),
  data          DATE NOT NULL DEFAULT CURRENT_DATE,
  clima         TEXT,
  trabalhos     TEXT NOT NULL,
  ocorrencias   TEXT,
  progresso_pct NUMERIC(5,2),
  client_id     UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE diario_fotos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  diario_id   UUID NOT NULL REFERENCES diario_obra(id),
  url         TEXT NOT NULL,
  legenda     TEXT,
  latitude    NUMERIC(9,6),
  longitude   NUMERIC(9,6),
  tirada_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_id   UUID
);

-- ============ EQUIPAS, PONTO E SUBEMPREITEIROS ============
CREATE TABLE trabalhadores (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  nome        TEXT NOT NULL,
  funcao      TEXT,
  documento   TEXT,
  telefone    TEXT,
  tipo        TEXT NOT NULL DEFAULT 'diarista' CHECK (tipo IN ('diarista','efectivo')),
  valor_dia   NUMERIC(12,2) NOT NULL DEFAULT 0,
  moeda       CHAR(3) NOT NULL DEFAULT 'MZN',
  client_id   UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE presencas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  obra_id        UUID NOT NULL REFERENCES obras(id),
  trabalhador_id UUID NOT NULL REFERENCES trabalhadores(id),
  data           DATE NOT NULL DEFAULT CURRENT_DATE,
  presente       BOOLEAN NOT NULL DEFAULT TRUE,
  horas_extra    NUMERIC(4,1) NOT NULL DEFAULT 0,
  registado_por  UUID NOT NULL REFERENCES utilizadores(id),
  client_id      UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  UNIQUE (obra_id, trabalhador_id, data)
);

CREATE TABLE subempreiteiros (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  nome        TEXT NOT NULL,
  nuit        TEXT,
  telefone    TEXT,
  especialidade TEXT,
  client_id   UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE contratos_subempreitada (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  obra_id         UUID NOT NULL REFERENCES obras(id),
  subempreiteiro_id UUID NOT NULL REFERENCES subempreiteiros(id),
  descricao       TEXT NOT NULL,
  valor_contratado NUMERIC(14,2) NOT NULL,
  moeda           CHAR(3) NOT NULL DEFAULT 'MZN',
  estado          TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','concluido','cancelado')),
  client_id       UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- ============ PAGAMENTOS ============
CREATE TABLE pagamentos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  obra_id       UUID NOT NULL REFERENCES obras(id),
  beneficiario_tipo TEXT NOT NULL CHECK (beneficiario_tipo IN ('trabalhador','subempreiteiro','fornecedor','outro')),
  beneficiario_id UUID,
  descricao     TEXT,
  valor         NUMERIC(14,2) NOT NULL CHECK (valor > 0),
  moeda         CHAR(3) NOT NULL DEFAULT 'MZN',
  metodo        TEXT NOT NULL CHECK (metodo IN ('numerario','mpesa','emola','transferencia','cheque')),
  referencia    TEXT,
  comprovativo_url TEXT,
  estado        TEXT NOT NULL DEFAULT 'registado' CHECK (estado IN ('registado','confirmado','anulado')),
  pago_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  registado_por UUID NOT NULL REFERENCES utilizadores(id),
  client_id     UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- ============ VISTA: ORÇADO VS REAL ============
CREATE VIEW v_obra_orcado_vs_real AS
SELECT o.id AS obra_id, o.tenant_id, o.nome,
       o.orcamento_total AS orcado,
       COALESCE(SUM(c.valor * c.taxa_cambio) FILTER (WHERE c.deleted_at IS NULL), 0) AS real,
       o.orcamento_total - COALESCE(SUM(c.valor * c.taxa_cambio) FILTER (WHERE c.deleted_at IS NULL), 0) AS saldo
FROM obras o
LEFT JOIN custos c ON c.obra_id = o.id
GROUP BY o.id;

-- ============ ÍNDICES ============
CREATE INDEX idx_obras_tenant        ON obras(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_custos_obra         ON custos(obra_id, data);
CREATE INDEX idx_stock_obra_mat      ON stock_movimentos(obra_id, material_id);
CREATE INDEX idx_diario_obra_data    ON diario_obra(obra_id, data);
CREATE INDEX idx_presencas_obra_data ON presencas(obra_id, data);
CREATE INDEX idx_pagamentos_obra     ON pagamentos(obra_id, pago_em);
-- Sync incremental: o cliente pede tudo com updated_at > último sync
CREATE INDEX idx_sync_obras          ON obras(tenant_id, updated_at);
CREATE INDEX idx_sync_stock          ON stock_movimentos(tenant_id, updated_at);
CREATE INDEX idx_sync_diario         ON diario_obra(tenant_id, updated_at);
CREATE INDEX idx_sync_presencas      ON presencas(tenant_id, updated_at);
