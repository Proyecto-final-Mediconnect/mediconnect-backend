# Rate limiting

**ENG-84** · `@nestjs/throttler` 6.5 · contador en memoria

## Límites vigentes

Un límite global para toda la API y límites más estrictos en las rutas donde un
abuso cuesta caro. Todos son **por cliente** y por ventana de 60 segundos.

| Ruta | Límite | Por qué más estricto |
| --- | --- | --- |
| *Todas* (global) | **60 / min** | — |
| `POST /auth/login` | 5 / min | Fuerza bruta de contraseñas. |
| `POST /auth/refresh` | 5 / min | Mitigación del reuso de refresh tokens que Supabase no detecta (ver [`refresh-token-reuse-risk-plan.md`](./refresh-token-reuse-risk-plan.md)). |
| `POST /video/spike/rooms` | 5 / min | Cada llamada crea una sala en Daily, que se factura por uso. |
| `POST /appointments` | 10 / min | Reservar bloquea agenda del profesional. |
| `POST /appointments/:id/video` | 10 / min | Crea o reusa una sala de Daily. |
| `POST /patients/:id/clinical-record` | 20 / min | Cada entrada es append-only: no se puede borrar. |

Superar un límite devuelve **429**. Cada respuesta trae `X-RateLimit-Limit`,
`X-RateLimit-Remaining` y `X-RateLimit-Reset`.

El global se define en `app.module.ts` y los de ruta con `@Throttle` en cada
controller. Para sumar uno, se agrega el decorador y una fila a esta tabla.

### Por qué 60 por minuto

Es un request por segundo sostenido **por usuario**. La web hace pocos requests por
pantalla, así que un uso normal queda muy por debajo. Un script que recorre el
catálogo o la agenda queda frenado al minuto. El valor deja margen para uso real y
no protege contra un ataque distribuido, que no es algo que se resuelva a este
nivel.

## Cómo se identifica al cliente

**Por el header `CF-Connecting-IP`**, no por `req.ip`. Lo hace
`src/common/throttler/client-ip-throttler.guard.ts`.

### Qué estaba mal (medido el 23/09/2026)

Delante de Render hay **Cloudflare** (`Server: cloudflare` y `CF-RAY` en toda
respuesta). La cadena es: cliente → Cloudflare → Render → backend. Con
`trust proxy = 1`, Express toma la última IP de `X-Forwarded-For`, que es la IP de
**salida de Cloudflare**, no la del cliente.

Se midió desde un solo cliente mirando `X-RateLimit-Remaining` en 20 requests
seguidos a `/health`: el contador **no bajaba de a uno**, sino que alternaba entre
**dos cupos distintos**, uno por cada IP de salida del edge de Buenos Aires
(`CF-RAY …-EZE`). El plan gratis de Render corre una sola instancia, así que no se
trataba de dos réplicas con contadores separados.

La consecuencia: **el límite no era por usuario, era por IP de Cloudflare**. Todos
los usuarios de la región compartían dos cupos, y el de 5 por minuto de
`POST /auth/login` se agotaba con seis personas iniciando sesión en el mismo minuto.

### Por qué `CF-Connecting-IP` y no `X-Forwarded-For`

| Opción | Problema |
| --- | --- |
| `req.ip` con `trust proxy = 1` | Es la IP de Cloudflare: el cupo es compartido. |
| Primera posición de `X-Forwarded-For` | **El cliente la controla.** Con un valor inventado en cada request, cada uno cae en un contador nuevo y el límite no frena nunca. Es lo que sugiere el ejemplo de la documentación de NestJS, y acá sería un agujero. |
| **`CF-Connecting-IP`** | Cloudflare lo **reemplaza** en cada request con la IP real. Un cliente que lo manda a través de Cloudflare no logra nada: el valor que llega es el de Cloudflare. |

Si el header no viene (en local o en tests) o no es una IP válida, el guard vuelve a
`req.ip`.

### El supuesto del que depende

Que **no haya camino al backend que no pase por Cloudflare**. Hoy es así: todo
`*.onrender.com` resuelve a Cloudflare. Si Render dejara de usarlo, el header deja
de llegar y el guard vuelve a `req.ip`. Se pierde precisión, pero no se abre una
forma de esquivar el límite.

Lo que sí rompería el supuesto es exponer el backend por otro camino, por ejemplo con
un dominio propio que no pase por Cloudflare. En ese caso, cualquiera podría mandar un
`CF-Connecting-IP` falso. **Antes de cambiar cómo se expone el backend, revisar este
guard.**

## Verificar contra el deploy

Mandar requests seguidos a `/health` y mirar el contador:

```bash
for i in $(seq 1 10); do
  curl -s -D - -o /dev/null https://mediconnect-backend-smss.onrender.com/health \
    | grep -i x-ratelimit-remaining
done
```

- **Correcto:** baja de a uno sin saltos (59, 58, 57…).
- **Cupo compartido:** alterna entre dos series (58, 56, 55, 57, 56, 54…). Es el
  síntoma de que el tracker volvió a ser la IP del proxy.

Para confirmar que un `X-Forwarded-For` falso no esquiva el límite, repetir con
`-H "X-Forwarded-For: 1.2.3.$i"`: el contador tiene que seguir bajando igual.

## Limitaciones conocidas

- **El contador vive en memoria.** Si el servicio se reinicia (por ejemplo, cuando
  Render lo duerme por inactividad), los cupos vuelven a cero. Si algún día hay más
  de una instancia, cada una tendría su contador y el límite real se multiplicaría
  por la cantidad de instancias. El arreglo en ese caso es un storage compartido
  (Redis), no hace falta hoy.
- **Muchos usuarios detrás de una misma IP** (una red de hospital, una facultad, un
  NAT de operador móvil) comparten cupo. Con 60 por minuto no debería notarse en el
  global, pero sí puede pasar en los de 5 por minuto de `auth`.
