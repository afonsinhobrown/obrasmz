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

async function tokenAdmin(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { identificador: 'admin@obramz.demo', senha: 'Admin1234' },
  });
  return res.json().accessToken.accessToken as string;
}

describe('faturacao', () => {
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it('cria fatura com numero sequencial, totais e itens', async () => {
    const token = await tokenAdmin();

    // Preve o numero sem o consumir.
    const prev = await app.inject({
      method: 'GET',
      url: '/api/v1/faturas/proximo-numero',
      headers: auth(token),
    });
    expect(prev.statusCode).toBe(200);
    const esperado = prev.json().numero as string;
    expect(esperado).toMatch(/^FAT-\d{4}-\d{4}$/);

    // subtotal = 10*500 + 5*200 = 6000; base = 6000-100 = 5900;
    // iva = 5900*0.17 = 1003; total = 6903.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/faturas',
      headers: auth(token),
      payload: {
        clienteNome: 'Empresa ABC',
        clienteNuit: '123456789',
        itens: [
          { descricao: 'Concreto', quantidade: 10, precoUnitario: 500 },
          { descricao: 'Mao de obra', quantidade: 5, precoUnitario: 200 },
        ],
        desconto: 100,
        ivaTaxa: 0.17,
      },
    });
    expect(res.statusCode).toBe(201);
    const f = res.json();
    expect(f.numero).toBe(esperado);
    expect(Number(f.subtotal)).toBeCloseTo(6000, 2);
    expect(Number(f.desconto)).toBeCloseTo(100, 2);
    expect(Number(f.ivaValor)).toBeCloseTo(1003, 2);
    expect(Number(f.total)).toBeCloseTo(6903, 2);
    expect(f.itens).toHaveLength(2);
    expect(Number(f.itens[0].valor)).toBeCloseTo(5000, 2);
    expect(Number(f.itens[1].valor)).toBeCloseTo(1000, 2);

    const id = f.id as string;

    const det = await app.inject({
      method: 'GET',
      url: `/api/v1/faturas/${id}`,
      headers: auth(token),
    });
    expect(det.statusCode).toBe(200);
    expect(det.json().itens[0].ordem).toBe(0);

    const anu = await app.inject({
      method: 'POST',
      url: `/api/v1/faturas/${id}/anular`,
      headers: auth(token),
      payload: { motivo: 'erro de lancamento' },
    });
    expect(anu.statusCode).toBe(200);
    expect(anu.json().estado).toBe('anulada');

    // O numero consumido nao se repete, mesmo com a fatura anulada.
    const prev2 = await app.inject({
      method: 'GET',
      url: '/api/v1/faturas/proximo-numero',
      headers: auth(token),
    });
    const n2 = prev2.json().numero as string;
    expect(Number(n2.slice(-4))).toBe(Number(esperado.slice(-4)) + 1);
  });
});
