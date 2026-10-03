/**
 * Seed de desenvolvimento: uma empresa de demonstração, dois utilizadores,
 * uma obra e o respectivo orçamento. Idempotente: pode correr várias vezes.
 */
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { criarDb } from './client.js';
import { materiais, obras, orcamentoItens, tenants, utilizadores } from './schema.js';

async function garantirUtilizador(
  db: ReturnType<typeof criarDb>,
  tenantId: string,
  dados: { nome: string; email: string; senha: string; papel: 'admin' | 'gestor' },
): Promise<string> {
  const existente = await db
    .select({ id: utilizadores.id })
    .from(utilizadores)
    .where(eq(utilizadores.email, dados.email))
    .limit(1);
  if (existente[0]) return existente[0].id;

  const [u] = await db
    .insert(utilizadores)
    .values({
      tenantId,
      nome: dados.nome,
      email: dados.email,
      senhaHash: bcrypt.hashSync(dados.senha, config.auth.bcryptRounds),
      papel: dados.papel,
    })
    .returning({ id: utilizadores.id });
  return u!.id;
}

async function main() {
  const db = criarDb();
  try {
    const [tenantExistente] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.nome, 'ObraMZ Demo'))
      .limit(1);

    let tenantId = tenantExistente?.id;
    if (!tenantId) {
      const [t] = await db
        .insert(tenants)
        .values({ nome: 'ObraMZ Demo', moedaBase: 'MZN', plano: 'pro', maxObras: 50, maxUtilizadores: 20 })
        .returning({ id: tenants.id });
      tenantId = t!.id;
      console.log('[seed] tenant criado');
    } else {
      console.log('[seed] tenant ja existe');
    }

    await garantirUtilizador(db, tenantId, {
      nome: 'Administrador',
      email: 'admin@obramz.demo',
      senha: 'Admin1234',
      papel: 'admin',
    });

    await garantirUtilizador(db, tenantId, {
      nome: 'Gestor de Obra',
      email: 'gestor@obramz.demo',
      senha: 'Gestor1234',
      papel: 'gestor',
    });

    const [obraExistente] = await db
      .select()
      .from(obras)
      .where(eq(obras.codigo, 'OBR-2026-0001'))
      .limit(1);

    let obraId = obraExistente?.id;
    if (!obraId) {
      const [o] = await db
        .insert(obras)
        .values({
          tenantId,
          codigo: 'OBR-2026-0001',
          nome: 'Reabilitação da Escola Secundária de Matola',
          cliente: 'Ministério da Educação',
          localizacao: 'Matola, Maputo',
          moeda: 'MZN',
          estado: 'em_curso',
          orcamentoTotal: '12500000',
          dataInicio: '2026-01-15',
        })
        .returning({ id: obras.id });
      obraId = o!.id;
      console.log('[seed] obra criada');
    } else {
      console.log('[seed] obra ja existe');
    }

    const itens = [
      { capitulo: 'Movimento de terras', descricao: 'Escavação manual de valas', unidade: 'm3', quantidade: '120', precoUnitario: '450' },
      { capitulo: 'Betão', descricao: 'Betão armado C25/30', unidade: 'm3', quantidade: '86', precoUnitario: '6800' },
      { capitulo: 'Alvenaria', descricao: 'Bloco de cimento 20cm', unidade: 'm2', quantidade: '1450', precoUnitario: '520' },
    ];

    for (const item of itens) {
      const existe = await db
        .select({ id: orcamentoItens.id })
        .from(orcamentoItens)
        .where(eq(orcamentoItens.descricao, item.descricao))
        .limit(1);
      if (existe.length) continue;
      await db.insert(orcamentoItens).values({ tenantId, obraId, ...item });
    }

    const mats = [
      { nome: 'Cimento Portland 50kg', unidade: 'saco', categoria: 'ligantes', stockMinimo: '200', precoRef: '450' },
      { nome: 'Areia grossa', unidade: 'm3', categoria: 'agregados', stockMinimo: '40', precoRef: '950' },
    ];
    for (const m of mats) {
      const existe = await db
        .select({ id: materiais.id })
        .from(materiais)
        .where(eq(materiais.nome, m.nome))
        .limit(1);
      if (existe.length) continue;
      await db.insert(materiais).values({ tenantId, ...m });
    }

    console.log('[seed] concluido');
  } finally {
    await db.pool.end();
  }
}

main().catch((err) => {
  console.error('[seed] erro:', err);
  process.exit(1);
});
