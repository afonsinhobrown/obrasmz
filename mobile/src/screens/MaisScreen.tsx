import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../lib/auth';

type Nav = NativeStackNavigationProp<any>;

type Item = {
  titulo: string;
  descricao: string;
  alvo: string;
  icone: string;
};

const ITENS: Item[] = [
  { titulo: 'Orçamento', descricao: 'Itens e execução por obra', alvo: 'Orcamento', icone: '📊' },
  { titulo: 'Custos', descricao: 'Lançar e ver custos', alvo: 'Custos', icone: '💸' },
  { titulo: 'Stock', descricao: 'Saldo e movimentos', alvo: 'Stock', icone: '📦' },
  { titulo: 'Pagamentos', descricao: 'Registar e ver pagamentos', alvo: 'Pagamentos', icone: '💳' },
];

export default function MaisScreen() {
  const navigation = useNavigation<Nav>();
  const { perfil } = useAuth();

  return (
    <ScrollView style={estilos.fundo} contentContainerStyle={estilos.container}>
      {perfil ? (
        <View style={estilos.perfil}>
          <Text style={estilos.perfilNome}>{perfil.nome}</Text>
          <Text style={estilos.perfilPapel}>{perfil.papel}</Text>
        </View>
      ) : null}

      <Text style={estilos.secao}>Gestão</Text>
      <View style={estilos.lista}>
        {ITENS.map((item) => (
          <TouchableOpacity
            key={item.alvo}
            style={estilos.cartao}
            onPress={() => navigation.navigate(item.alvo)}
          >
            <Text style={estilos.icone}>{item.icone}</Text>
            <View style={{ flex: 1 }}>
              <Text style={estilos.titulo}>{item.titulo}</Text>
              <Text style={estilos.descricao}>{item.descricao}</Text>
            </View>
            <Text style={estilos.seta}>›</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const estilos = StyleSheet.create({
  fundo: { flex: 1, backgroundColor: '#f1f5f9' },
  container: { padding: 16 },
  perfil: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  perfilNome: { color: '#fff', fontSize: 17, fontWeight: '700' },
  perfilPapel: { color: '#94a3b8', fontSize: 13, marginTop: 2, textTransform: 'capitalize' },
  secao: { color: '#64748b', fontSize: 12, fontWeight: '700', marginBottom: 8 },
  lista: { gap: 10 },
  cartao: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  icone: { fontSize: 22, marginRight: 12 },
  titulo: { color: '#0f172a', fontSize: 15, fontWeight: '700' },
  descricao: { color: '#64748b', fontSize: 12, marginTop: 2 },
  seta: { color: '#cbd5e1', fontSize: 24, marginLeft: 8 },
});
