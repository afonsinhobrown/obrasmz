import AsyncStorage from '@react-native-async-storage/async-storage';

const CHAVE = 'obramz.sessao.v1';

export type Sessao = {
  accessToken: string;
  refreshToken: string;
};

export async function getSessao(): Promise<Sessao | null> {
  const raw = await AsyncStorage.getItem(CHAVE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Sessao;
  } catch {
    return null;
  }
}

export async function guardarSessao(s: Sessao): Promise<void> {
  await AsyncStorage.setItem(CHAVE, JSON.stringify(s));
}

export async function apagarSessao(): Promise<void> {
  await AsyncStorage.removeItem(CHAVE);
}

export async function getAccessToken(): Promise<string | null> {
  const s = await getSessao();
  return s?.accessToken ?? null;
}
