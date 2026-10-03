-- ==========================================================================
-- OBRA MZ â€” vistas, constraints de negocio e trigger de updated_at
--
-- O drizzle so sabe descrever colunas, indices e chaves. As regras que
-- pertencem a UMA operacao (um saldo que nao pode ficar negativo, um preco que
-- tem de ser positivo, um pagamento que nao pode exceder a medicao) vivem
-- aqui, no motor, para que nenhuma aplicacao â€” nem um script escrito a mao â€”
-- as consiga contornar.
-- ==========================================================================

-- ==========================================================================
-- 1. CONSTRAINTS
-- ==========================================================================

-- Um progresso acima de 100% ou abaixo de 0% e sempre um erro de escrita.
ALTER TABLE "obras"
  ADD CONSTRAINT "ck_obras_progresso" CHECK ("progresso_pct" BETWEEN 0 AND 100);

-- Uma entrada de diario so define progresso se for um valor plausivel.
ALTER TABLE "diario_obra"
  ADD CONSTRAINT "ck_diario_progresso" CHECK ("progresso_pct" IS NULL OR "progresso_pct" BETWEEN 0 AND 100);

-- Custos, medicoes e pagamentos nunca sao negativos: o sinal do movimento
-- esta no `tipo`, nunca no valor.
ALTER TABLE "custos"
  ADD CONSTRAINT "ck_custos_valor" CHECK ("valor" > 0),
  ADD CONSTRAINT "ck_custos_taxa" CHECK ("taxa_cambio" > 0);

ALTER TABLE "orcamento_itens"
  ADD CONSTRAINT "ck_orcamento_valores" CHECK ("quantidade" > 0 AND ("preco_unitario" IS NULL OR "preco_unitario" >= 0));

-- `quantidade` e sempre magnitude positiva; `ajuste` e o unico tipo
-- assinado, porque e uma correccao de inventario. A `v_stock_actual` depende
-- deste invariante para saber o sentido de cada movimento.
ALTER TABLE "stock_movimentos"
  ADD CONSTRAINT "ck_stock_quantidade" CHECK (
    ("tipo" = 'ajuste' AND "quantidade" <> 0)
    OR ("tipo" <> 'ajuste' AND "quantidade" > 0)
  );

ALTER TABLE "materiais"
  ADD CONSTRAINT "ck_materiais_stock" CHECK ("stock_minimo" >= 0);

-- Medir mais do que o contratado, ou medir a partir de uma medicao anulada,
-- e erro de Processo. A regra completa (soma das medicoes <= contratado) vive
-- no servico, porque precisa de ver o agregado.
ALTER TABLE "medicoes"
  ADD CONSTRAINT "ck_medicoes_valor" CHECK ("valor" > 0);

ALTER TABLE "pagamentos"
  ADD CONSTRAINT "ck_pagamentos_valor" CHECK ("valor" > 0),
  ADD CONSTRAINT "ck_pagamentos_taxa" CHECK ("taxa_cambio" > 0);

ALTER TABLE "trabalhadores"
  ADD CONSTRAINT "ck_trabalhadores_salario" CHECK ("valor_dia" IS NULL OR "valor_dia" >= 0);

ALTER TABLE "presencas"
  ADD CONSTRAINT "ck_presencas_extra" CHECK ("horas_extra" >= 0);

ALTER TABLE "folhas_salario"
  ADD CONSTRAINT "ck_folhas_valores" CHECK ("valor" >= 0);

-- Um contrato so pode ter medicao se for `activo` â€” o estado de "concluido"
-- significa que a obra foi entregue e nao ha mais o que medir.
ALTER TABLE "contratos_subempreitada"
  ADD CONSTRAINT "ck_contratos_prazo" CHECK ("prazo_dias" IS NULL OR "prazo_dias" > 0);

-- ==========================================================================
-- 2. VISTAS
-- ==========================================================================

-- --------------------------------------------------------------------------
-- v_stock_actual â€” saldo por obra e material.
--
-- O sinal vem do `tipo`: `entrada` soma, `saida` e `transferencia`
-- subtraem, `ajuste` soma com o seu proprio sinal. E por isso que
-- `quantidade` e gravada como magnitude positiva â€” se gravassemos saidas
-- negativas, esta vista subtrairia duas vezes.
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_stock_actual AS
SELECT m.tenant_id,
       m.obra_id,
       m.material_id,
       SUM(
         CASE
           WHEN m.tipo = 'entrada'      THEN  m.quantidade
           WHEN m.tipo IN ('saida','transferencia') THEN -m.quantidade
           WHEN m.tipo = 'ajuste'       THEN  m.quantidade  -- pode ser negativo
           ELSE 0
         END
       ) AS saldo
FROM stock_movimentos m
WHERE m.deleted_at IS NULL
GROUP BY m.tenant_id, m.obra_id, m.material_id;

-- --------------------------------------------------------------------------
-- v_custo_medio â€” custo medio ponderado por material, media movel.
--
-- Media movel simples: soma das entradas a preco / soma das quantidades.
-- E o que permite valorizar o stock que ainda esta em armazem.
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_custo_medio AS
SELECT m.tenant_id,
       m.material_id,
       SUM(m.quantidade * coalesce(m.preco_unitario, 0)) / NULLIF(SUM(m.quantidade), 0) AS custo_medio
FROM stock_movimentos m
WHERE m.deleted_at IS NULL
  AND m.tipo = 'entrada'
  AND m.preco_unitario IS NOT NULL
GROUP BY m.tenant_id, m.material_id;

-- --------------------------------------------------------------------------
-- v_obra_orcado_vs_real â€” o numero que o gestor quer ver.
--
-- `real` e sempre o custo em moeda base (valor * taxa_cambio), porque o
-- orcamento da obra esta na moeda dela e as despesas podem ter sido pagas em
-- outra. Sem esta conversao, um custo em USD seria somado a um orcamento em
-- MZN e o saldo seria mentira.
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_obra_orcado_vs_real AS
SELECT o.id AS obra_id,
       o.tenant_id,
       o.codigo,
       o.nome,
       o.moeda,
       o.orcamento_total AS orcado,
       COALESCE(c.total, 0) AS real,
       o.orcamento_total - COALESCE(c.total, 0) AS saldo,
       COALESCE(c.total, 0) - o.orcamento_total AS desvio,
       CASE
         WHEN o.orcamento_total > 0
         THEN ROUND((COALESCE(c.total, 0) / o.orcamento_total) * 100, 2)
         ELSE NULL
       END AS consumo_pct
FROM obras o
LEFT JOIN (
  SELECT obra_id, SUM(valor * taxa_cambio) AS total
  FROM custos
  WHERE deleted_at IS NULL
  GROUP BY obra_id
) c ON c.obra_id = o.id
WHERE o.deleted_at IS NULL;

-- --------------------------------------------------------------------------
-- v_contrato_subempreitada â€” posicao financeira de cada contrato.
--
-- `executado` vem das medicoes (o que a empresa reconhece como entregue) e
-- `pago` dos pagamentos convertidos para a moeda base. E desta diferenca que
-- nasce o saldo a pagar â€” e nunca do valor contratado.
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_contrato_subempreitada AS
SELECT ct.id AS contrato_id,
       ct.tenant_id,
       ct.obra_id,
       ct.codigo,
       ct.subempreiteiro_id,
       ct.estado,
       ct.valor_contratado AS contratado,
       COALESCE(m.medido, 0) AS executado,
       ct.valor_contratado - COALESCE(m.medido, 0) AS saldo_contratado,
       COALESCE(p.pago, 0) AS pago,
       COALESCE(m.medido, 0) - COALESCE(p.pago, 0) AS saldo_pagar,
       CASE
         WHEN ct.valor_contratado > 0
         THEN ROUND((COALESCE(m.medido, 0) / ct.valor_contratado) * 100, 2)
         ELSE NULL
       END AS execucao_pct,
       CASE WHEN COALESCE(m.medido, 0) > ct.valor_contratado THEN true ELSE false END AS estourado
FROM contratos_subempreitada ct
LEFT JOIN (
  SELECT contrato_id, SUM(valor) AS medido
  FROM medicoes
  WHERE deleted_at IS NULL
  GROUP BY contrato_id
) m ON m.contrato_id = ct.id
LEFT JOIN (
  SELECT contrato_id, SUM(valor * taxa_cambio) AS pago
  FROM pagamentos
  WHERE deleted_at IS NULL AND estado <> 'anulado'
  GROUP BY contrato_id
) p ON p.contrato_id = ct.id
WHERE ct.deleted_at IS NULL;

-- --------------------------------------------------------------------------
-- v_requicao_pendente â€” o que falta atender em cada requisicao aprovada.
--
-- O `pendente` e calculado a partir da soma das linhas, e nao de um contador
-- guardado na requisicao: assim nao ha estado que possa divergir do que foi
-- efectivamente servido.
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_requicao_pendente AS
SELECT r.id AS requisicao_id,
       r.tenant_id,
       r.obra_id,
       r.estado,
       r.solicitante_id,
       COUNT(i.id) FILTER (WHERE i.quantidade > i.quantidade_atendida) AS linhas_pendentes,
       COALESCE(SUM(i.quantidade - i.quantidade_atendida) FILTER (WHERE i.quantidade > i.quantidade_atendida), 0) AS quantidade_pendente
FROM requisicoes r
LEFT JOIN requisicao_itens i ON i.requisicao_id = r.id
WHERE r.deleted_at IS NULL
GROUP BY r.id;

-- ==========================================================================
-- 3. TRIGGERS
-- ==========================================================================

-- Funcao do trigger. `NEW.updated_at = now()` em `BEFORE UPDATE` garante que o
-- valor escrito e sempre o do servidor, nunca o do dispositivo â€” um relogio
-- adiantado no telefone nao pode fazer um registo antigo ganhar um conflito.
CREATE OR REPLACE FUNCTION trg_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- `updated_at` e a base da resolucao de conflitos do sync (last-write-wins).
-- Se cada aplicacao se lembrasse de o mexer, bastava uma esquecer para o
-- dispositivo descarregar a alteracao e perder dados sem dar erro. O trigger
-- garante que nunca mais volta a acontecer.
--
-- Construido dinamicamente porque `NEW`/`OLD` nao podem ser usados em SQL
-- parametrizado; `%1$s` e o identificador da tabela.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'obras', 'orcamento_itens', 'custos', 'materiais', 'fornecedores',
    'requisicoes', 'stock_movimentos', 'diario_obra', 'diario_fotos',
    'trabalhadores', 'presencas', 'folhas_salario', 'subempreiteiros',
    'contratos_subempreitada', 'medicoes', 'pagamentos', 'utilizadores'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_touch BEFORE UPDATE ON %1$I
         FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at()',
      t
    );
  END LOOP;
END $$;
