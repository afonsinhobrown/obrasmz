// O expo-sqlite na web precisa que o Metro empacote ficheiros .wasm.
// Em Android/iOS o SQLite e' nativo; na web, se o wasm nao puder
// correr (falta de cabecalhos COEP/COOP), a app cai para a loja
// AsyncStorage — ver src/lib/storeLocal.ts.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('wasm');

module.exports = config;
