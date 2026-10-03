import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

let app: Awaited<ReturnType<typeof import('../src/server.js').criarServidor>>;

beforeAll(async () => {
  const { criarServidor } = await import('../src/server.js');
  app = await criarServidor();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('bootstrap http', () => {
  it('GET /health devolve ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const corpo = res.json();
    expect(corpo.status).toBe('ok');
    expect(corpo.servico).toBe('obramz-api');
  });

  it('rota desconhecida devolve 404 normalizado', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/inexistente' });
    expect(res.statusCode).toBe(404);
    expect(res.json().codigo).toBe('ROTA_INEXISTENTE');
  });
});

describe('autenticacao', () => {
  it('login de admin devolve tokens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identificador: 'admin@obramz.demo', senha: 'Admin1234' },
    });
    expect(res.statusCode).toBe(200);
    const corpo = res.json();
    expect(corpo.accessToken.accessToken).toBeTruthy();
    expect(corpo.refreshToken).toBeTruthy();
  });

  it('senha errada devolve 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identificador: 'admin@obramz.demo', senha: 'errada123' },
    });
    expect(res.statusCode).toBe(401);
  });
});
