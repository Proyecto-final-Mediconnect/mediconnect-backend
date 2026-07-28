# Plan de riesgo: reuso de refresh tokens no detectado por Supabase

## Resumen

Supabase Auth permite configurar "detect and revoke potentially compromised
refresh tokens" (rotación + detección de reuso) con un `reuse interval`. En
el proyecto Supabase de `mediconnect-backend` esa opción está **activada**
(reuse interval: 10s), pero **empíricamente no se comporta como está
documentado**: reusar un refresh token ya rotado, más de 15 segundos después
de la rotación, sigue devolviendo una sesión válida — y el token nuevo
legítimo tampoco se revoca cuando eso pasa.

Esto se verificó dos veces de forma independiente contra el proyecto Supabase
real (ver `POST /auth/refresh`, ENG-92), no es un problema de configuración
de este repo.

## Qué significa esto en la práctica

Un refresh token (dura 7 días) filtrado por cualquier medio (robo de disco,
log filtrado, malware en el cliente, etc.) sigue siendo utilizable por un
atacante durante el resto de su vida útil, incluso después de que el usuario
legítimo haya refrescado su sesión. No hay una segunda capa de Supabase que
lo invalide al detectar el reuso.

**Esto NO afecta**: el access token (JWT) sigue verificándose correctamente
(firma ES256, issuer, audiencia, expiración — `JwtAuthGuard`, ENG-92) y dura
solo 1h. El vector de riesgo es específicamente el refresh token de 7 días.

## Probabilidad e impacto

- **Probabilidad**: baja-media. Requiere que un atacante obtenga el valor
  crudo del refresh token primero (la cookie es httpOnly + Secure en
  producción, así que XSS no lo expone directamente; el vector más realista
  es un log/error-tracking mal configurado que filtre cookies, o compromiso
  del dispositivo del usuario).
- **Impacto si ocurre**: alto para la cuenta puntual afectada (sesión
  persistente de hasta 7 días para el atacante), pero no es una vulnerabilidad
  que escale a otras cuentas por sí sola (no es una falla de autenticación
  general, es un problema de revocación de UNA sesión ya comprometida).

## Mitigación implementada ahora (corto plazo)

`POST /auth/refresh` tiene un rate limit de **5 requests/minuto por IP**
(`@nestjs/throttler`, ver `src/auth/auth.controller.ts`). Esto no cierra el
gap de reuso en sí, pero:
- Frena el abuso automatizado/masivo de un token robado.
- Da tiempo/señal para detectar el patrón antes de que se agote la ventana
  de 7 días.

**Limitación conocida**: el storage del throttler es en memoria, por proceso.
Si el backend corre en más de una instancia (horizontal scaling), cada
instancia tiene su propio contador — el límite efectivo se multiplica por la
cantidad de instancias. Aceptable para el estado actual (single instance),
revisar si se escala horizontalmente (mover a un storage compartido, ej.
Redis, vía `ThrottlerStorage` custom).

## Qué hacer si sospechamos que nos están atacando por acá

Señal típica: un usuario reporta que fue desconectado sin motivo, o que ve
actividad que no reconoce (turnos que no pidió, datos que no cargó, etc.), o
el `RequestLoggerMiddleware` muestra un volumen anormal de `POST
/auth/refresh` para el mismo `user=<uuid>` en un ventana corta.

1. **Contener**: en el dashboard de Supabase, forzar el sign-out del usuario
   afectado (Authentication → Users → buscar por email → acción de
   sign-out/revoke sessions). Esto invalida TODOS sus tokens activos
   (access + refresh), atacante incluido.
2. **Erradicar**: pedirle al usuario que cambie su contraseña (esto también
   invalida sesiones existentes del lado de Supabase).
3. **Investigar**: revisar los logs de `RequestLoggerMiddleware` (método,
   path, status, `user=<uuid>`) alrededor del horario reportado, buscando:
   - Múltiples `POST /auth/refresh` para el mismo usuario en corto tiempo.
   - Requests a rutas protegidas (`/me`, futuras rutas de negocio) que
     el usuario dice no haber hecho.
   - **Limitación actual del logging**: no se registra IP ni user-agent, así
     que hoy no se puede diferenciar "dos dispositivos legítimos del mismo
     usuario" de "el usuario + un atacante". Si esto se vuelve un problema
     recurrente, vale la pena sumar IP/user-agent al logging (fuera del
     alcance de esta mitigación puntual).
4. **Escalar a Supabase**: abrir un ticket de soporte con la reproducción de
   este documento (reuse interval 10s + detect-and-revoke activado, pero el
   reuso pasados 15s+ sigue aceptándose). Preguntar además si esta protección
   está limitada por plan (Free vs Pro).
5. **Mientras se resuelve con Supabase**: considerar bajar temporalmente el
   TTL del access token desde el dashboard de Supabase (Authentication →
   Settings) para acortar la ventana de exposición general, si el patrón de
   ataque se repite.

## Arreglo de fondo (no implementado todavía, requiere planificación aparte)

Implementar detección de reuso propia en el backend, independiente de
Supabase: guardar un hash (nunca el token crudo) del refresh token vigente
por sesión (`session_id` del JWT), y comparar en cada `POST /auth/refresh`.
Si no coincide con el último hash conocido, es señal de reuso — se rechaza
sin ni siquiera llamarle a Supabase, y se puede revocar la sesión de punta a
punta. Esto requiere una tabla nueva (Prisma) y deja de ser 100% stateless
para este caso puntual. Ver ticket asociado en Linear.

## Referencias

- `src/auth/guards/jwt-auth.guard.ts` — verificación del access token (no
  afectado por este issue).
- `src/auth/auth.controller.ts` / `auth.service.ts` — `POST /auth/refresh`.
- `src/common/middleware/request-logger.middleware.ts` — logging usado para
  investigar incidentes (paso 3 arriba).
