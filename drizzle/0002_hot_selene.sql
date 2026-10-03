CREATE TYPE "public"."estados_transacao_externa" AS ENUM('pending', 'processing', 'paid', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."metodos_paysuite" AS ENUM('mpesa', 'emola', 'mkesh', 'credit_card', 'bank', 'bank_transfer');--> statement-breakpoint
CREATE TYPE "public"."tipos_transacao_externa" AS ENUM('payment_request', 'payout', 'refund');--> statement-breakpoint
CREATE TABLE "transacoes_externas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tipo" "tipos_transacao_externa" NOT NULL,
	"pagamento_id" uuid,
	"metodo" "metodos_paysuite" NOT NULL,
	"valor" numeric(14, 2) NOT NULL,
	"moeda" char(3) DEFAULT 'MZN' NOT NULL,
	"referencia" text NOT NULL,
	"external_id" text,
	"status" "estados_transacao_externa" DEFAULT 'pending' NOT NULL,
	"checkout_url" text,
	"transaction_id" text,
	"pago_em" timestamp with time zone,
	"beneficiario_telefone" text,
	"beneficiario_titular" text,
	"beneficiario_nib" text,
	"erro" text,
	"eventos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"registado_por" uuid NOT NULL,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "transacoes_externas" ADD CONSTRAINT "transacoes_externas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transacoes_externas" ADD CONSTRAINT "transacoes_externas_pagamento_id_pagamentos_id_fk" FOREIGN KEY ("pagamento_id") REFERENCES "public"."pagamentos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transacoes_externas" ADD CONSTRAINT "transacoes_externas_registado_por_utilizadores_id_fk" FOREIGN KEY ("registado_por") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sync_transacoes_externas" ON "transacoes_externas" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_transacoes_externas_client" ON "transacoes_externas" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_transacoes_externas_ref" ON "transacoes_externas" USING btree ("tenant_id","referencia");--> statement-breakpoint
CREATE INDEX "idx_transacoes_externas_pagamento" ON "transacoes_externas" USING btree ("pagamento_id");--> statement-breakpoint
CREATE INDEX "idx_transacoes_externas_external" ON "transacoes_externas" USING btree ("tenant_id","external_id");