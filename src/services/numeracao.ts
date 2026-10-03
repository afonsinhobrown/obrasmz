import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../db/tx.js';
import { numerosDocumento } from '../db/schema.js';

export type TipoDocumento = 'OBR' | 'REQ' | 'CTR' | 'FOL' | 'FAT' | 'DOC';

/**
 * Numeracao sequencial por tenant, tipo e ano: OBR-2026-0001.
 *
 * O numero e obtido com `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, o
 * que torna a operacao atomica: duas obras criadas ao mesmo tempo recebem
 * numeros diferentes, sem necessitar de SERIALIZABLE nem de locks manuais.
 * Chamar dentro da transacao que cria o registo garante que, se a criacao
 * falhar a seguir, o numero consumido tambem e revertido.
 */
export async function proximoNumero(
  db: Ctx,
  tenantId: string,
  tipo: TipoDocumento,
  data: Date = new Date(),
): Promise<string> {
  const ano = data.getFullYear();

  const linhas = await db
    .insert(numerosDocumento)
    .values({ tenantId, tipo, ano, numero: 1 })
    .onConflictDoUpdate({
      target: [numerosDocumento.tenantId, numerosDocumento.tipo, numerosDocumento.ano],
      set: { numero: sql`${numerosDocumento.numero} + 1`, updatedAt: new Date() },
    })
    .returning({ numero: numerosDocumento.numero });

  const numero = linhas[0]?.numero ?? 1;
  return `${tipo}-${ano}-${String(numero).padStart(4, '0')}`;
}

/** Numero seguinte sem consumir — usado para prever um codigo no formulario. */
export async function preverNumero(
  db: Ctx,
  tenantId: string,
  tipo: TipoDocumento,
  data: Date = new Date(),
): Promise<string> {
  const ano = data.getFullYear();
  const [atual] = await db
    .select({ numero: numerosDocumento.numero })
    .from(numerosDocumento)
    .where(
      and(
        eq(numerosDocumento.tenantId, tenantId),
        eq(numerosDocumento.tipo, tipo),
        eq(numerosDocumento.ano, ano),
      ),
    )
    .limit(1);

  return `${tipo}-${ano}-${String((atual?.numero ?? 0) + 1).padStart(4, '0')}`;
}