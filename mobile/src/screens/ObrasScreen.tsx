import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { listarObras } from '../lib/dados';
import type { Obra } from '../lib/types';

const ESTADO_COR: Record<string, string> = {
  planeada: '#64748b',
  em_curso: '#2563eb',
  suspensa: '#d97706',
  concluida: '#16a34a',
};

const ESTADO_TEXTO: Record<string, string> = {
  planeada: 'Planeada',
  em_curso: 'Em curso',
  suspensa: 'Suspensa',
  concluida: 'Concluída',
};

export default function ObrasScreen() {
  const [obras, setObras] = useState<Obra[]>([]);
  const [aCarregar, setACarregar] = useState(true);
  const [aActualizar, setAActualizar] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      setErro(null);
      const obras = await listarObras();
      setObras(obras);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar obras.');
    } finally {
      setACarregar(false);
      setAActualizar(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Recarrega sempre que o separador ganha foco.
  useFocusEffect(
    useCallback(() => {
      carregar();
    }, [carregar]),
  );

  if (aCarregar) {
    return (
      <View style={estilos.centro}>
        <Text>A carregar obras…</Text>
      </View>
    );
  }

  return (
    <View style={estilos.fundo}>
      {erro ? <Text style={estilos.erro}>{erro}</Text> : null}
      <FlatList
        data={obras}
        keyExtractor={(o) => o.id}
        contentContainerStyle={estilos.lista}
        refreshControl={
          <RefreshControl
            refreshing={aActualizar}
            onRefresh={() => {
              setAActualizar(true);
              carregar();
            }}
            tintColor="#2563eb"
          />
        }
        ListEmptyComponent={<Text style={estilos.vazio}>Sem obras.</Text>}
        renderItem={({ item }) => {
          const progresso = Math.min(100, Number(item.progressoPct ?? 0));
          return (
            <View style={estilos.cartao}>
              <View style={estilos.linhaTopo}>
                <Text style={estilos.codigo}>{item.codigo ?? '—'}</Text>
                <View
                  style={[
                    estilos.badge,
                    {
                      backgroundColor:
                        ESTADO_COR[item.estado] ?? ESTADO_COR.planeada,
                    },
                  ]}
                >
                  <Text style={estilos.badgeTexto}>
                    {ESTADO_TEXTO[item.estado] ?? item.estado}
                  </Text>
                </View>
              </View>
              <Text style={estilos.nome}>{item.nome}</Text>
              {item.cliente ? (
                <Text style={estilos.cliente}>{item.cliente}</Text>
              ) : null}
              {item.localizacao ? (
                <Text style={estilos.local}>{item.localizacao}</Text>
              ) : null}
              <View style={estilos.progressTrack}>
                <View
                  style={[
                    estilos.progressFill,
                    { width: `${progresso}%` },
                  ]}
                />
              </View>
              <Text style={estilos.progresso}>{progresso.toFixed(0)}% concluído</Text>
            </View>
          );
        }}
      />
    </View>
  );
}

const estilos = StyleSheet.create({
  fundo: { flex: 1, backgroundColor: '#f1f5f9' },
  centro: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9',
  },
  lista: { padding: 16, gap: 12 },
  cartao: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  linhaTopo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  codigo: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeTexto: { color: '#fff', fontSize: 11, fontWeight: '700' },
  nome: { color: '#0f172a', fontSize: 17, fontWeight: '700' },
  cliente: { color: '#475569', fontSize: 13, marginTop: 4 },
  local: { color: '#64748b', fontSize: 13, marginTop: 2 },
  progressTrack: {
    height: 6,
    backgroundColor: '#e2e8f0',
    borderRadius: 999,
    marginTop: 12,
    overflow: 'hidden',
  },
  progressFill: { height: 6, backgroundColor: '#2563eb', borderRadius: 999 },
  progresso: { color: '#64748b', fontSize: 12, marginTop: 6 },
  erro: { color: '#dc2626', padding: 16 },
  vazio: { color: '#64748b', textAlign: 'center', marginTop: 40 },
});
