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

export type RootStackParamList = {
  Login: undefined;
  Principal: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

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
          <Stack.Screen name="Principal" component={Abas} />
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
