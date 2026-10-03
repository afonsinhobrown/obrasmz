import { beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

process.env.NODE_ENV = 'test';
// Secret de TESTE (nao e a real). O formato whsec_ e o que importa.
process.env.PAYSUITE_WEBHOOK_SECRET = 'whsec_testsecret1234567890abcdef';

let verificarAssinatura: (
  corpo: string,
  assinatura: string | undefined,
) => boolean;

beforeAll(async () => {
  ({ verificarAssinatura } = await import('../src/services/paysuite.js'));
});

const corpo = JSON.stringify({
  event: 'payment.success',
  data: { id: '01H8X9V8X9Y8Z9A8B8C8D8E8F8', amount: 100.5, reference: 'OMZABC123' },
});

function assinar(segredo: string): string {
  return createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex');
}

describe('webhook PaySuite — assinatura', () => {
  it('aceita assinatura com o segredo completo (whsec_)', () => {
    expect(verificarAssinatura(corpo, assinar('whsec_testsecret1234567890abcdef'))).toBe(true);
  });

  it('aceita assinatura sem o prefixo whsec_ (PaySuite assina ambas)', () => {
    expect(verificarAssinatura(corpo, assinar('testsecret1234567890abcdef'))).toBe(true);
  });

  it('aceita assinatura com prefixo sha256=', () => {
    expect(verificarAssinatura(corpo, `sha256=${assinar('whsec_testsecret1234567890abcdef')}`)).toBe(true);
  });

  it('rejeita assinatura invalida', () => {
    expect(verificarAssinatura(corpo, 'assinaturaerrada')).toBe(false);
  });

  it('rejeita corpo diferente', () => {
    expect(verificarAssinatura('{"event":"other"}', assinar('whsec_testsecret1234567890abcdef'))).toBe(false);
  });

  it('rejeita sem assinatura', () => {
    expect(verificarAssinatura(corpo, undefined)).toBe(false);
  });
});
