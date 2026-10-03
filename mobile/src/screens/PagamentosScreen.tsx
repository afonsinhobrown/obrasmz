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
import { api, comoArray } from '../lib/api';
import SeletorObra from '../components/SeletorObra';
import type { Pagamento, Trabalhador } from '../lib/types';

const METODOS = ['numerario', 'mpesa', 'emola', 'transferencia', 'cheque'] as const;

const METODO_TEXTO: Record<string, string> = {
  numerario: 'Numerário',
  mpesa: 'M-Pesa',
  emola: 'e-Mola',
  transferencia: 'Transferência',
  cheque: 'Cheque',
};

const ESTADO_TEXTO: Record<string, string> = {
  registado: 'Registado',
  confirmado: 'Confirmado',
  anulado: 'Anulado',
};

const ESTADO_COR: Record<string, string> = {
  registado: '#64748b',
  confirmado: '#16a34a',
  anulado: '#dc2626',
};

const fmt = (n: number) => n.toLocaleString('pt-PT');

export default function PagamentosScreen() {
  const [obraId, setObraId] = useState<string | null>(null);
  const [pagamentos, setPagamentos] = useState<Pagamento[]>([]);
  const [trabalhadores, setTrabalhadores] = useState<Trabalhador[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  const [aMostrarForm, setAMostrarForm] = useState(false);
  const [beneficiarioTipo, setBeneficiarioTipo] = useState<'trabalhador' | 'outro'>('trabalhador');
  const [trabalhadorId, setTrabalhadorId] = useState<string | null>(null);
  const [valor, setValor] = useState('');
  const [metodo, setMetodo] = useState<string>('numerario');
  const [descricao, setDescricao] = useState('');
  const [aSubmeter, setASubmeter] = useState(false);

  const carregar = useCallback(async (id: string) => {
    try {
      setErro(null);
      const [p, t] = await Promise.all([
        api.get(`/api/v1/pagamentos?obraId=${id}`),
        api.get('/api/v1/equipa/trabalhadores'),
      ]);
      setPagamentos(comoArray<Pagamento>(p));
      setTrabalhadores(comoArray<Trabalhador>(t));
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

  const total = pagamentos
    .filter((p) => p.estado !== 'anulado')
    .reduce((s, p) => s + Number(p.valor || 0), 0);

  const registar = async () => {
    if (!obraId) {
      Alert.alert('Selecione uma obra');
      return;
    }
    const v = Number(valor);
    if (!(v > 0)) {
      Alert.alert('Indique um valor maior que zero.');
      return;
    }
    if (beneficiarioTipo === 'trabalhador' && !trabalhadorId) {
      Alert.alert('Escolha o trabalhador.');
      return;
    }
    setASubmeter(true);
    try {
      await api.post('/api/v1/pagamentos', {
        obraId,
        beneficiarioTipo,
        beneficiarioId: beneficiarioTipo === 'trabalhador' ? trabalhadorId : null,
        valor: v,
        metodo,
        descricao: descricao.trim() || null,
      });
      setAMostrarForm(false);
      setValor('');
      setDescricao('');
      setTrabalhadorId(null);
      await carregar(obraId);
    } catch (e) {
      Alert.alert('Falha', e instanceof Error ? e.message : 'Não foi possível registar.');
    } finally {
      setASubmeter(false);
    }
  };

  return (
    <View style={estilos.fundo}>
      <SeletorObra obraId={obraId} onSelect={setObraId} />
      {erro ? <Text style={estilos.erro}>{erro}</Text> : null}

      <View style={estilos.totais}>
        <Text style={estilos.totalRotulo}>Total pago</Text>
        <Text style={estilos.totalValor}>{fmt(total)} MZN</Text>
      </View>

      <FlatList
        data={pagamentos}
        keyExtractor={(p) => p.id}
        contentContainerStyle={estilos.lista}
        ListEmptyComponent={<Text style={estilos.vazio}>Sem pagamentos.</Text>}
        renderItem={({ item }) => (
          <View style={estilos.cartao}>
            <View style={estilos.linhaTopo}>
              <View style={[estilos.badge, { backgroundColor: ESTADO_COR[item.estado] ?? ESTADO_COR.registado }]}>
                <Text style={estilos.badgeTexto}>{ESTADO_TEXTO[item.estado] ?? item.estado}</Text>
              </View>
              <Text style={estilos.metodo}>{METODO_TEXTO[item.metodo] ?? item.metodo}</Text>
            </View>
            <Text style={estilos.descricao}>
              {item.descricao ??
                (item.beneficiarioTipo === 'trabalhador' ? 'Trabalhador' : 'Pagamento')}
            </Text>
            <Text style={estilos.valor}>{fmt(Number(item.valor))} {item.moeda}</Text>
          </View>
        )}
      />

      <TouchableOpacity style={estilos.fab} onPress={() => setAMostrarForm(true)}>
        <Text style={estilos.fabTexto}>+</Text>
      </TouchableOpacity>

      <Modal visible={aMostrarForm} animationType="slide" transparent onRequestClose={() => setAMostrarForm(false)}>
        <KeyboardAvoidingView style={estilos.modalFundo} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={estilos.modal}>
            <Text style={estilos.modalTitulo}>Registar pagamento</Text>

            <Text style={estilos.rotulo}>A quem</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['trabalhador', 'outro'] as const).map((t) => {
                const activo = t === beneficiarioTipo;
                return (
                  <TouchableOpacity
                    key={t}
                    style={[estilos.chipTipo, activo && estilos.chipTipoActivo]}
                    onPress={() => { setBeneficiarioTipo(t); setTrabalhadorId(null); }}
                  >
                    <Text style={[estilos.chipTipoTexto, activo && { color: '#fff' }]}>
                      {t === 'trabalhador' ? 'Trabalhador' : 'Outro'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {beneficiarioTipo === 'trabalhador' ? (
              <>
                <Text style={estilos.rotulo}>Trabalhador</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {trabalhadores.map((tr) => {
                    const activo = tr.id === trabalhadorId;
                    return (
                      <TouchableOpacity
                        key={tr.id}
                        style={[estilos.chipTipo, activo && estilos.chipTipoActivo]}
                        onPress={() => setTrabalhadorId(tr.id)}
                      >
                        <Text style={[estilos.chipTipoTexto, activo && { color: '#fff' }]} numberOfLines={1}>
                          {tr.nome}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </>
            ) : null}

            <Text style={estilos.rotulo}>Valor</Text>
            <TextInput
              style={estilos.campo}
              value={valor}
              onChangeText={setValor}
              keyboardType="numeric"
              placeholder="0.00"
              placeholderTextColor="#94a3b8"
            />

            <Text style={estilos.rotulo}>Método</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {METODOS.map((m) => {
                const activo = m === metodo;
                return (
                  <TouchableOpacity
                    key={m}
                    style={[estilos.chipTipo, activo && estilos.chipTipoActivo]}
                    onPress={() => setMetodo(m)}
                  >
                    <Text style={[estilos.chipTipoTexto, activo && { color: '#fff' }]}>
                      {METODO_TEXTO[m]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <Text style={estilos.rotulo}>Descrição (opcional)</Text>
            <TextInput
              style={estilos.campo}
              value={descricao}
              onChangeText={setDescricao}
              placeholder="Ex.: salário de outubro"
              placeholderTextColor="#94a3b8"
            />

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
  totais: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0f172a', padding: 16 },
  totalRotulo: { color: '#94a3b8', fontSize: 12 },
  totalValor: { color: '#fff', fontSize: 18, fontWeight: '800' },
  lista: { padding: 16, gap: 12, paddingBottom: 90 },
  cartao: { backgroundColor: '#fff', borderRadius: 12, padding: 14 },
  linhaTopo: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeTexto: { color: '#fff', fontSize: 11, fontWeight: '700' },
  metodo: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  descricao: { color: '#0f172a', fontSize: 15 },
  valor: { color: '#0f172a', fontSize: 16, fontWeight: '800', marginTop: 6 },
  fab: { position: 'absolute', right: 20, bottom: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#2563eb', alignItems: 'center', justifyContent: 'center', elevation: 4 },
  fabTexto: { color: '#fff', fontSize: 28, lineHeight: 32 },
  erro: { color: '#dc2626', padding: 16 },
  vazio: { color: '#64748b', textAlign: 'center', marginTop: 40 },
  modalFundo: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modal: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 32 },
  modalTitulo: { color: '#0f172a', fontSize: 18, fontWeight: '700', marginBottom: 16 },
  rotulo: { color: '#475569', fontSize: 13, marginBottom: 6, marginTop: 10 },
  campo: { backgroundColor: '#f1f5f9', color: '#0f172a', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  chipTipo: { backgroundColor: '#e2e8f0', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, maxWidth: 160 },
  chipTipoActivo: { backgroundColor: '#2563eb' },
  chipTipoTexto: { color: '#334155', fontSize: 13, fontWeight: '600' },
  modalBotoes: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 20 },
  cancelar: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, backgroundColor: '#e2e8f0' },
  cancelarTexto: { color: '#334155', fontWeight: '600' },
  registar: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, backgroundColor: '#2563eb', alignItems: 'center', justifyContent: 'center' },
  registarTexto: { color: '#fff', fontWeight: '700' },
});
