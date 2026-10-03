import { defineConfig } from 'vitest/config';

/**
 * Sem configuracao, o vitest usa 10s de hookTimeout. O beforeAll
 * instancia o servidor completo (Swagger, plugins, pool) e, com
 * o crescimento das rotas, passa disso. Damos margem ao arranque.
 */
export default defineConfig({
  test: {
    hookTimeout: 60000,
  },
});
