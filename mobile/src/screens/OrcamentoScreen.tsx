import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { api, comoArray } from '../lib/api';
import SeletorObra from '../components/SeletorObra';
import type { OrcamentoItem } from '../lib/types';

const fmt = (n: number) => n.toLocaleString('pt-PT');

export default function OrcamentoScreen() {
  const [obraId, setObraId] = useState<string | null>(null);
  const [itens, setItens] = useState<OrcamentoItem[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async (id: string) => {
    try {
      setErro(null);
      const res = await api.get(`/api/v1/orcamento/obras/${id}/itens`);
      setItens(comoArray<OrcamentoItem>(res));
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

  const totalOrcado = itens.reduce((s, i) => s + Number(i.totalOrcado || 0), 0);
  const totalExecutado = itens.reduce(
    (s, i) => s + Number(i.qtdExecutada || 0) * Number(i.precoUnitario || 0),
    0,
  );

  return (
    <View style={estilos.fundo}>
      <SeletorObra obraId={obraId} onSelect={setObraId} />
      {erro ? <Text style={estilos.erro}>{erro}</Text> : null}

      <View style={estilos.totais}>
        <View>
          <Text style={estilos.totalRotulo}>Orcado</Text>
          <Text style={estilos.totalValor}>{fmt(totalOrcado)} MZN</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={estilos.totalRotulo}>Executado</Text>
          <Text style={estilos.totalValor}>{fmt(totalExecutado)} MZN</Text>
        </View>
      </View>

      <FlatList
        data={itens}
        keyExtractor={(i) => i.id}
        contentContainerStyle={estilos.lista}
        ListEmptyComponent={<Text style={estilos.vazio}>Sem itens de orçamento.</Text>}
        renderItem={({ item }) => {
          const qtd = Number(item.quantidade);
          const exec = Number(item.qtdExecutada);
          const pct = qtd > 0 ? Math.min(100, (exec / qtd) * 100) : 0;
          return (
            <View style={estilos.cartao}>
              <Text style={estilos.capitulo}>{item.capitulo ?? '—'}</Text>
              <Text style={estilos.descricao}>{item.descricao}</Text>
              <View style={estilos.linha}>
                <Text style={estilos.mono}>
                  {fmt(exec)} / {fmt(qtd)} {item.unidade ?? ''}
                </Text>
                <Text style={estilos.valor}>{fmt(Number(item.totalOrcado))} MZN</Text>
              </View>
              <View style={estilos.track}>
                <View style={[estilos.fill, { width: `${pct}%` }]} />
              </View>
              <Text style={estilos.pct}>{pct.toFixed(0)}% executado</Text>
            </View>
          );
        }}
      />
    </View>
  );
}

const estilos = StyleSheet.create({
  fundo: { flex: 1, backgroundColor: '#f1f5f9' },
  totais: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#0f172a',
    padding: 16,
  },
  totalRotulo: { color: '#94a3b8', fontSize: 12 },
  totalValor: { color: '#fff', fontSize: 18, fontWeight: '800', marginTop: 2 },
  lista: { padding: 16, gap: 12 },
  cartao: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
  },
  capitulo: { color: '#64748b', fontSize: 12, fontWeight: '700' },
  descricao: { color: '#0f172a', fontSize: 15, fontWeight: '600', marginTop: 2 },
  linha: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  mono: { color: '#475569', fontSize: 13 },
  valor: { color: '#0f172a', fontSize: 13, fontWeight: '700' },
  track: {
    height: 6,
    backgroundColor: '#e2e8f0',
    borderRadius: 999,
    marginTop: 10,
    overflow: 'hidden',
  },
  fill: { height: 6, backgroundColor: '#2563eb', borderRadius: 999 },
  pct: { color: '#64748b', fontSize: 11, marginTop: 4 },
  erro: { color: '#dc2626', padding: 16 },
  vazio: { color: '#64748b', textAlign: 'center', marginTop: 40 },
});
