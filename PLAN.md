# ObraMZ — Plano de Implementação

SaaS multi-tenant de gestão de obras para Moçambique. Offline-first, PostgreSQL, API REST.

**Estado:** Backend (Fases 0–2) implementado: schema Drizzle + migrations, serviços de domínio, sync offline, servidor Fastify, rotas, seed e testes de integração (`npm test` 4 green). Integração PaySuite (pagar/receber via M-Pesa/e-Mola/cartão) implementada e desligada por defeito.

**Produção:** deploy ativo na Render (Docker) em `https://obramz-api.onrender.com`, ligado a Neon Postgres. Migrations correm no arranque (`src/index.ts`). Seed de demo já aplicado na Neon. Migration `0002` (tabela `transacoes_externas`) aplicada à Neon.

- Comando de deploy: `render services create --name obramz-api --type web_service --repo https://github.com/afonsinhobrown/obrasmz --runtime docker --branch main --plan free --health-check-path /health --env-var ...`
- Env vars de produção: `NODE_ENV`, `PORT=3333`, `HOST=0.0.0.0`, `DATABASE_URL` (Neon), `JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `BCRYPT_ROUNDS`, `MOEDA_BASE`, `BUDGET_STRICT`, `STOCK_PERMITE_NEGATIVO`, `HORAS_POR_DIA`, `UPLOAD_DIR=/tmp/uploads`, `UPLOAD_MAX_BYTES`, `UPLOAD_BASE_URL`, `SYNC_PAGE_MAX`, `PAYSUITE_API_TOKEN`, `PAYSUITE_WEBHOOK_SECRET`, `PAYSUITE_BASE_URL`
- Blueprint de referência: `render.yaml` (sem segredos; `DATABASE_URL` e `JWT_SECRET` são placeholders/gerados)
- Credenciais de demo: `admin@obramz.demo`/`Admin1234` (papel admin), `gestor@obramz.demo`/`Gestor1234` (papel gestor)

## PaySuite (pagamentos) — implementado, off por defeito

Gateway moçambicano (`paysuite.tech`): M-Pesa, e-Mola, Mkesh, cartões, bancos. **Sem sandbox** — com o token definido, todas as transações são reais. A integração só ativa com `PAYSUITE_API_TOKEN`; sem ela, nenhuma transação é tentada. Alinhada com a integração real do projecto shoplink.

- Base: `https://paysuite.tech/api/v1`, auth `Authorization: Bearer <PAYSUITE_API_TOKEN>`
- Tabela `transacoes_externas`: regista cada pedido/payout/reembolso (`external_id` = ULID do PaySuite, `pagamento_id` = pagamento interno, `referencia` única por tenant, `eventos` = webhooks já processados)
- Rotas (auth + `pagamentos:registar`): `POST /api/v1/paysuite/pagamentos` (cria payment request → devolve `checkout_url`), `POST /api/v1/paysuite/payouts` (paga via M-Pesa/e-Mola/banco), `GET /api/v1/paysuite` (lista), `GET/POST /api/v1/paysuite/:id[/consultar]` (estado)
- Webhook público `POST /webhooks/paysuite`: verifica `X-Signature` (HMAC-SHA256 do corpo bruto; o segredo vem com prefixo `whsec_` e a PaySuite assina **com e sem** esse prefixo — validamos ambos; aceita prefixo `sha256=`), idempotente (evento guardado em `eventos`), verifica o valor (anti-fraude), procura a transação por `referencia` (eco do gateway) e marca o pagamento interno ligado como `confirmado` no sucesso
- Referências nossas: `OMZ<timestamp36><4 aleatórios>` — **alfanumérico puro** (a PaySuite recusa `-` e `_`); ≤30 caracteres (limite de payout); a unicidade no gateway é a rede de segurança contra duplicados
- Para cobrança directa a M-Pesa/e-Mola é preciso `contact_id` (criar contacto com telefone E.164 +258 antes); omitir `method` mostra o checkout hospedado onde o cliente escolhe
- Métodos em `/payments`: só `mpesa`, `emola`, `credit_card` (`mkesh` é só payouts)
- Rate limit do gateway: 100 req/min; timeout 15s; webhooks reenviados até 5 vezes (daí a idempotência)

App móvel (React Native + Expo) e faturação fiscal (faturas + AT e-fatura) ficam para os próximos passos.

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