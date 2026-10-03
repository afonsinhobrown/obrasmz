import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { materiaisLista, movimentosStock, resumoStock } from '../lib/dados';
import SeletorObra from '../components/SeletorObra';
import type { MovimentoStock, StockResumo } from '../lib/types';

const TIPO_TEXTO: Record<string, string> = {
  entrada: 'Entrada',
  saida: 'Saída',
  ajuste: 'Ajuste',
  transferencia: 'Transferência',
};

const TIPO_COR: Record<string, string> = {
  entrada: '#16a34a',
  saida: '#dc2626',
  ajuste: '#d97706',
  transferencia: '#2563eb',
};

const fmt = (n: number) => n.toLocaleString('pt-PT');

export default function StockScreen() {
  const [obraId, setObraId] = useState<string | null>(null);
  const [resumo, setResumo] = useState<StockResumo | null>(null);
  const [movimentos, setMovimentos] = useState<MovimentoStock[]>([]);
  const [materiais, setMateriais] = useState<Map<string, string>>(new Map());
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async (id: string) => {
    try {
      setErro(null);
      const [r, m, cat] = await Promise.all([
        resumoStock(id),
        movimentosStock(id),
        materiaisLista(),
      ]);
      setResumo(r);
      setMovimentos(m);
      const mapa = new Map<string, string>();
      cat.forEach((mt) => mapa.set(mt.id, mt.nome));
      setMateriais(mapa);
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

  return (
    <View style={estilos.fundo}>
      <SeletorObra obraId={obraId} onSelect={setObraId} />
      {erro ? <Text style={estilos.erro}>{erro}</Text> : null}

      {/* Resumo agregado da obra */}
      <View style={estilos.resumo}>
        <View>
          <Text style={estilos.resumoRotulo}>Materiais em stock</Text>
          <Text style={estilos.resumoValor}>
            {resumo ? resumo.materiais : '—'}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={estilos.resumoRotulo}>Valor total</Text>
          <Text style={estilos.resumoValor}>
            {resumo ? `${fmt(resumo.valor)} MZN` : '—'}
          </Text>
        </View>
      </View>

      <Text style={estilos.secao}>Últimos movimentos</Text>
      <FlatList
        data={movimentos}
        keyExtractor={(m) => m.id}
        contentContainerStyle={estilos.lista}
        ListEmptyComponent={<Text style={estilos.vazio}>Sem movimentos.</Text>}
        renderItem={({ item }) => {
          const nomeMat =
            materiais.get(item.materialId) ?? 'Material';
          return (
            <View style={estilos.cartao}>
              <View style={estilos.linhaTopo}>
                <View
                  style={[
                    estilos.badge,
                    { backgroundColor: TIPO_COR[item.tipo] ?? TIPO_COR.ajuste },
                  ]}
                >
                  <Text style={estilos.badgeTexto}>
                    {TIPO_TEXTO[item.tipo] ?? item.tipo}
                  </Text>
                </View>
                <Text style={estilos.data}>
                  {new Date(item.data).toLocaleDateString('pt-PT')}
                </Text>
              </View>
              <Text style={estilos.nome}>{nomeMat}</Text>
              <Text style={estilos.qtd}>
                {item.tipo === 'saida' ? '−' : ''}
                {fmt(Number(item.quantidade))} {''}
                {item.observacoes ? `  ·  ${item.observacoes}` : ''}
              </Text>
            </View>
          );
        }}
      />
    </View>
  );
}

const estilos = StyleSheet.create({
  fundo: { flex: 1, backgroundColor: '#f1f5f9' },
  resumo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#0f172a',
    padding: 16,
  },
  resumoRotulo: { color: '#94a3b8', fontSize: 12 },
  resumoValor: { color: '#fff', fontSize: 18, fontWeight: '800', marginTop: 2 },
  secao: { color: '#64748b', fontSize: 12, fontWeight: '700', paddingHorizontal: 16, paddingTop: 12 },
  lista: { padding: 16, gap: 12 },
  cartao: { backgroundColor: '#fff', borderRadius: 12, padding: 14 },
  linhaTopo: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeTexto: { color: '#fff', fontSize: 11, fontWeight: '700' },
  data: { color: '#94a3b8', fontSize: 12 },
  nome: { color: '#0f172a', fontSize: 15, fontWeight: '600' },
  qtd: { color: '#475569', fontSize: 14, marginTop: 4 },
  erro: { color: '#dc2626', padding: 16 },
  vazio: { color: '#64748b', textAlign: 'center', marginTop: 40 },
});
