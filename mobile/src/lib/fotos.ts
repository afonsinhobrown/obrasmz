import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { api } from './api';

/**
 * Câmara e geolocalização para o diário de obra.
 *
 * A foto vai em base64 (o endpoint /ficheiros guarda-a
 * no servidor e devolve a url); a localização e' "melhor
 * esforco": sem permissao ou sem GPS, a foto segue sem
 * coordenadas em vez de nao seguir de todo.
 */

export type FotoTirada = {
  base64: string;
  tipo: string;
  latitude: number | null;
  longitude: number | null;
};

/** Tira uma foto (câmara; selector de ficheiros na web). */
export async function tirarFoto(): Promise<FotoTirada | null> {
  // Na web a câmara nao está disponível: abre-se o
  // selector de ficheiros do browser.
  const usarCamera = Platform.OS !== 'web';

  let resultado: ImagePicker.ImagePickerResult;
  if (usarCamera) {
    const permissao = await ImagePicker.requestCameraPermissionsAsync();
    if (!permissao.granted) return null;
    resultado = await ImagePicker.launchCameraAsync({
      base64: true,
      quality: 0.5,
    });
  } else {
    resultado = await ImagePicker.launchImageLibraryAsync({
      base64: true,
      quality: 0.5,
    });
  }

  if (resultado.canceled || !resultado.assets?.[0]) return null;
  const asset = resultado.assets[0];
  if (!asset.base64) return null;

  const tipo = asset.mimeType ?? 'image/jpeg';

  let latitude: number | null = null;
  let longitude: number | null = null;
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      latitude = pos.coords.latitude;
      longitude = pos.coords.longitude;
    }
  } catch {
    // Sem GPS: segue sem coordenadas.
  }

  return { base64: asset.base64, tipo, latitude, longitude };
}

/** Enia a foto ao servidor e devolve a url guardada. */
export async function enviarFoto(foto: FotoTirada): Promise<string> {
  const res = await api.post<{ url: string }>('/api/v1/ficheiros', {
    tipo: foto.tipo,
    dados: foto.base64,
    prefixo: 'diario',
  });
  return res.url;
}

/** Anexa uma foto (já enviada) a uma entrada do diário. */
export async function anexarFoto(
  entradaId: string,
  url: string,
  latitude: number | null,
  longitude: number | null,
): Promise<void> {
  await api.post(`/api/v1/diario/${entradaId}/fotos`, {
    url,
    legenda: null,
    latitude,
    longitude,
    tiradaEm: new Date().toISOString(),
  });
}
