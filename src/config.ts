import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Le o `.env` sem dependencia externa. Em producao as variaveis vem do
 * ambiente; em desenvolvimento o ficheiro local e convenient.
 */
function carregarDotEnv(): void {
  const caminho = resolve(process.cwd(), '.env');
  if (!existsSync(caminho)) return;
  for (const linha of readFileSync(caminho, 'utf8').split(/\r?\n/)) {
    const trimmed = linha.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const chave = trimmed.slice(0, eq).trim();
    const valor = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    // Nao sobrepoe o que ja vier do ambiente (Docker/CI tem prioridade).
    if (process.env[chave] === undefined) process.env[chave] = valor;
  }
}
carregarDotEnv();

const booleano = z
  .string()
  .transform((v) => ['1', 'true', 'yes', 'sim'].includes(v.toLowerCase()));

const esquema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL e obrigatorio'),
  PGPOOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET deve ter pelo menos 16 caracteres'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  MOEDA_BASE: z.string().length(3).default('MZN'),
  BUDGET_STRICT: booleano.default('false'),
  STOCK_PERMITE_NEGATIVO: booleano.default('false'),
  HORAS_POR_DIA: z.coerce.number().positive().default(8),

  UPLOAD_DIR: z.string().default('uploads'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  UPLOAD_BASE_URL: z.string().default('/uploads'),

  SYNC_PAGE_MAX: z.coerce.number().int().positive().default(500),

  // PaySuite (gateway de pagamentos de Moçambique). A integração fica
  // desligada enquanto nao houver API key: nenhuma transaccao real e
  // tentada. Sem sandbox — com a key definida, as transaccoes sao reais.
  PAYSUITE_API_KEY: z.string().min(1).optional(),
  PAYSUITE_WEBHOOK_SECRET: z.string().min(1).optional(),
  PAYSUITE_BASE_URL: z.string().url().default('https://paysuite.tech/api/v1'),
});

const bruto = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => typeof v === 'string'),
);

const parsed = esquema.safeParse(bruto);
if (!parsed.success) {
  const detalhe = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Configuracao invalida:\n${detalhe}`);
}

const env = parsed.data;

// Em producao o segredo padrao e um risco demasiado grave para passar.
if (env.NODE_ENV === 'production') {
  if (env.JWT_SECRET.includes('trocar-este-segredo')) {
    throw new Error('Defina JWT_SECRET com um valor proprio antes de arrancar em producao.');
  }
}

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  host: env.HOST,

  db: {
    url: env.DATABASE_URL,
    poolMax: env.PGPOOL_MAX,
  },

  auth: {
    secret: env.JWT_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    bcryptRounds: env.NODE_ENV === 'test' ? 4 : env.BCRYPT_ROUNDS,
  },

  dominio: {
    moedaBase: env.MOEDA_BASE.toUpperCase(),
    budgetStrict: env.BUDGET_STRICT,
    stockPermiteNegativo: env.STOCK_PERMITE_NEGATIVO,
    horasPorDia: env.HORAS_POR_DIA,
  },

  uploads: {
    dir: resolve(process.cwd(), env.UPLOAD_DIR),
    maxBytes: env.UPLOAD_MAX_BYTES,
    baseUrl: env.UPLOAD_BASE_URL,
  },

  sync: {
    pageMax: env.SYNC_PAGE_MAX,
  },

  paysuite: {
    apiKey: env.PAYSUITE_API_KEY ?? null,
    webhookSecret: env.PAYSUITE_WEBHOOK_SECRET ?? null,
    baseUrl: env.PAYSUITE_BASE_URL.replace(/\/$/, ''),
    // A integração so fica activa quando ha credenciais completas.
    activo: Boolean(env.PAYSUITE_API_KEY),
  },
} as const;

export type Config = typeof config;