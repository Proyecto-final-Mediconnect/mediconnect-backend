// ENG-40 — Validación empírica: verificar un JWT de Supabase en el backend
// LOCALMENTE (JWKS + jose), sin llamar a Supabase Auth por cada verificación.
// Ejecutar con: node --env-file=.env scripts/verify-jwt.mjs
import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;

// 1) Un cliente obtiene un token real vía login (esto lo hace el front, no el backend).
const supabase = createClient(url, anon, { auth: { persistSession: false } });
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'paciente.eng42@gmail.com',
  password: 'Password1',
});
if (error) {
  console.error('❌ Login falló:', error.message);
  process.exit(1);
}
const token = data.session.access_token;
const header = decodeProtectedHeader(token);
console.log('Token obtenido. Header:', JSON.stringify(header));

// 2) El BACKEND verifica el token localmente contra el JWKS (clave pública).
//    createRemoteJWKSet cachea la clave; no se llama a Supabase por verificación.
const JWKS = createRemoteJWKSet(
  new URL(`${url}/auth/v1/.well-known/jwks.json`),
);
const { payload } = await jwtVerify(token, JWKS, {
  issuer: `${url}/auth/v1`,
});

console.log('✅ JWT VERIFICADO LOCALMENTE (sin llamar a Supabase Auth)');
console.log('   alg      :', header.alg, '(asimétrico, no HS256)');
console.log('   sub      :', payload.sub, '(= profiles.id)');
console.log('   email    :', payload.email);
console.log('   role JWT :', payload.role);
console.log('   exp      :', new Date(payload.exp * 1000).toISOString());

// 3) Prueba negativa: un token manipulado debe ser rechazado.
const tampered = token.slice(0, -3) + 'AAA';
try {
  await jwtVerify(tampered, JWKS, { issuer: `${url}/auth/v1` });
  console.log('❌ ERROR: un token manipulado fue aceptado (no debería)');
} catch {
  console.log('✅ Token manipulado RECHAZADO correctamente (firma inválida)');
}
