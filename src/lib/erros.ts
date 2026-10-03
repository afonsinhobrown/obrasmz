/** Erros de dominio. Cada um mapeia para um codigo HTTP deterministico, para
 * que o cliente offline saiba reagir (ex.: 409 = conflito, ja tentei outra vez).
 */
import type { Ctx } from '../db/tx.js';
export class ErroApp extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensagem: string,
    readonly detalhes?: unknown,
  ) {
    super(mensagem);
    this.name = new.target.name;
  }
}

export class ErroValidacao extends ErroApp {
  constructor(mensagem: string, detalhes?: unknown) {
    super(400, 'VALIDACAO', mensagem, detalhes);
  }
}

export class ErroNaoAutenticado extends ErroApp {
  constructor(mensagem = 'Credenciais invalidas ou token expirado') {
    super(401, 'NAO_AUTENTICADO', mensagem);
  }
}

export class ErroSemPermissao extends ErroApp {
  constructor(permissao: string) {
    super(403, 'SEM_PERMISSAO', `Sem permissao para: ${permissao}`);
  }
}

export class ErroNaoEncontrado extends ErroApp {
  constructor(entidade: string, id?: string) {
    super(404, 'NAO_ENCONTRADO', id ? `${entidade} ${id} nao existe` : `${entidade} nao existe`);
  }
}

export class ErroConflito extends ErroApp {
  constructor(mensagem: string, detalhes?: unknown) {
    super(409, 'CONFLITO', mensagem, detalhes);
  }
}

/** Regra de negocio violada: o pedido faz sentido mas o estado nao permite. */
export class ErroRegraNegocio extends ErroApp {
  constructor(mensagem: string, detalhes?: unknown) {
    super(422, 'REGRA_NEGOCIO', mensagem, detalhes);
  }
}

export class ErroLimitePlano extends ErroApp {
  constructor(recurso: string, limite: number, plano: string) {
    super(
      402,
      'LIMITE_PLANO',
      `O plano ${plano} permite no maximo ${limite} ${recurso}.`,
    );
  }
}

export class ErroSync extends ErroApp {
  constructor(mensagem: string, detalhes?: unknown) {
    super(400, 'SYNC_INVALIDO', mensagem, detalhes);
  }
}

/** Falha no gateway de pagamentos (PaySuite): upstream, nao e culpa do pedido. */
export class ErroGateway extends ErroApp {
  constructor(mensagem: string, detalhes?: unknown) {
    super(502, 'GATEWAY', mensagem, detalhes);
  }
}

export type { Ctx };