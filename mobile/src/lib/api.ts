import { API_URL } from './config';
import { getAccessToken } from './authStore';

export class ApiError extends Error {
  constructor(
    message: string,
    public codigo?: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Wrapper de fetch: junta o token de acesso, serializa JSON e
 * normaliza os erros da API ({ erro, codigo, mensagem }).
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError('Sem ligação à rede. Verifique a Internet.');
  }

  const texto = await res.text();
  let corpo: any = null;
  if (texto) {
    try {
      corpo = JSON.parse(texto);
    } catch {
      corpo = texto;
    }
  }

  if (!res.ok) {
    const mensagem =
      corpo && typeof corpo === 'object' && corpo.mensagem
        ? corpo.mensagem
        : `Erro ${res.status}`;
    throw new ApiError(
      mensagem,
      corpo && typeof corpo === 'object' ? corpo.codigo : undefined,
      res.status,
    );
  }

  return corpo as T;
}

export const api = {
  get<T>(path: string) {
    return request<T>(path);
  },
  post<T>(path: string, body?: unknown) {
    return request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  },
  patch<T>(path: string, body?: unknown) {
    return request<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  },
  del<T>(path: string) {
    return request<T>(path, { method: 'DELETE' });
  },
};

/**
 * Algumas listas da API devolvem array; outras devolvem
 * { dados: [...], meta: {...} }. Centraliza as duas formas.
 */
export function comoArray<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === 'object' && Array.isArray((res as any).dados)) {
    return (res as any).dados as T[];
  }
  return [];
}
