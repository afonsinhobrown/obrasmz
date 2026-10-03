import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useAuth } from '../lib/auth';
import LoginScreen from '../screens/LoginScreen';
import ObrasScreen from '../screens/ObrasScreen';
import PontoScreen from '../screens/PontoScreen';
import DiarioScreen from '../screens/DiarioScreen';
import MaisScreen from '../screens/MaisScreen';
import OrcamentoScreen from '../screens/OrcamentoScreen';
import CustosScreen from '../screens/CustosScreen';
import StockScreen from '../screens/StockScreen';
import PagamentosScreen from '../screens/PagamentosScreen';

export type RootStackParamList = {
  Login: undefined;
  Principal: undefined;
  Orcamento: undefined;
  Custos: undefined;
  Stock: undefined;
  Pagamentos: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

const cabecalho = {
  headerStyle: { backgroundColor: '#0f172a' },
  headerTintColor: '#fff',
  headerTitleStyle: { fontWeight: '700' as const },
};

function Abas() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#fff',
        tabBarActiveTintColor: '#2563eb',
      }}
    >
      <Tab.Screen name="Obras" component={ObrasScreen} />
      <Tab.Screen name="Ponto" component={PontoScreen} />
      <Tab.Screen name="Diário" component={DiarioScreen} />
      <Tab.Screen name="Mais" component={MaisScreen} />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  const { aIniciar, sessao } = useAuth();

  if (aIniciar) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0f172a',
        }}
      >
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {sessao ? (
          <>
            <Stack.Screen name="Principal" component={Abas} />
            <Stack.Screen
              name="Orcamento"
              component={OrcamentoScreen}
              options={{ headerShown: true, title: 'Orçamento', ...cabecalho }}
            />
            <Stack.Screen
              name="Custos"
              component={CustosScreen}
              options={{ headerShown: true, title: 'Custos', ...cabecalho }}
            />
            <Stack.Screen
              name="Stock"
              component={StockScreen}
              options={{ headerShown: true, title: 'Stock', ...cabecalho }}
            />
            <Stack.Screen
              name="Pagamentos"
              component={PagamentosScreen}
              options={{ headerShown: true, title: 'Pagamentos', ...cabecalho }}
            />
          </>
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
