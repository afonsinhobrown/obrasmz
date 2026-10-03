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
import { custosObra, lancarCusto } from '../lib/dados';
import SeletorObra from '../components/SeletorObra';
import type { Custo } from '../lib/types';

const TIPOS = [
  'material',
  'mao_de_obra',
  'subempreitada',
  'equipamento',
  'outro',
] as const;

const TIPO_TEXTO: Record<string, string> = {
  material: 'Material',
  mao_de_obra: 'Mão de obra',
  subempreitada: 'Subempreitada',
  equipamento: 'Equipamento',
  outro: 'Outro',
};

const TIPO_COR: Record<string, string> = {
  material: '#2563eb',
  mao_de_obra: '#7c3aed',
  subempreitada: '#d97706',
  equipamento: '#0891b2',
  outro: '#64748b',
};

function hojeISO(): string {
  const d = new Date();
  const mes = `${d.getMonth() + 1}`.padStart(2, '0');
  const dia = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

const fmt = (n: number) => n.toLocaleString('pt-PT');

export default function CustosScreen() {
  const [obraId, setObraId] = useState<string | null>(null);
  const [custos, setCustos] = useState<Custo[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  const [aMostrarForm, setAMostrarForm] = useState(false);
  const [tipo, setTipo] = useState<Custo['tipo']>('material');
  const [descricao, setDescricao] = useState('');
  const [valor, setValor] = useState('');
  const [moeda, setMoeda] = useState('MZN');
  const [aSubmeter, setASubmeter] = useState(false);

  const carregar = useCallback(async (id: string) => {
    try {
      setErro(null);
      const res = await custosObra(id);
      setCustos(res);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar.');
    }
  }, []);

  useEffect(() => {
    if (obraId) carregar(obraId);
  }, [obraId, carregar]);

  useFocusEffect(
    useCallback(() => {
      if (obraId) carregar(obraId);
    }, [obraId, carregar]),
  );

  const total = custos.reduce((s, c) => s + Number(c.valor || 0), 0);

  const registar = async () => {
    if (!obraId) {
      Alert.alert('Selecione uma obra');
      return;
    }
    const v = Number(valor);
    if (!descricao.trim() || !(v > 0)) {
      Alert.alert('Indique descrição e um valor maior que zero.');
      return;
    }
    setASubmeter(true);
    try {
      await lancarCusto({
        obraId,
        tipo,
        descricao: descricao.trim(),
        valor: v,
        moeda,
        data: hojeISO(),
      });
      setAMostrarForm(false);
      setDescricao('');
      setValor('');
      await carregar(obraId);
    } catch (e) {
      Alert.alert('Falha', e instanceof Error ? e.message : 'Não foi possível lançar.');
    } finally {
      setASubmeter(false);
    }
  };

  return (
    <View style={estilos.fundo}>
      <SeletorObra obraId={obraId} onSelect={setObraId} />
      {erro ? <Text style={estilos.erro}>{erro}</Text> : null}

      <View style={estilos.totais}>
        <Text style={estilos.totalRotulo}>Total de custos</Text>
        <Text style={estilos.totalValor}>{fmt(total)} MZN</Text>
      </View>

      <FlatList
        data={custos}
        keyExtractor={(c) => c.id}
        contentContainerStyle={estilos.lista}
        ListEmptyComponent={<Text style={estilos.vazio}>Sem custos lançados.</Text>}
        renderItem={({ item }) => (
          <View style={estilos.cartao}>
            <View style={estilos.linhaTopo}>
              <View style={[estilos.badge, { backgroundColor: TIPO_COR[item.tipo] ?? TIPO_COR.outro }]}>
                <Text style={estilos.badgeTexto}>{TIPO_TEXTO[item.tipo] ?? item.tipo}</Text>
              </View>
              <Text style={estilos.data}>{item.data}</Text>
            </View>
            <Text style={estilos.descricao}>{item.descricao}</Text>
            <Text style={estilos.valor}>
              {fmt(Number(item.valor))} {item.moeda}
            </Text>
          </View>
        )}
      />

      <TouchableOpacity style={estilos.fab} onPress={() => setAMostrarForm(true)}>
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
            <Text style={estilos.modalTitulo}>Lançar custo</Text>

            <Text style={estilos.rotulo}>Tipo</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {TIPOS.map((t) => {
                const activo = t === tipo;
                return (
                  <TouchableOpacity
                    key={t}
                    style={[estilos.chipTipo, activo && estilos.chipTipoActivo]}
                    onPress={() => setTipo(t)}
                  >
                    <Text style={[estilos.chipTipoTexto, activo && { color: '#fff' }]}>
                      {TIPO_TEXTO[t]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <Text style={estilos.rotulo}>Descrição</Text>
            <TextInput
              style={estilos.campo}
              value={descricao}
              onChangeText={setDescricao}
              placeholder="Ex.: cimento, aluguer de escavadora…"
              placeholderTextColor="#94a3b8"
            />

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 2 }}>
                <Text style={estilos.rotulo}>Valor</Text>
                <TextInput
                  style={estilos.campo}
                  value={valor}
                  onChangeText={setValor}
                  keyboardType="numeric"
                  placeholder="0.00"
                  placeholderTextColor="#94a3b8"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={estilos.rotulo}>Moeda</Text>
                <TextInput
                  style={estilos.campo}
                  value={moeda}
                  onChangeText={setMoeda}
                  autoCapitalize="characters"
                  maxLength={3}
                  placeholder="MZN"
                  placeholderTextColor="#94a3b8"
                />
              </View>
            </View>

            <View style={estilos.modalBotoes}>
              <TouchableOpacity style={estilos.cancelar} onPress={() => setAMostrarForm(false)}>
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
                  <Text style={estilos.registarTexto}>Lançar</Text>
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
  totais: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    padding: 16,
  },
  totalRotulo: { color: '#94a3b8', fontSize: 12 },
  totalValor: { color: '#fff', fontSize: 18, fontWeight: '800' },
  lista: { padding: 16, gap: 12, paddingBottom: 90 },
  cartao: { backgroundColor: '#fff', borderRadius: 12, padding: 14 },
  linhaTopo: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeTexto: { color: '#fff', fontSize: 11, fontWeight: '700' },
  data: { color: '#94a3b8', fontSize: 12 },
  descricao: { color: '#0f172a', fontSize: 15 },
  valor: { color: '#0f172a', fontSize: 16, fontWeight: '800', marginTop: 6 },
  fab: {
    position: 'absolute', right: 20, bottom: 24, width: 56, height: 56,
    borderRadius: 28, backgroundColor: '#2563eb', alignItems: 'center',
    justifyContent: 'center', elevation: 4,
  },
  fabTexto: { color: '#fff', fontSize: 28, lineHeight: 32 },
  erro: { color: '#dc2626', padding: 16 },
  vazio: { color: '#64748b', textAlign: 'center', marginTop: 40 },
  modalFundo: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modal: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 32 },
  modalTitulo: { color: '#0f172a', fontSize: 18, fontWeight: '700', marginBottom: 16 },
  rotulo: { color: '#475569', fontSize: 13, marginBottom: 6, marginTop: 10 },
  campo: { backgroundColor: '#f1f5f9', color: '#0f172a', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  chipTipo: { backgroundColor: '#e2e8f0', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipTipoActivo: { backgroundColor: '#2563eb' },
  chipTipoTexto: { color: '#334155', fontSize: 13, fontWeight: '600' },
  modalBotoes: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 20 },
  cancelar: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, backgroundColor: '#e2e8f0' },
  cancelarTexto: { color: '#334155', fontWeight: '600' },
  registar: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, backgroundColor: '#2563eb', alignItems: 'center', justifyContent: 'center' },
  registarTexto: { color: '#fff', fontWeight: '700' },
});
