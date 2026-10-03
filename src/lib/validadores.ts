import { z } from 'zod';

/** Normaliza email: minusculas e sem espacos. Gravamos sempre assim, porque
 *  o indice unico e (tenant_id, email) e "Ana@x.com" nao pode duplicar
 *  "ana@x.com" dentro do mesmo tenant. */
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Telefone moçambicano em formato normalizado: 2588xxxxxxx / +2588xxxxxxx */
export function normalizarTelefone(tel: string): string {
  const limpo = tel.replace(/[^\d+]/g, '');
  if (/^\+258\d{9}$/.test(limpo)) return limpo;
  if (/^258\d{9}$/.test(limpo)) return `+${limpo}`;
  if (/^8\d{8}$/.test(limpo)) return `+258${limpo}`;
  return limpo;
}

/** Espacos colapsados — para nomes de materiais e/users, onde "Cimento  CP"
 *  e "cimento cp" devem ser o mesmo material. */
export function normalizarNome(nome: string): string {
  return nome.trim().replace(/\s+/g, ' ');
}

export const uuidSchema = z.string().uuid('Identificador invalido');

/** Query string de paginacao com teto, para nunca Returning pagina gigante. */
export const paginaSchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  porPagina: z.coerce.number().int().min(1).max(200).default(50),
});

export type Pagina = z.infer<typeof paginaSchema>;

export function offsetDe(p: Pagina): number {
  return (p.pagina - 1) * p.porPagina;
}

export function metaPagina(p: Pagina, total: number) {
  return {
    pagina: p.pagina,
    porPagina: p.porPagina,
    total,
    totalPaginas: Math.ceil(total / p.porPagina),
  };
}