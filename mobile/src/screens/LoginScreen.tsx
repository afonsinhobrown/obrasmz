import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '../lib/auth';

export default function LoginScreen() {
  const { entrar } = useAuth();
  const [identificador, setIdentificador] = useState('');
  const [senha, setSenha] = useState('');
  const [aSubmeter, setASubmeter] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const submeter = async () => {
    setErro(null);
    if (!identificador.trim() || !senha) {
      setErro('Indique o email/telefone e a senha.');
      return;
    }
    setASubmeter(true);
    try {
      await entrar(identificador.trim(), senha);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha no login.');
    } finally {
      setASubmeter(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={estilos.fundo}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={estilos.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={estilos.titulo}>ObraMZ</Text>
        <Text style={estilos.subtitulo}>
          Gestão de obras em Moçambique
        </Text>

        <Text style={estilos.rotulo}>Email ou telefone</Text>
        <TextInput
          style={estilos.campo}
          value={identificador}
          onChangeText={setIdentificador}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          placeholder="admin@empresa.co.mz"
          placeholderTextColor="#94a3b8"
        />

        <Text style={estilos.rotulo}>Senha</Text>
        <TextInput
          style={estilos.campo}
          value={senha}
          onChangeText={setSenha}
          secureTextEntry
          placeholder="••••••••"
          placeholderTextColor="#94a3b8"
        />

        {erro ? <Text style={estilos.erro}>{erro}</Text> : null}

        <TouchableOpacity
          style={[estilos.botao, aSubmeter && estilos.botaoDesativado]}
          onPress={submeter}
          disabled={aSubmeter}
        >
          <Text style={estilos.botaoTexto}>
            {aSubmeter ? 'A entrar…' : 'Entrar'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const estilos = StyleSheet.create({
  fundo: { flex: 1, backgroundColor: '#0f172a' },
  container: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  titulo: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '800',
    textAlign: 'center',
  },
  subtitulo: {
    color: '#94a3b8',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 32,
  },
  rotulo: { color: '#cbd5e1', fontSize: 13, marginBottom: 6 },
  campo: {
    backgroundColor: '#1e293b',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  erro: { color: '#f87171', marginBottom: 12 },
  botao: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  botaoDesativado: { opacity: 0.6 },
  botaoTexto: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
