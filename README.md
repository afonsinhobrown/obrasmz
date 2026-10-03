# ObraMZ

Backend SaaS de gestão de obras para Moçambique — multi-tenant, offline-first, com dinheiro tratado como `NUMERIC` e sync last-write-wins por `client_id`.

Stack: Node.js, TypeScript, Fastify 5, Drizzle ORM, PostgreSQL 16.

## Arranque rápido

```bash
docker compose up -d postgres
cp .env.example .env
npm install
npm run migrate
npm run seed
npm run dev
```

API em `http://localhost:3333`, Swagger em `http://localhost:3333/docs`.

Contas do seed: `admin@obramz.demo` / `Admin1234`, `gestor@obramz.demo` / `Gestor1234`.

## Scripts

| comando | descrição |
| --- | --- |
| `npm run dev` | servidor em hot-reload |
| `npm run build` / `npm start` | build + produção |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | aplica `drizzle/` (0000 init + 0001 views/constraints) |
| `npm run migrate:make` | gera nova migration após editar `src/db/schema.ts` |
| `npm run seed` | dados de demonstração (idempotente) |
| `npm test` | testes de integração (vitest, precisa de postgres a correr) |

## Arquitetura

- `src/config.ts` — validação de env com zod (falha depressa).
- `src/plugins/` — BD, erros normalizados e JWT/RBAC (papel recarregado da BD em cada pedido).
- `src/services/` — lógica de negócio real: obras, orçamento/CSV, custos+câmbio, stock, requisições, diário, equipa/ponto/folhas, subempreitada, pagamentos, relatórios e sync.
- `src/routes/` — HTTP fino sobre os serviços, com permissões por papel em `src/lib/rbac.ts`.
- `drizzle/` — `0000_init` (schema gerado) + `0001_views` (constraints, views `v_*`, trigger de `updated_at`).

## Sync offline

`POST /api/v1/sync/push` aplica alterações em lote (`clientId` idempotente + last-write-wins por `updated_at`); `GET /api/v1/sync/pull?desde=&limite=` devolve o delta por cursor. Erros por alteração vêm em `recusados` sem derrubar o lote.
