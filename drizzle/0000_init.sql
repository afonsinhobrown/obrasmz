CREATE TYPE "public"."estados_contrato" AS ENUM('activo', 'concluido', 'cancelado');--> statement-breakpoint
CREATE TYPE "public"."estados_folha" AS ENUM('gerada', 'lancada', 'paga', 'anulada');--> statement-breakpoint
CREATE TYPE "public"."estados_obra" AS ENUM('planeada', 'em_curso', 'suspensa', 'concluida');--> statement-breakpoint
CREATE TYPE "public"."estados_pagamento" AS ENUM('registado', 'confirmado', 'anulado');--> statement-breakpoint
CREATE TYPE "public"."estados_requisicao" AS ENUM('pendente', 'aprovada', 'rejeitada', 'atendida');--> statement-breakpoint
CREATE TYPE "public"."metodos_pagamento" AS ENUM('numerario', 'mpesa', 'emola', 'transferencia', 'cheque');--> statement-breakpoint
CREATE TYPE "public"."papeis" AS ENUM('admin', 'gestor', 'fiscal', 'encarregado', 'armazem', 'financeiro');--> statement-breakpoint
CREATE TYPE "public"."planos" AS ENUM('starter', 'pro', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."tipos_beneficiario" AS ENUM('trabalhador', 'subempreiteiro', 'fornecedor', 'outro');--> statement-breakpoint
CREATE TYPE "public"."tipos_custo" AS ENUM('material', 'mao_de_obra', 'subempreitada', 'equipamento', 'outro');--> statement-breakpoint
CREATE TYPE "public"."tipos_movimento" AS ENUM('entrada', 'saida', 'ajuste', 'transferencia');--> statement-breakpoint
CREATE TYPE "public"."tipos_trabalhador" AS ENUM('diarista', 'efectivo');--> statement-breakpoint
CREATE TABLE "contratos_subempreitada" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"obra_id" uuid NOT NULL,
	"subempreiteiro_id" uuid NOT NULL,
	"descricao" text NOT NULL,
	"valor_contratado" numeric(14, 2) NOT NULL,
	"moeda" char(3) DEFAULT 'MZN' NOT NULL,
	"data_inicio" date,
	"prazo_dias" integer,
	"estado" "estados_contrato" DEFAULT 'activo' NOT NULL,
	"codigo" text,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "custos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"obra_id" uuid NOT NULL,
	"orcamento_item_id" uuid,
	"tipo" "tipos_custo" NOT NULL,
	"descricao" text NOT NULL,
	"valor" numeric(14, 2) NOT NULL,
	"moeda" char(3) DEFAULT 'MZN' NOT NULL,
	"taxa_cambio" numeric(12, 6) DEFAULT '1' NOT NULL,
	"data" date DEFAULT now() NOT NULL,
	"origem_tabela" text,
	"origem_id" uuid,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "diario_fotos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"diario_id" uuid NOT NULL,
	"url" text NOT NULL,
	"legenda" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"tirada_em" timestamp with time zone DEFAULT now() NOT NULL,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "diario_obra" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"obra_id" uuid NOT NULL,
	"autor_id" uuid NOT NULL,
	"data" date DEFAULT now() NOT NULL,
	"clima" text,
	"trabalhos" text NOT NULL,
	"ocorrencias" text,
	"progresso_pct" numeric(5, 2),
	"sem_efeito" boolean DEFAULT false NOT NULL,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dispositivos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"utilizador_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"plataforma" text,
	"ultimo_sync_em" timestamp with time zone,
	"sync_cursor" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folhas_salario" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trabalhador_id" uuid NOT NULL,
	"periodo_inicio" date NOT NULL,
	"periodo_fim" date NOT NULL,
	"dias" integer DEFAULT 0 NOT NULL,
	"horas_extra" numeric(6, 1) DEFAULT '0' NOT NULL,
	"valor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"moeda" char(3) DEFAULT 'MZN' NOT NULL,
	"estado" "estados_folha" DEFAULT 'gerada' NOT NULL,
	"lancada_em" timestamp with time zone,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fornecedores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"nuit" text,
	"telefone" text,
	"email" text,
	"categoria" text,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "log_auditoria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"utilizador_id" uuid,
	"accao" text NOT NULL,
	"entidade" text NOT NULL,
	"entidade_id" uuid,
	"dados_antes" jsonb,
	"dados_depois" jsonb,
	"ip" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "materiais" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"unidade" text NOT NULL,
	"categoria" text,
	"stock_minimo" numeric(14, 3) DEFAULT '0' NOT NULL,
	"preco_ref" numeric(14, 2),
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "medicoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contrato_id" uuid NOT NULL,
	"numero" integer NOT NULL,
	"descricao" text,
	"valor" numeric(14, 2) NOT NULL,
	"data" date DEFAULT now() NOT NULL,
	"aprovada_em" timestamp with time zone,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "numeros_documento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"ano" integer NOT NULL,
	"numero" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obra_membros" (
	"obra_id" uuid NOT NULL,
	"utilizador_id" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obra_membros_obra_id_utilizador_id_pk" PRIMARY KEY("obra_id","utilizador_id")
);
--> statement-breakpoint
CREATE TABLE "obras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"codigo" text NOT NULL,
	"nome" text NOT NULL,
	"cliente" text,
	"localizacao" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"moeda" char(3) DEFAULT 'MZN' NOT NULL,
	"orcamento_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"data_inicio" date,
	"data_fim_prevista" date,
	"estado" "estados_obra" DEFAULT 'planeada' NOT NULL,
	"progresso_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"descricao" text,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orcamento_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"obra_id" uuid NOT NULL,
	"capitulo" text,
	"descricao" text NOT NULL,
	"unidade" text NOT NULL,
	"quantidade" numeric(14, 3) NOT NULL,
	"preco_unitario" numeric(14, 2) NOT NULL,
	"total_orcado" numeric(14, 2) GENERATED ALWAYS AS ("quantidade" * "preco_unitario") STORED,
	"qtd_executada" numeric(14, 3) DEFAULT '0' NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pagamentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"obra_id" uuid NOT NULL,
	"beneficiario_tipo" "tipos_beneficiario" NOT NULL,
	"beneficiario_id" uuid,
	"contrato_id" uuid,
	"folha_id" uuid,
	"descricao" text,
	"valor" numeric(14, 2) NOT NULL,
	"moeda" char(3) DEFAULT 'MZN' NOT NULL,
	"taxa_cambio" numeric(12, 6) DEFAULT '1' NOT NULL,
	"metodo" "metodos_pagamento" NOT NULL,
	"referencia" text,
	"comprovativo_url" text,
	"estado" "estados_pagamento" DEFAULT 'registado' NOT NULL,
	"anulado_motivo" text,
	"pago_em" timestamp with time zone DEFAULT now() NOT NULL,
	"registado_por" uuid NOT NULL,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "presencas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"obra_id" uuid NOT NULL,
	"trabalhador_id" uuid NOT NULL,
	"data" date DEFAULT now() NOT NULL,
	"presente" boolean DEFAULT true NOT NULL,
	"horas_extra" numeric(4, 1) DEFAULT '0' NOT NULL,
	"registado_por" uuid NOT NULL,
	"observacoes" text,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "requisicao_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requisicao_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"quantidade" numeric(14, 3) NOT NULL,
	"quantidade_atendida" numeric(14, 3) DEFAULT '0' NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requisicoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"obra_id" uuid NOT NULL,
	"solicitante_id" uuid NOT NULL,
	"aprovador_id" uuid,
	"estado" "estados_requisicao" DEFAULT 'pendente' NOT NULL,
	"observacoes" text,
	"motivo_rejeicao" text,
	"aprovada_em" timestamp with time zone,
	"codigo" text,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"utilizador_id" uuid NOT NULL,
	"refresh_hash" text NOT NULL,
	"dispositivo_id" uuid,
	"expira_em" timestamp with time zone NOT NULL,
	"revogada_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movimentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"obra_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"tipo" "tipos_movimento" NOT NULL,
	"quantidade" numeric(14, 3) NOT NULL,
	"preco_unitario" numeric(14, 2),
	"fornecedor_id" uuid,
	"requisicao_id" uuid,
	"utilizador_id" uuid NOT NULL,
	"transferencia_para_obra_id" uuid,
	"observacoes" text,
	"data" timestamp with time zone DEFAULT now() NOT NULL,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subempreiteiros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"nuit" text,
	"telefone" text,
	"especialidade" text,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "taxas_cambio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"moeda" char(3) NOT NULL,
	"data" date NOT NULL,
	"taxa" numeric(12, 6) NOT NULL,
	"fonte" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"nuit" text,
	"moeda_base" char(3) DEFAULT 'MZN' NOT NULL,
	"logo_url" text,
	"plano" "planos" DEFAULT 'starter' NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"max_obras" integer DEFAULT 5 NOT NULL,
	"max_utilizadores" integer DEFAULT 3 NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trabalhadores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"funcao" text,
	"documento" text,
	"telefone" text,
	"tipo" "tipos_trabalhador" DEFAULT 'diarista' NOT NULL,
	"valor_dia" numeric(12, 2) DEFAULT '0' NOT NULL,
	"moeda" char(3) DEFAULT 'MZN' NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "utilizadores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"email" text,
	"telefone" text,
	"senha_hash" text NOT NULL,
	"papel" "papeis" NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"ultimo_acesso_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contratos_subempreitada" ADD CONSTRAINT "contratos_subempreitada_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contratos_subempreitada" ADD CONSTRAINT "contratos_subempreitada_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contratos_subempreitada" ADD CONSTRAINT "contratos_subempreitada_subempreiteiro_id_subempreiteiros_id_fk" FOREIGN KEY ("subempreiteiro_id") REFERENCES "public"."subempreiteiros"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custos" ADD CONSTRAINT "custos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custos" ADD CONSTRAINT "custos_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custos" ADD CONSTRAINT "custos_orcamento_item_id_orcamento_itens_id_fk" FOREIGN KEY ("orcamento_item_id") REFERENCES "public"."orcamento_itens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diario_fotos" ADD CONSTRAINT "diario_fotos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diario_fotos" ADD CONSTRAINT "diario_fotos_diario_id_diario_obra_id_fk" FOREIGN KEY ("diario_id") REFERENCES "public"."diario_obra"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diario_obra" ADD CONSTRAINT "diario_obra_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diario_obra" ADD CONSTRAINT "diario_obra_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diario_obra" ADD CONSTRAINT "diario_obra_autor_id_utilizadores_id_fk" FOREIGN KEY ("autor_id") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispositivos" ADD CONSTRAINT "dispositivos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispositivos" ADD CONSTRAINT "dispositivos_utilizador_id_utilizadores_id_fk" FOREIGN KEY ("utilizador_id") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folhas_salario" ADD CONSTRAINT "folhas_salario_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folhas_salario" ADD CONSTRAINT "folhas_salario_trabalhador_id_trabalhadores_id_fk" FOREIGN KEY ("trabalhador_id") REFERENCES "public"."trabalhadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fornecedores" ADD CONSTRAINT "fornecedores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_auditoria" ADD CONSTRAINT "log_auditoria_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_auditoria" ADD CONSTRAINT "log_auditoria_utilizador_id_utilizadores_id_fk" FOREIGN KEY ("utilizador_id") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materiais" ADD CONSTRAINT "materiais_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicoes" ADD CONSTRAINT "medicoes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicoes" ADD CONSTRAINT "medicoes_contrato_id_contratos_subempreitada_id_fk" FOREIGN KEY ("contrato_id") REFERENCES "public"."contratos_subempreitada"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numeros_documento" ADD CONSTRAINT "numeros_documento_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obra_membros" ADD CONSTRAINT "obra_membros_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obra_membros" ADD CONSTRAINT "obra_membros_utilizador_id_utilizadores_id_fk" FOREIGN KEY ("utilizador_id") REFERENCES "public"."utilizadores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obras" ADD CONSTRAINT "obras_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamento_itens" ADD CONSTRAINT "orcamento_itens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamento_itens" ADD CONSTRAINT "orcamento_itens_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos" ADD CONSTRAINT "pagamentos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos" ADD CONSTRAINT "pagamentos_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos" ADD CONSTRAINT "pagamentos_contrato_id_contratos_subempreitada_id_fk" FOREIGN KEY ("contrato_id") REFERENCES "public"."contratos_subempreitada"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos" ADD CONSTRAINT "pagamentos_folha_id_folhas_salario_id_fk" FOREIGN KEY ("folha_id") REFERENCES "public"."folhas_salario"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos" ADD CONSTRAINT "pagamentos_registado_por_utilizadores_id_fk" FOREIGN KEY ("registado_por") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presencas" ADD CONSTRAINT "presencas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presencas" ADD CONSTRAINT "presencas_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presencas" ADD CONSTRAINT "presencas_trabalhador_id_trabalhadores_id_fk" FOREIGN KEY ("trabalhador_id") REFERENCES "public"."trabalhadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presencas" ADD CONSTRAINT "presencas_registado_por_utilizadores_id_fk" FOREIGN KEY ("registado_por") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisicao_itens" ADD CONSTRAINT "requisicao_itens_requisicao_id_requisicoes_id_fk" FOREIGN KEY ("requisicao_id") REFERENCES "public"."requisicoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisicao_itens" ADD CONSTRAINT "requisicao_itens_material_id_materiais_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materiais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisicoes" ADD CONSTRAINT "requisicoes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisicoes" ADD CONSTRAINT "requisicoes_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisicoes" ADD CONSTRAINT "requisicoes_solicitante_id_utilizadores_id_fk" FOREIGN KEY ("solicitante_id") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisicoes" ADD CONSTRAINT "requisicoes_aprovador_id_utilizadores_id_fk" FOREIGN KEY ("aprovador_id") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_utilizador_id_utilizadores_id_fk" FOREIGN KEY ("utilizador_id") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_dispositivo_id_dispositivos_id_fk" FOREIGN KEY ("dispositivo_id") REFERENCES "public"."dispositivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movimentos" ADD CONSTRAINT "stock_movimentos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movimentos" ADD CONSTRAINT "stock_movimentos_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movimentos" ADD CONSTRAINT "stock_movimentos_material_id_materiais_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materiais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movimentos" ADD CONSTRAINT "stock_movimentos_fornecedor_id_fornecedores_id_fk" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."fornecedores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movimentos" ADD CONSTRAINT "stock_movimentos_requisicao_id_requisicoes_id_fk" FOREIGN KEY ("requisicao_id") REFERENCES "public"."requisicoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movimentos" ADD CONSTRAINT "stock_movimentos_utilizador_id_utilizadores_id_fk" FOREIGN KEY ("utilizador_id") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movimentos" ADD CONSTRAINT "stock_movimentos_transferencia_para_obra_id_obras_id_fk" FOREIGN KEY ("transferencia_para_obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subempreiteiros" ADD CONSTRAINT "subempreiteiros_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxas_cambio" ADD CONSTRAINT "taxas_cambio_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trabalhadores" ADD CONSTRAINT "trabalhadores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utilizadores" ADD CONSTRAINT "utilizadores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_contratos_obra" ON "contratos_subempreitada" USING btree ("obra_id");--> statement-breakpoint
CREATE INDEX "idx_contratos_subempreiteiro" ON "contratos_subempreitada" USING btree ("subempreiteiro_id");--> statement-breakpoint
CREATE INDEX "idx_sync_contratos" ON "contratos_subempreitada" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_contratos_client" ON "contratos_subempreitada" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_custos_obra" ON "custos" USING btree ("obra_id","data");--> statement-breakpoint
CREATE INDEX "idx_custos_tenant_data" ON "custos" USING btree ("tenant_id","data");--> statement-breakpoint
CREATE INDEX "idx_sync_custos" ON "custos" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custos_origem" ON "custos" USING btree ("tenant_id","origem_tabela","origem_id","obra_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_custos_client" ON "custos" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_diario_fotos_diario" ON "diario_fotos" USING btree ("diario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_diario_fotos_client" ON "diario_fotos" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_diario_obra_data" ON "diario_obra" USING btree ("obra_id","data");--> statement-breakpoint
CREATE INDEX "idx_sync_diario" ON "diario_obra" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_diario_client" ON "diario_obra" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_dispositivos_utilizador" ON "dispositivos" USING btree ("utilizador_id");--> statement-breakpoint
CREATE INDEX "idx_folhas_trabalhador" ON "folhas_salario" USING btree ("trabalhador_id","periodo_inicio");--> statement-breakpoint
CREATE INDEX "idx_sync_folhas" ON "folhas_salario" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_folhas_client" ON "folhas_salario" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_fornecedores_tenant" ON "fornecedores" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_sync_fornecedores" ON "fornecedores" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_fornecedores_client" ON "fornecedores" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_auditoria_tenant_data" ON "log_auditoria" USING btree ("tenant_id","criado_em");--> statement-breakpoint
CREATE INDEX "idx_auditoria_entidade" ON "log_auditoria" USING btree ("entidade","entidade_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_materiais_tenant_nome" ON "materiais" USING btree ("tenant_id","nome");--> statement-breakpoint
CREATE INDEX "idx_sync_materiais" ON "materiais" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_materiais_client" ON "materiais" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_medicoes_contrato_numero" ON "medicoes" USING btree ("contrato_id","numero");--> statement-breakpoint
CREATE INDEX "idx_sync_medicoes" ON "medicoes" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_medicoes_client" ON "medicoes" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_numeros_documento" ON "numeros_documento" USING btree ("tenant_id","tipo","ano");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_obras_tenant_codigo" ON "obras" USING btree ("tenant_id","codigo");--> statement-breakpoint
CREATE INDEX "idx_obras_tenant" ON "obras" USING btree ("tenant_id") WHERE "obras"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_sync_obras" ON "obras" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_obras_client" ON "obras" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_orcamento_itens_obra" ON "orcamento_itens" USING btree ("obra_id");--> statement-breakpoint
CREATE INDEX "idx_sync_orcamento_itens" ON "orcamento_itens" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_orcamento_itens_client" ON "orcamento_itens" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_pagamentos_obra" ON "pagamentos" USING btree ("obra_id","pago_em");--> statement-breakpoint
CREATE INDEX "idx_pagamentos_beneficiario" ON "pagamentos" USING btree ("tenant_id","beneficiario_tipo","beneficiario_id");--> statement-breakpoint
CREATE INDEX "idx_pagamentos_folha" ON "pagamentos" USING btree ("folha_id");--> statement-breakpoint
CREATE INDEX "idx_sync_pagamentos" ON "pagamentos" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_pagamentos_client" ON "pagamentos" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_presencas_obra_trab_data" ON "presencas" USING btree ("obra_id","trabalhador_id","data");--> statement-breakpoint
CREATE INDEX "idx_presencas_obra_data" ON "presencas" USING btree ("obra_id","data");--> statement-breakpoint
CREATE INDEX "idx_presencas_trabalhador" ON "presencas" USING btree ("trabalhador_id","data");--> statement-breakpoint
CREATE INDEX "idx_sync_presencas" ON "presencas" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_presencas_client" ON "presencas" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_requisicao_itens_req" ON "requisicao_itens" USING btree ("requisicao_id");--> statement-breakpoint
CREATE INDEX "idx_requisicoes_tenant_estado" ON "requisicoes" USING btree ("tenant_id","estado");--> statement-breakpoint
CREATE INDEX "idx_requisicoes_obra" ON "requisicoes" USING btree ("obra_id");--> statement-breakpoint
CREATE INDEX "idx_sync_requisicoes" ON "requisicoes" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_requisicoes_client" ON "requisicoes" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sessoes_refresh" ON "sessoes" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "idx_sessoes_utilizador" ON "sessoes" USING btree ("utilizador_id");--> statement-breakpoint
CREATE INDEX "idx_stock_obra_mat" ON "stock_movimentos" USING btree ("obra_id","material_id");--> statement-breakpoint
CREATE INDEX "idx_stock_tenant_data" ON "stock_movimentos" USING btree ("tenant_id","data");--> statement-breakpoint
CREATE INDEX "idx_sync_stock" ON "stock_movimentos" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_stock_client" ON "stock_movimentos" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_subempreiteiros_tenant" ON "subempreiteiros" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_sync_subempreiteiros" ON "subempreiteiros" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_subempreiteiros_client" ON "subempreiteiros" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_taxas_cambio" ON "taxas_cambio" USING btree ("tenant_id","moeda","data");--> statement-breakpoint
CREATE INDEX "idx_taxas_cambio_lookup" ON "taxas_cambio" USING btree ("tenant_id","moeda","data");--> statement-breakpoint
CREATE INDEX "idx_trabalhadores_tenant" ON "trabalhadores" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_sync_trabalhadores" ON "trabalhadores" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_trabalhadores_client" ON "trabalhadores" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_utilizadores_tenant_email" ON "utilizadores" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_utilizadores_tenant_telefone" ON "utilizadores" USING btree ("tenant_id","telefone");--> statement-breakpoint
CREATE INDEX "idx_utilizadores_tenant" ON "utilizadores" USING btree ("tenant_id");