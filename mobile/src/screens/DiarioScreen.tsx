import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  criarEntradaDiario,
  entradasDiario,
  listarObras,
} from '../lib/dados';
import type { EntradaDiario, Obra } from '../lib/types';

function hojeISO(): string {
  const d = new Date();
  const mes = `${d.getMonth() + 1}`.padStart(2, '0');
  const dia = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

export default function DiarioScreen() {
  const data = hojeISO();
  const [obras, setObras] = useState<Obra[]>([]);
  const [obraId, setObraId] = useState<string | null>(null);
  const [entradas, setEntradas] = useState<EntradaDiario[]>([]);
  const [aCarregar, setACarregar] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Modal de nova entrada
  const [aMostrarForm, setAMostrarForm] = useState(false);
  const [trabalhos, setTrabalhos] = useState('');
  const [clima, setClima] = useState('');
  const [ocorrencias, setOcorrencias] = useState('');
  const [progresso, setProgresso] = useState('');
  const [aSubmeter, setASubmeter] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const obrasArr = await listarObras();
      setObras(obrasArr);
      setObraId((atual) => atual ?? obrasArr[0]?.id ?? null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar.');
    } finally {
      setACarregar(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const carregarEntradas = useCallback(
    async (idObra: string) => {
      try {
        const res = await entradasDiario(idObra, data, data);
        setEntradas(res);
      } catch {
        setEntradas([]);
      }
    },
    [data],
  );

  useEffect(() => {
    if (obraId) carregarEntradas(obraId);
  }, [obraId, carregarEntradas]);

  useFocusEffect(
    useCallback(() => {
      if (obraId) carregarEntradas(obraId);
    }, [obraId, carregarEntradas]),
  );

  const abrirForm = () => {
    setTrabalhos('');
    setClima('');
    setOcorrencias('');
    setProgresso('');
    setAMostrarForm(true);
  };

  const registar = async () => {
    if (!obraId) {
      Alert.alert('Selecione uma obra', 'Escolha a obra no topo.');
      return;
    }
    if (trabalhos.trim().length < 3) {
      Alert.alert('Descreva os trabalhos', 'Indique pelo menos 3 caracteres.');
      return;
    }
    setASubmeter(true);
    try {
      await criarEntradaDiario({
        obraId,
        data,
        clima: clima.trim() || null,
        trabalhos: trabalhos.trim(),
        ocorrencias: ocorrencias.trim() || null,
        progressoPct: progresso.trim() ? Number(progresso) : null,
      });
      setAMostrarForm(false);
      await carregarEntradas(obraId);
    } catch (e) {
      Alert.alert(
        'Falha',
        e instanceof Error ? e.message : 'Não foi possível registar.',
      );
    } finally {
      setASubmeter(false);
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

      <FlatList
        data={entradas}
        keyExtractor={(e) => e.id}
        contentContainerStyle={estilos.lista}
        ListEmptyComponent={
          <Text style={estilos.vazio}>Sem registos hoje.</Text>
        }
        renderItem={({ item }) => (
          <View style={estilos.cartao}>
            <Text style={estilos.trabalhos}>{item.trabalhos}</Text>
            {item.ocorrencias ? (
              <Text style={estilos.ocorrencias}>{item.ocorrencias}</Text>
            ) : null}
            <View style={estilos.rodape}>
              {item.clima ? <Text style={estilos.clima}>{item.clima}</Text> : null}
              {item.progressoPct !== null && item.progressoPct !== undefined ? (
                <Text style={estilos.progresso}>
                  {Number(item.progressoPct).toFixed(0)}%
                </Text>
              ) : null}
            </View>
          </View>
        )}
      />

      <TouchableOpacity style={estilos.fab} onPress={abrirForm}>
        <Text style={estilos.fabTexto}>+</Text>
      </TouchableOpacity>

      <Modal
        visible={aMostrarForm}
        animationType="slide"
        transparent
        onRequestClose={() => setAMostrarForm(false)}
      >
        <KeyboardAvoidingView
          style={estilos.modalFundo}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={estilos.modal}>
            <Text style={estilos.modalTitulo}>Registo do dia</Text>

            <Text style={estilos.rotulo}>Trabalhos realizados</Text>
            <TextInput
              style={[estilos.campo, estilos.area]}
              value={trabalhos}
              onChangeText={setTrabalhos}
              multiline
              placeholder="O que foi feito hoje?"
              placeholderTextColor="#94a3b8"
            />

            <Text style={estilos.rotulo}>Clima (opcional)</Text>
            <TextInput
              style={estilos.campo}
              value={clima}
              onChangeText={setClima}
              placeholder="Sol, chuva…"
              placeholderTextColor="#94a3b8"
            />

            <Text style={estilos.rotulo}>Ocorrências (opcional)</Text>
            <TextInput
              style={estilos.campo}
              value={ocorrencias}
              onChangeText={setOcorrencias}
              placeholder="Atrasos, falta de material…"
              placeholderTextColor="#94a3b8"
            />

            <Text style={estilos.rotulo}>Progresso % (opcional)</Text>
            <TextInput
              style={estilos.campo}
              value={progresso}
              onChangeText={setProgresso}
              keyboardType="numeric"
              placeholder="0–100"
              placeholderTextColor="#94a3b8"
            />

            <View style={estilos.modalBotoes}>
              <TouchableOpacity
                style={estilos.cancelar}
                onPress={() => setAMostrarForm(false)}
              >
                <Text style={estilos.cancelarTexto}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[estilos.registar, aSubmeter && { opacity: 0.6 }]}
                onPress={registar}
                disabled={aSubmeter}
              >
                {aSubmeter ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={estilos.registarTexto}>Registar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  lista: { padding: 16, gap: 12, paddingBottom: 90 },
  cartao: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
  },
  trabalhos: { color: '#0f172a', fontSize: 15 },
  ocorrencias: { color: '#b45309', fontSize: 13, marginTop: 8 },
  rodape: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  clima: { color: '#64748b', fontSize: 12 },
  progresso: { color: '#2563eb', fontSize: 12, fontWeight: '700' },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  fabTexto: { color: '#fff', fontSize: 28, lineHeight: 32 },
  erro: { color: '#dc2626', padding: 16 },
  vazio: { color: '#64748b', textAlign: 'center', marginTop: 40 },
  modalFundo: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modal: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 32,
  },
  modalTitulo: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  rotulo: { color: '#475569', fontSize: 13, marginBottom: 6, marginTop: 10 },
  campo: {
    backgroundColor: '#f1f5f9',
    color: '#0f172a',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  area: { minHeight: 90, textAlignVertical: 'top' },
  modalBotoes: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 20,
  },
  cancelar: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#e2e8f0',
  },
  cancelarTexto: { color: '#334155', fontWeight: '600' },
  registar: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  registarTexto: { color: '#fff', fontWeight: '700' },
});
