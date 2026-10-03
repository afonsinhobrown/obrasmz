import type { Ctx } from '../db/tx.js';
import { logAuditoria } from '../db/schema.js';

export type EntradaAuditoria = {
  accao: string;
  entidade: string;
  entidadeId?: string | null;
  dadosAntes?: unknown;
  dadosDepois?: unknown;
  ip?: string | null;
};

/**
 * Regista uma accao na trilha de auditoria.
 *
 * Recebe o `tx` em vez de abrir a sua propria transacao de proposito: a
 * auditoria tem de ficar na MESMA transacao da accao que audita. Se a accao
 * falhar e for revertida, aauditoria desaparece tambem — nunca ficamos com
 * "apagou-se a obra" registado para uma obra que nao foi apagada.
 */
export async function auditar(
  db: Ctx,
  tenantId: string,
  utilizadorId: string | null,
  entrada: EntradaAuditoria,
): Promise<void> {
  await db.insert(logAuditoria).values({
    tenantId,
    utilizadorId,
    accao: entrada.accao,
    entidade: entrada.entidade,
    entidadeId: entrada.entidadeId ?? null,
    dadosAntes: (entrada.dadosAntes ?? null) as never,
    dadosDepois: (entrada.dadosDepois ?? null) as never,
    ip: entrada.ip ?? null,
  });
}

/** Diferenca entre duas versoes de um registo, para guardar so o que mudou. */
export function diff(antes: unknown, depois: unknown): { antes: unknown; depois: unknown } {
  return { antes, depois };
}