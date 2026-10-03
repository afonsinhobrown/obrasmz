/**
 * URL base da API. Em desenvolvimento, define-se via
 * EXPO_PUBLIC_API_URL (ex.: http://192.168.1.10:3333 para
 * apontar ao servidor local na rede). Em producao, aponta
 * ao deploy na Render.
 */
export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'https://obramz-api.onrender.com';
