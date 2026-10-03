import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api } from './api';
import {
  apagarSessao,
  getSessao,
  guardarSessao,
  type Sessao,
} from './authStore';
import type { Perfil } from './types';

/** Resposta exacta de POST /auth/login. */
type LoginResponse = {
  accessToken: { accessToken: string; expiraEm: string; tokenType: string };
  refreshToken: string;
  expiraEm: string;
};

type AuthCtx = {
  /** True enquanto lê a sessão guardada ao arrancar. */
  aIniciar: boolean;
  sessao: Sessao | null;
  perfil: Perfil | null;
  entrar: (identificador: string, senha: string) => Promise<void>;
  sair: () => Promise<void>;
};

const Contexto = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [aIniciar, setAIniciar] = useState(true);
  const [sessao, setSessao] = useState<Sessao | null>(null);
  const [perfil, setPerfil] = useState<Perfil | null>(null);

  // Arrancar: recupera a sessão guardada (persistência offline).
  useEffect(() => {
    (async () => {
      const s = await getSessao();
      setSessao(s);
      setAIniciar(false);
    })();
  }, []);

  // Com sessão, carrega o perfil (nome, papel, tenant).
  useEffect(() => {
    if (!sessao) {
      setPerfil(null);
      return;
    }
    let vivo = true;
    api
      .get<Perfil>('/api/v1/auth/eu')
      .then((p) => {
        if (vivo) setPerfil(p);
      })
      .catch(() => {
        if (vivo) setPerfil(null);
      });
    return () => {
      vivo = false;
    };
  }, [sessao]);

  const entrar = useCallback(async (identificador: string, senha: string) => {
    const res = await api.post<LoginResponse>('/api/v1/auth/login', {
      identificador,
      senha,
    });
    const s: Sessao = {
      accessToken: res.accessToken.accessToken,
      refreshToken: res.refreshToken,
    };
    await guardarSessao(s);
    setSessao(s);
  }, []);

  const sair = useCallback(async () => {
    const s = await getSessao();
    if (s?.refreshToken) {
      try {
        await api.post('/api/v1/auth/logout', { refreshToken: s.refreshToken });
      } catch {
        // Mesmo que a revogação falhe, terminamos a sessão local.
      }
    }
    await apagarSessao();
    setSessao(null);
    setPerfil(null);
  }, []);

  const valor = useMemo(
    () => ({ aIniciar, sessao, perfil, entrar, sair }),
    [aIniciar, sessao, perfil, entrar, sair],
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Contexto);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>');
  return ctx;
}
