# Sesión de la app mobile (ENG-114)

## Por qué la app mobile no usa las cookies de la web

La web guarda la sesión en dos cookies httpOnly (`sb-access-token` y
`sb-refresh-token`) que setea `POST /auth/login`. El JS del browser nunca ve los
tokens, y eso protege contra el robo de sesión por XSS.

En React Native ese modelo no aplica: no hay un almacén de cookies que la app
controle ni que cifre el sistema operativo. El lugar seguro para un secreto en
el celular es el **Keychain** (iOS) o el **Keystore** (Android), a los que la app
accede con `expo-secure-store`. Para guardarlos ahí, la app necesita recibir los
tokens.

## Las rutas

| Ruta | Body | Respuesta | Cookies |
|---|---|---|---|
| `POST /auth/mobile/login` | `{ email, password }` | `{ user, accessToken, refreshToken }` | no setea |
| `POST /auth/mobile/refresh` | `{ refreshToken }` | `{ user, accessToken, refreshToken }` | no lee ni setea |

Después del login, cada request de la app lleva `Authorization: Bearer
<accessToken>`, que `JwtAuthGuard` ya aceptaba: el resto de la API no cambia.

Las dos rutas reusan `AuthService.login` y `AuthService.refresh`, así que se
comportan igual que las de la web:

- Credenciales inválidas y email sin confirmar → **el mismo 401 genérico**
  (anti-enumeración, ENG-44).
- Refresh token inválido, vencido o ya usado → 401: la app borra la sesión.
- Supabase caído o con rate limit → **503**: la app **no** borra la sesión, porque
  no es un token inválido.
- **5 requests por minuto** por cliente, como `/auth/login` y `/auth/refresh`.
- `Cache-Control: no-store`, porque la respuesta lleva credenciales (RFC 6749
  §5.1).

## Por qué rutas aparte y no un flag en `/auth/login`

- El contrato de la web —"los tokens nunca llegan al body"— sigue verificado por
  `test/auth.e2e-spec.ts` y no tiene una rama que se active con un header que
  cualquiera puede mandar.
- Una sesión vive en un solo lugar: estas rutas no setean cookies, así que no hay
  dos copias del mismo token con ciclos de vida distintos.
- Un token en el body no agrega superficie a la web: para pedirle un token a
  `/auth/mobile/login`, un script inyectado necesitaría la contraseña, y con la
  contraseña ya puede iniciar sesión igual.

## Qué hace la app con los tokens

Lo implementa `mediconnect-mobile` (ENG-114):

1. Los guarda **solo** en `expo-secure-store`, nunca en `AsyncStorage` ni en
   el estado de React.
2. Ante un 401 hace **un solo** refresh a la vez. Supabase rota el refresh token
   en cada uso, y dos refresh en paralelo con el mismo token se pisan.
3. Reemplaza los dos tokens por los del refresh antes de reintentar.
4. Al cerrar sesión borra los dos del secure store.

## Riesgo conocido: el logout no revoca el refresh token

Cerrar sesión en la app borra los tokens del dispositivo, igual que el logout de
la web borra las cookies: **ninguno de los dos revoca la sesión en Supabase.** Un
refresh token copiado antes del logout sigue sirviendo hasta que vence (7 días),
y Supabase no detecta su reuso ([refresh-token-reuse-risk-plan.md](./refresh-token-reuse-risk-plan.md)).

En el celular, sacar el token del Keychain o del Keystore requiere un dispositivo
comprometido, así que el riesgo es el mismo que ya se aceptó para la web.
Revocarlo del lado del servidor al cerrar sesión (`auth.admin.signOut`) cierra el
hueco para las dos plataformas y queda como mejora aparte.

## Verificación

```bash
pnpm run test:e2e -- auth-mobile
```

Contra un deploy:

```bash
curl -si -X POST "$API/auth/mobile/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"…","password":"…"}' | grep -iE '^(HTTP|cache-control|set-cookie)'
# HTTP/… 200, Cache-Control: no-store, y ningún Set-Cookie
```
