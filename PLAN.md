# ObraMZ — Plano de Implementação

SaaS multi-tenant de gestão de obras para Moçambique. Offline-first, PostgreSQL, API REST.

**Estado:** Backend (Fases 0–2) implementado: schema Drizzle + migrations, serviços de domínio, sync offline, servidor Fastify, rotas, seed e testes de integração (`npm test` 4 green). Produção pronta: `docker compose build api` + `up -d api`. App móvel e faturação fiscal ficam para fases seguintes.

---

## Convenções transversais

| Tema | Decisão |
|---|---|
| Multi-tenant | `tenant_id` vem **sempre** do JWT, nunca do body. Filtro obrigatório em todo o acesso a dados. |
| Moeda | `NUMERIC` lido como string (sem perda de precisão). `moeda_base` do tenant é MZN por omissão. |
| Câmbio | `taxa_cambio` = **unidades da moeda base por 1 unidade da moeda do custo**. Ex.: 100 USD × 63,5 = 6 350 MZN. |
| Offline-first | Toda tabela operacional tem `client_id`, `updated_at`, `deleted_at`. Índice único por `(tenant_id, client_id)` garante idempotência. |
| Sync | Last-write-wins (conforme comentário do schema). Conflitos são **aplicados** mas **reportados** ao cliente para aviso na UI. |
| Soft delete | `deleted_at` em vez de `DELETE`. Propaga o apagamento no sync. |
| Valores monetários | Nunca `float` em JS para persistir. Aritmética fica no SQL (`SUM`, `FILTER`) ou via `NUMERIC`. |
| Auditoria | Ações destrutivas/financeiras escrevem em `log_auditoria` com antes/depois. |

---

## Fase 0 — Fundação  ✅

- Repositório, TypeScript strict, Fastify 5, Drizzle ORM
- `docker-compose.yml` (Postgres 16) + `.env.example`
- Migrations versionadas (`drizzle-kit generate`)
- `log_auditoria`, `sessoes`, `dispositivos`, `taxas_cambio`, `medicoes`, `folhas_salario`, `numeros_documento`, `custo_medio`
- Health check `/saude`, Swagger em `/docs`, CORS, helmet, rate-limit
- Seed de demonstração (`npm run seed`)

## Fase 1 — Identidade e multi-tenant  ✅

- Onboarding: `POST /auth/registar-empresa` cria tenant + utilizador admin
- Login com JWT de acesso (15 min) + refresh token rotativo e com hash em `sessoes`
- `GET /auth/eu`, `POST /auth/refresh`, `POST /auth/logout`
- RBAC por papel: `admin`, `gestor`, `fiscal`, `encarregado`, `armazem`, `financeiro`
- Gestão de utilizadores e reset de senha

## Fase 2 — Domínio de obra  ✅

**Obras e orçamento**
- Máquina de estados: `planeada → em_curso → suspensa → em_curso → concluida`
- `codigo` gerado por tenant (`OBR-2026-0001`) via `numeros_documento`
- Recalculo de `progresso_pct` ponderado por `total_orcado` dos itens
- Bloqueio de excedente de orçamento (`BUDGET_STRICT`)
- Import de orçamento por CSV

**Custos**
- Lançamento com resolução automática de câmbio a partir de `taxas_cambio`
- `origem_tabela`/`origem_id` prefillados — custo nasce do stock, da folha ou da medição

**Materiais e stock**
- Livro-razão de movimentos; saldo por `v_stock_actual`
- `entrada` com preço cria custo `material`; `saída` nunca gera custo (já foi na entrada)
- `transferencia` = saída + entrada na mesma transação
- Alerta de `stock_minimo`
- Fluxo de requisição: `pendente → aprovada/rejeitada → atendida` (atendimento gera movimentos)

**Diário de obra**
- Entrada diária com clima/trabalhos/ocorrências; progresso monótono
- Upload de fotos com GPS (multipart, storage local plugável)

**Equipas**
- Presenças por (obra, trabalhador, data) com upsert
- Folhas de salário por período → lançam custos `mao_de_obra` de forma **idempotente**

**Subempreitada**
- Contratos + medições; custo nasce da medição
- Saldo contratado − mediado − pago

**Pagamentos**
- Numérico, M-Pesa, Emola, transferência, cheque; comprovativo com upload
- Bloqueio de sobrepagamento a subempreiteiro acima do contratado
- Ciclo `registado → confirmado → anulado`

**Relatórios**
- Orçado vs real (por obra, por tipo de custo)
- Curva S (orçado vs executado acumulado por mês)
- Fluxo de caixa por método e por mês
- Stock valorizado, folha de ponto
- Dashboard do tenant
- Export CSV/JSON

**Sync offline-first**
- `GET /sync/pull` — incremental por cursor `(updated_at, id)`, inclui *tombstones*
- `POST /sync/push` — lote de operações, idempotente por `client_id`, deteção de conflito
- `dispositivos` guarda o último cursor por aparelho

## Fase 3 — App móvel (PWA/React Native)  ⬜

- Base local SQLite espelhando `src/db/schema.ts`
- Fila de escrita + sync em background
- Ecrãs: obras, orçamento, stock, diário+fotos, ponto, pagamentos
- Câmara + geolocalização para o diário

## Fase 4 — Financeiro e fiscal ( Moçambique)  ⬜

- Faturas, notas de crédito, numeração sequencial certificada
- Retenções, IVA, INSS, IRT
- Relatórios para a AT e recibos em PDF

## Fase 5 — Comercial e plataforma  ⬜

- Planos com limites (`tenants.plano` já existe, falta regra)
- Integração M-Pesa/Emola real (push-to-pay)
- Portal web do cliente
- Termos, privacidade, política de retenção de dados

---

## Como correr

```bash
cp .env.example .env
docker compose up -d
npm install
npm run migrate
npm run seed
npm run dev
```

- API: `http://localhost:3333`
- Swagger: `http://localhost:3333/docs`
- Utilizador demo: `admin@obramz.co.mz` / `ObraMZ#2026`

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor em watch |
| `npm run build` | Compila para `dist/` |
| `npm run migrate` | Aplica migrations |
| `npm run migrate:make` | Gera migration a partir de `src/db/schema.ts` |
| `npm run seed` |Dados de demonstração |
| `npm test` | Testes de integração |
| `npm run typecheck` | `tsc --noEmit` |