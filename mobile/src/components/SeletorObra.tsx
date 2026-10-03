import React, { useEffect, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
} from 'react-native';
import { api, comoArray } from '../lib/api';
import type { Obra } from '../lib/types';

type Props = {
  obraId: string | null;
  onSelect: (id: string) => void;
};

/**
 * Seletor de obra (chips horizontais) usado pelos ecrãs
 * de domínio (orçamento, custos, stock, diário, pagamentos).
 * Carrega as obras e escolhe a primeira por omissão.
 */
export default function SeletorObra({ obraId, onSelect }: Props) {
  const [obras, setObras] = useState<Obra[]>([]);

  useEffect(() => {
    let vivo = true;
    api
      .get('/api/v1/obras')
      .then((res) => {
        if (!vivo) return;
        const arr = comoArray<Obra>(res);
        setObras(arr);
        if (arr.length > 0 && !obraId) onSelect(arr[0].id);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
    // Só corre uma vez: o padrão é a primeira obra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (obras.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={estilos.seletor}
      contentContainerStyle={estilos.conteudo}
    >
      {obras.map((o) => {
        const activo = o.id === obraId;
        return (
          <TouchableOpacity
            key={o.id}
            style={[estilos.chip, activo && estilos.chipActivo]}
            onPress={() => onSelect(o.id)}
          >
            <Text
              style={[estilos.chipTexto, activo && estilos.chipTextoActivo]}
              numberOfLines={1}
            >
              {o.nome}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const estilos = StyleSheet.create({
  seletor: { flexGrow: 0, backgroundColor: '#fff' },
  conteudo: { padding: 12, gap: 8 },
  chip: {
    backgroundColor: '#e2e8f0',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    maxWidth: 200,
  },
  chipActivo: { backgroundColor: '#2563eb' },
  chipTexto: { color: '#334155', fontSize: 13, fontWeight: '600' },
  chipTextoActivo: { color: '#fff' },
});
