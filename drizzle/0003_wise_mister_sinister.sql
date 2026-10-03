CREATE TYPE "public"."estados_fatura" AS ENUM('emitida', 'anulada', 'paga');--> statement-breakpoint
CREATE TABLE "fatura_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"fatura_id" uuid NOT NULL,
	"descricao" text NOT NULL,
	"quantidade" numeric(14, 4) DEFAULT '1' NOT NULL,
	"preco_unitario" numeric(14, 2) NOT NULL,
	"iva_taxa" numeric(5, 4) DEFAULT '0.17' NOT NULL,
	"desconto" numeric(14, 2) DEFAULT '0' NOT NULL,
	"valor" numeric(14, 2) NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "faturas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"numero" text NOT NULL,
	"serie" text,
	"obra_id" uuid,
	"emitente_nome" text,
	"emitente_nuit" text,
	"emitente_endereco" text,
	"emitente_telefone" text,
	"cliente_nome" text NOT NULL,
	"cliente_nuit" text,
	"cliente_endereco" text,
	"cliente_telefone" text,
	"moeda" char(3) DEFAULT 'MZN' NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"desconto" numeric(14, 2) DEFAULT '0' NOT NULL,
	"iva_taxa" numeric(5, 4) DEFAULT '0.17' NOT NULL,
	"iva_valor" numeric(14, 2) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"estado" "estados_fatura" DEFAULT 'emitida' NOT NULL,
	"anulado_motivo" text,
	"data_emissao" timestamp with time zone DEFAULT now() NOT NULL,
	"data_vencimento" timestamp with time zone,
	"notas" text,
	"registado_por" uuid NOT NULL,
	"client_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "fatura_itens" ADD CONSTRAINT "fatura_itens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fatura_itens" ADD CONSTRAINT "fatura_itens_fatura_id_faturas_id_fk" FOREIGN KEY ("fatura_id") REFERENCES "public"."faturas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas" ADD CONSTRAINT "faturas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas" ADD CONSTRAINT "faturas_obra_id_obras_id_fk" FOREIGN KEY ("obra_id") REFERENCES "public"."obras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas" ADD CONSTRAINT "faturas_registado_por_utilizadores_id_fk" FOREIGN KEY ("registado_por") REFERENCES "public"."utilizadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sync_fatura_itens" ON "fatura_itens" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_fatura_itens_client" ON "fatura_itens" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_fatura_itens_fatura" ON "fatura_itens" USING btree ("fatura_id");--> statement-breakpoint
CREATE INDEX "idx_sync_faturas" ON "faturas" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_faturas_client" ON "faturas" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_faturas_numero" ON "faturas" USING btree ("tenant_id","numero");--> statement-breakpoint
CREATE INDEX "idx_faturas_obra" ON "faturas" USING btree ("obra_id");--> statement-breakpoint
CREATE INDEX "idx_faturas_cliente" ON "faturas" USING btree ("tenant_id","cliente_nuit");