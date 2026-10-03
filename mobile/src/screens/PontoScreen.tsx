import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  listarObras,
  listarTrabalhadores,
  marcarPresenca,
  presencasDia,
} from '../lib/dados';
import type { Obra, Presenca, Trabalhador } from '../lib/types';

/** Data de hoje em ISO (YYYY-MM-DD), no fuso do dispositivo. */
function hojeISO(): string {
  const d = new Date();
  const mes = `${d.getMonth() + 1}`.padStart(2, '0');
  const dia = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

export default function PontoScreen() {
  const data = hojeISO();
  const [obras, setObras] = useState<Obra[]>([]);
  const [obraId, setObraId] = useState<string | null>(null);
  const [trabalhadores, setTrabalhadores] = useState<Trabalhador[]>([]);
  const [presencas, setPresencas] = useState<Presenca[]>([]);
  const [aCarregar, setACarregar] = useState(true);
  const [aSubmeter, setASubmeter] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  // Obras + trabalhadores (uma vez).
  useEffect(() => {
    (async () => {
      try {
        const [o, t] = await Promise.all([
          listarObras(),
          listarTrabalhadores(),
        ]);
        const obrasArr = o;
        setObras(obrasArr);
        setTrabalhadores(t);
        if (obrasArr.length > 0) {
          setObraId((atual) => atual ?? obrasArr[0].id);
        }
      } catch (e) {
        setErro(e instanceof Error ? e.message : 'Falha ao carregar.');
      } finally {
        setACarregar(false);
      }
    })();
  }, []);

  // Presenças de hoje na obra seleccionada.
  const carregarPresencas = useCallback(
    async (idObra: string) => {
      try {
        const res = await presencasDia(idObra, data);
        setPresencas(res);
      } catch {
        setPresencas([]);
      }
    },
    [data],
  );

  useEffect(() => {
    if (obraId) carregarPresencas(obraId);
  }, [obraId, carregarPresencas]);

  // Recarrega ao focar.
  useFocusEffect(
    useCallback(() => {
      if (obraId) carregarPresencas(obraId);
    }, [obraId, carregarPresencas]),
  );

  const estaPresente = (trabalhadorId: string) =>
    presencas.some((p) => p.trabalhadorId === trabalhadorId && p.presente);

  const marcar = async (t: Trabalhador) => {
    if (!obraId) {
      Alert.alert('Selecione uma obra', 'Escolha a obra no topo.');
      return;
    }
    setASubmeter(t.id);
    try {
      await marcarPresenca(obraId, t.id, data, true);
      await carregarPresencas(obraId);
    } catch (e) {
      Alert.alert(
        'Falha',
        e instanceof Error ? e.message : 'Não foi possível registar.',
      );
    } finally {
      setASubmeter(null);
    }
  };

  if (aCarregar) {
    return (
      <View style={estilos.centro}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <View style={estilos.fundo}>
      {erro ? <Text style={estilos.erro}>{erro}</Text> : null}

      {/* Seletor de obra */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={estilos.seletor}
        contentContainerStyle={estilos.seletorConteudo}
      >
        {obras.map((o) => {
          const activo = o.id === obraId;
          return (
            <TouchableOpacity
              key={o.id}
              style={[estilos.chip, activo && estilos.chipActivo]}
              onPress={() => setObraId(o.id)}
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

      <Text style={estilos.data}>{data}</Text>

      <FlatList
        data={trabalhadores}
        keyExtractor={(t) => t.id}
        contentContainerStyle={estilos.lista}
        ListEmptyComponent={<Text style={estilos.vazio}>Sem trabalhadores.</Text>}
        renderItem={({ item }) => {
          const presente = estaPresente(item.id);
          const aSubmeterEste = aSubmeter === item.id;
          return (
            <View style={estilos.linha}>
              <View style={estilos.info}>
                <Text style={estilos.nome}>{item.nome}</Text>
                {item.funcao ? (
                  <Text style={estilos.funcao}>{item.funcao}</Text>
                ) : null}
              </View>
              {presente ? (
                <View style={estilos.badgePresente}>
                  <Text style={estilos.badgePresenteTexto}>Presente</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={estilos.botao}
                  onPress={() => marcar(item)}
                  disabled={aSubmeterEste !== null}
                >
                  {aSubmeterEste ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={estilos.botaoTexto}>Marcar</Text>
                  )}
                </TouchableOpacity>
              )}
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
  seletor: { flexGrow: 0, backgroundColor: '#fff' },
  seletorConteudo: { padding: 12, gap: 8 },
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
  data: {
    color: '#64748b',
    fontSize: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  lista: { paddingHorizontal: 16, paddingBottom: 24, gap: 10 },
  linha: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  info: { flex: 1, marginRight: 12 },
  nome: { color: '#0f172a', fontSize: 16, fontWeight: '600' },
  funcao: { color: '#64748b', fontSize: 13, marginTop: 2 },
  botao: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minWidth: 84,
    alignItems: 'center',
  },
  botaoTexto: { color: '#fff', fontWeight: '700', fontSize: 14 },
  badgePresente: {
    backgroundColor: '#dcfce7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  badgePresenteTexto: { color: '#16a34a', fontWeight: '700', fontSize: 13 },
  erro: { color: '#dc2626', padding: 16 },
  vazio: { color: '#64748b', textAlign: 'center', marginTop: 40 },
});
