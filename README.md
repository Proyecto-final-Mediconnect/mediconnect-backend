# MediConnect — Backend

API en **NestJS + Prisma**. La base es **PostgreSQL**: en local corre en Docker
(este repo lo levanta solo); en producción es **Supabase**.

## Puesta en marcha (local)

### Opción A — Devcontainer (recomendada)

1. Abrí el repo en VS Code → **"Reopen in Container"**.
2. Listo. El devcontainer levanta Postgres (docker-compose), instala dependencias,
   aplica las migraciones y corre el seed automáticamente (`.devcontainer/post-create.sh`).

### Opción B — Solo la base (para usar con DBeaver, o backend en tu host)

```bash
docker compose up -d db          # levanta Postgres en localhost:5432
cp .env.example .env             # DATABASE_URL ya apunta al Postgres local
#   ↑ si NO usás el devcontainer, cambiá el host "db" por "localhost" en .env
pnpm install
pnpm prisma generate
pnpm run db:setup                # migrate deploy + seed
```

**Conexión con DBeaver:** host `localhost`, puerto `5432`, base `mediconnect`,
usuario `postgres`, contraseña `postgres`.

## ¿Cómo tenemos todos la misma base? (migraciones vs. dump)

La fuente de verdad del **esquema** son las **migraciones** de Prisma
(`prisma/migrations/`), versionadas en git. Nadie se pasa un `.dump` para
sincronizar tablas: cada uno corre las mismas migraciones y obtiene una base
idéntica.

| Pieza | Qué es | Dónde |
|---|---|---|
| **Migraciones** | El esquema (tablas, FKs, índices, enums, RLS). Fuente de verdad. | `prisma/migrations/*` |
| **Seed** | Datos base compartidos (catálogo de especialidades). Es código, no binario. | `prisma/seed.ts` |
| **Bootstrap ("el dump")** | Recrea en el Postgres local lo que en prod da Supabase: extensiones, roles (`anon`/`authenticated`/`service_role`), el schema `auth` y `auth.uid()`. Sin esto, las migraciones (que usan esas piezas) no aplicarían en un Postgres pelado. Corre una sola vez al crear el volumen. | `db/bootstrap/*.sql` |

Entonces: **bootstrap (una vez) + migraciones + seed = base completa**, igual en la
máquina de cada uno. Actualizar tras un `git pull`:

```bash
pnpm run db:migrate   # aplica migraciones nuevas
pnpm run db:seed      # (si cambió el catálogo)
```

## Comandos de base de datos

| Comando | Qué hace |
|---|---|
| `pnpm run db:setup` | Aplica migraciones + seed (primer arranque). |
| `pnpm run db:migrate` | Aplica migraciones pendientes (`prisma migrate deploy`). |
| `pnpm run db:seed` | Carga/actualiza los datos base. |
| `pnpm run db:reset` | Borra el schema `public`, reaplica migraciones y seed. **Borra datos.** |
| `pnpm run db:studio` | Abre Prisma Studio (explorador web de la BD). |

> Se usa `prisma migrate deploy` (no `migrate dev`): nuestras migraciones incluyen
> SQL que referencia el schema `auth`, que no existe en la shadow-DB que `migrate
> dev` necesita.

## Overrides de dependencias (`pnpm.overrides`)

`package.json` fuerza versiones parchadas de transitivas que el paquete de arriba
todavía no actualizó. Van acotados al padre (`padre>dependencia`) para no tocar
otras rutas del árbol, y son los que hacen pasar `pnpm audit --prod` (job
`Security` del CI). Cuando el padre publique una versión que ya trae el arreglo,
se saca el override.

| Override | Advisories que cubre |
|---|---|
| `@nestjs/platform-express>multer` `^2.5.0` | GHSA-72gw-mp4g-v24j, GHSA-wc9g-mqfw-jrwm, GHSA-535w-7cp7-47q4, GHSA-q7qp-rjg7-q26m (DoS, high); GHSA-3p4h-7m6x-2hcm (moderate); GHSA-qvfw-j98x-7q72 (low) |
| `express>proxy-addr` `^2.0.8` | GHSA-jqcg-44mw-7w3h (critical, spoofing de IP con IPv4 mapeado) |
| `express>body-parser` `^2.4.0` | GHSA-27r3-jxmh-p828 (DoS, high) |
| `@prisma/config>deepmerge-ts` `^8.0.0` | GHSA-ggr8-5vv4-36mx (agotamiento de pila, high). Sube de major (7 a 8); lo usa solo la CLI de Prisma para mergear la config, y `prisma validate`, `prisma generate` y el build siguen andando |
| `@prisma/config>effect` `^3.22.1` | GHSA-7589-6fvf-x4pw (ReDoS en `Schema.TemplateLiteral`, high). Misma major; lo usa solo la CLI de Prisma para leer la config |

## Notas sobre Supabase (producción)

- El esquema se aplica con `prisma migrate deploy` contra la connection string de
  Supabase. Supabase ya provee `auth`, los roles y las extensiones, así que el
  bootstrap local NO se usa allá.
- La base `mediconnect-dev` que ya existía se debe **baselinear** la primera vez
  (marcar como aplicadas las migraciones cuyas tablas ya creó `db push`):
  `prisma migrate resolve --applied <migración>`.

### Conexión: usar el Session pooler, no la conexión directa

La connection string **directa** (`db.<project-ref>.supabase.co:5432`) resuelve
**solo a IPv6**. Desde una red o un runner sin IPv6 la conexión falla con
`ENETUNREACH` / timeout, aunque las credenciales sean correctas. Hay que usar el
**Session pooler**, que sí tiene registros A (IPv4):

```
postgresql://postgres.<project-ref>:<password>@aws-1-sa-east-1.pooler.supabase.com:5432/postgres?schema=public
```

Dos diferencias respecto de la directa, fáciles de pasar por alto:

- el **usuario** es `postgres.<project-ref>` (no `postgres`);
- el **host** es el del pooler de la región del proyecto (`sa-east-1`), no el del
  proyecto.

Se usa el puerto **5432** (session mode: conexión por sesión, soporta prepared
statements) y no el 6543 (transaction mode), porque Prisma los necesita.

Para verificar qué tenés: `getent ahosts db.<project-ref>.supabase.co` devuelve
solo direcciones `2600:...` (IPv6); el host del pooler devuelve IPv4.

### Qué rol usa cada cosa (ENG-138)

| Rol | Dónde | Para qué |
|---|---|---|
| `postgres` | Secret `DATABASE_URL` de GitHub Actions | Migraciones, seed y job de integridad. Es el dueño de las tablas. |
| `mediconnect_backend` | `DATABASE_URL` en Render | El backend en runtime: solo filas, sin DDL, sin desactivar triggers y sin `UPDATE`/`DELETE` sobre las tablas append-only. |

El rol se crea una vez con `prisma/sql/eng138-rol-backend.sql`. Los pasos para
ponerlo en marcha y la vuelta atrás están en
[`docs/security/rol-backend.md`](docs/security/rol-backend.md).

### Cargar el catálogo base (seed) en Supabase

`prisma migrate deploy` crea las tablas pero **no** carga datos: el catálogo de
especialidades (`public.specialties`, fuente única del selector del perfil
profesional y del filtro del catálogo público) viene del seed y hay que correrlo
explícitamente también contra Supabase. Si no, la tabla queda en 0 filas y ambas
features se ven vacías aunque el código esté correcto — y los tests locales no lo
detectan, porque en local la tabla sí está poblada (ENG-96).

Las variables del entorno del proceso **tienen precedencia** sobre el `.env`, así
que se puede apuntar el seed a Supabase sin tocar tu `.env` local:

```bash
$ DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-1-sa-east-1.pooler.supabase.com:5432/postgres?schema=public" \
    pnpm run db:seed
✅ Seed listo: 17 especialidades en el catálogo.
```

El seed es **idempotente** (`upsert` por `name`): correrlo de nuevo no duplica
filas ni falla. Verificación: `select count(*) from public.specialties` → `17`.

### Validación manual de matrículas (ENG-109)

Todo profesional que se registra queda en `status = 'PENDIENTE_VALIDACION_MATRICULA'`
(lo setea el alta de ENG-43), y **el catálogo público de ENG-49 lista únicamente los
`VALIDADO`**. O sea que sin este procedimiento un profesional que se registra queda
invisible para siempre y la cadena ENG-49 → ENG-50 → ENG-54 se queda sin datos con
los que trabajar.

El Sprint 0 (criterios de HU-02) decidió que durante el MVP la validación es
**manual, hecha por el equipo y no automatizada**. Lo que nunca se había definido
es qué significa "manual", y eso es lo que documenta esta sección.

> **Rol administrador (ENG-240).** El valor `MODERADOR` de `user_role` se renombró a
> `ADMINISTRADOR`: es el equipo de MediConnect, que administra a los profesionales
> (ENG-220). Nadie se registra con ese rol; se asigna con
> `scripts/grant-admin.ts` (dry run y `--apply`). Desde ENG-192 la validación de
> matrículas se hace desde el panel del administrador (ver abajo). Las reseñas
> se siguen publicando en el acto, con el filtro de lenguaje de ENG-107 como única
> barrera: no hay moderación.
>
> **Bajar una reseña abusiva.** No hay endpoint para eso: soporte lo hace a mano por
> SQL (`UPDATE reviews SET status = 'RECHAZADA', moderation_reason = '<motivo>',
> moderated_at = now() WHERE id = '<id>';`). Las reseñas `RECHAZADA` no se muestran
> ni cuentan para el rating.

#### Quién valida

**Responsable: Juan Cruz García Amadey.** Es también el
asignado del ticket que definió este procedimiento; el equipo puede reasignarlo en
una daily, y si lo hace hay que actualizar este párrafo en el mismo PR.

#### Contra qué se valida

El número de matrícula se verifica **en el registro público del colegio profesional
que corresponda a la especialidad y a la provincia** del profesional. Es el mínimo
exigible: la matrícula es lo que habilita a ejercer, y publicar en el catálogo a
alguien sin verificarla expone a los pacientes y al equipo.

Se comprueban tres cosas antes de aprobar:

1. Que la matrícula exista en el registro del colegio.
2. Que esté **vigente** (no vencida, no suspendida).
3. Que el nombre del registro coincida con `first_name` / `last_name` de la ficha.

Si alguna de las tres no cierra, va a `RECHAZADO`. Un dato que no se puede verificar
no es un dato verificado.

#### Cada cuánto se revisa la cola

**En la daily.** No es una cadencia elegida por prolijidad: mientras la cuenta está
pendiente el profesional no aparece en el catálogo y no puede recibir turnos, así
que cada día de demora es un día en que alguien que se registró no puede usar la
plataforma. Revisarla en la daily acota la espera a 24 horas hábiles.

#### El procedimiento

Desde ENG-192 se hace **desde el panel del administrador** de la web (`/admin`,
pestaña "Matrículas"), con una cuenta `ADMINISTRADOR`:

1. **La cola de pendientes** (`GET /admin/professionals/licenses`): del más viejo al
   más nuevo, con nombre, especialidades, matrícula, mail y fecha de alta, y un link
   al registro público para verificarla.
2. **Validar o rechazar** (`PATCH /admin/professionals/:id/license`). Rechazar pide
   un motivo de al menos 10 caracteres, que le llega al profesional por mail.

Lo que antes cuidaba el SQL a mano ahora lo hace el backend:

- La decisión va por `profile_id` y **solo sobre un pendiente**: un `updateMany`
  condicionado al estado es el árbitro, así que si dos administradores deciden a la
  vez, uno gana y el otro recibe 409. Nunca se da vuelta una decisión ya tomada.
- Queda en `audit_logs` (`PROFESSIONAL_LICENSE_VALIDATED` o `…_REJECTED`) con el
  administrador, el motivo y `origin: 'ADMINISTRADOR'`. La validación automática de
  ENG-218 se va a sumar con otro origen, y este panel queda como respaldo de lo que
  no pueda resolver.
- `updated_at` se actualiza en la misma escritura.

**Si el panel no está disponible**, el respaldo sigue siendo el SQL Editor de
Supabase, con la misma regla: por `profile_id` y `and status =
'PENDIENTE_VALIDACION_MATRICULA'` (la matrícula no es única: dos colegios pueden
emitir el mismo número), y confirmando que cambió **una** fila. Así no queda
auditado ni se avisa por mail, así que es solo para emergencias.

#### Verificación

- Registrar un profesional nuevo y confirmar que aparece en la cola de pendientes del
  panel.
- Validarlo desde el panel y confirmar que `GET /professionals/me` devuelve
  `status: "VALIDADO"`.
- Confirmar que recién ahí aparece en el catálogo público (`GET /catalog/professionals`,
  ENG-49) y que su perfil público responde (`GET /professionals/:id`, ENG-50). Antes
  de aprobar, las dos cosas lo ignoran: los dos caminos filtran por
  `status = 'VALIDADO'`.
- Rechazar a otro profesional con un motivo y confirmar que **no** aparece en el
  catálogo y que le llega el mail con el motivo.

#### Antecedente

Verificado el 13/08/2026: los 2 profesionales que había en la base estaban los dos
en `PENDIENTE_VALIDACION_MATRICULA`. Se los pasó a `VALIDADO` a mano para desbloquear
ENG-49 — un parche puntual, sin verificar ninguna matrícula contra ningún registro y
sin procedimiento detrás. Esta sección es lo que faltaba para que el próximo que se
registre no dependa de que alguien se acuerde.

## Cifrado del contenido clínico (ENG-216)

El contenido de cada entrada **nueva** de la historia clínica se guarda cifrado
(ADR-020, punto 8; probado antes en el spike ENG-239):

- **AES-256-GCM** con una **clave de datos (DEK) por paciente**, en
  `patient_data_keys`. La DEK está guardada **envuelta** (cifrada) con una **clave
  maestra (KEK)**: la base nunca tiene una DEK en claro.
- La KEK vive solo en la variable `DATA_ENCRYPTION_KEYS`: en Render (backend) y en
  el secret del repo con el mismo nombre (job de integridad). Nunca en el código, el
  repo, un log ni la base.
- El contenido queda en la columna como `{"$enc": "v1.<nonce>.<etiqueta>.<texto>"}`.
  El lugar del dato (tabla, id de la entrada, campo y paciente) va como AAD: un
  contenido cifrado copiado a otra fila no se descifra, y el job de integridad lo
  reporta como `CONTENT_TAMPERED`.
- **La cadena de hash se calcula sobre el contenido en claro.** Rotar la clave no la
  rompe, y el job de integridad descifra para verificarla.
- **Las entradas viejas quedan en claro** (versión 0): la HC es append-only y
  reescribirlas violaría esa regla. El backend lee los dos formatos.
- Sin la variable, el backend guarda en claro como antes y lo avisa en el log al
  arrancar. Con la variable mal formada, **no arranca**. Leer algo cifrado sin la
  clave falla: nunca se muestra el cifrado como si fuera el contenido.

### Archivos: documentos del paciente y adjuntos del chat

Con la variable cargada, los archivos **nuevos** también se guardan cifrados, con la
misma DEK del paciente (en el chat, la del paciente de la conversación):

- En Storage quedan como `<carpeta>/<uuid>.<ext>.enc`, en binario: `MCF1` + nonce +
  etiqueta + texto cifrado (32 bytes más que el original; por eso, con el cifrado
  prendido, el tope es 10 MB menos 32 bytes). El AAD es el bucket, el UUID del
  objeto y el paciente: un archivo copiado a otro nombre no se descifra.
- Se abren igual que antes para la web y el mobile: piden la URL de descarga y
  reciben un link de cinco minutos. Para un archivo cifrado, ese link es del
  backend (`GET /files?t=...`) y no de Storage: baja el objeto, lo descifra y lo
  manda con `Content-Security-Policy: default-src 'none'; sandbox` y `no-store`.
- El link (`t`) va cifrado y autenticado con una subclave de la KEK: no deja ver qué
  archivo ni de qué paciente es, no se puede cambiar y vence a los cinco minutos.
  Va por query porque el log de requests y Sentry descartan el query string.
- La autorización y el registro en `audit_logs` siguen donde estaban: al pedir la
  URL. Los archivos de antes, en claro, se siguen abriendo con la URL firmada de
  Storage.

### Prender el cifrado

1. En tu máquina: `pnpm run keys:generate` (o
   `node --import tsx scripts/generate-data-key.ts`). Imprime una línea
   `k1:<clave>`. **Es un secreto:** no se pega en chats, mails ni commits.
2. Guardar un respaldo fuera de Render, en un lugar al que accedan dos personas
   (por ejemplo, el gestor de contraseñas del equipo). **Sin la clave, lo cifrado
   no se puede leer nunca más.**
3. Cargarla en Render (backend → Environment) como `DATA_ENCRYPTION_KEYS`.
4. Cargar el mismo valor en GitHub (repo backend → Settings → Secrets and
   variables → Actions) como `DATA_ENCRYPTION_KEYS`. Sin esto, el job semanal de
   integridad termina en ERROR apenas haya una entrada cifrada.
5. Verificar en el log del deploy: `Cifrado del contenido clínico activo (clave
   maestra k1).`

### Rotar la clave maestra

1. `pnpm run keys:generate k2` y agregarla **al final** de la variable, en Render y
   en GitHub: `DATA_ENCRYPTION_KEYS=k1:<...>,k2:<...>`. Desde ese deploy, las DEK
   nuevas se envuelven con `k2` y las viejas se siguen abriendo con `k1`.
2. Re-envolver las DEK existentes (los datos no se tocan): dry run con
   `pnpm run keys:rotate` y, si da OK, `pnpm run keys:rotate -- --apply`.
3. Cuando el dry run diga `Nada para rotar`, sacar `k1` de la variable en los dos
   lugares.

## Seudonimización para la IA (ENG-215)

Antes de mandar una transcripción a un modelo de IA, `src/ai/pseudonymization/`
reemplaza todo lo que identifica a alguien por marcadores (`[PACIENTE]`,
`[PERSONA_1]`, `[DNI_1]`…) en tres capas, y después reidentifica la respuesta de
nuestro lado. La capa 3 (un modelo local de reconocimiento de entidades) vive en
`ai-pipeline/`, un proyecto aparte que corre en GitHub Actions y no se instala con
el backend (ADR-020, opción A). Qué se tapa, cómo se mide y sus límites: ver
`src/ai/pseudonymization/README.md`. El workflow `ai-pseudonymization.yml` la evalúa
con el modelo real en cada PR que la toca.

## Tareas periódicas (ENG-228)

Las tareas periódicas (liberar turnos sin pagar, recordatorios, cierre de accesos
al MediPass, cierre de turnos y pedidos de reseña) son endpoints
`POST /internal/jobs/<job>` protegidos con `JOBS_SECRET`. Los nombres y la
frecuencia de cada uno están en `src/jobs/jobs.config.ts`.

| Pieza | Qué hace |
| --- | --- |
| **pg_cron + pg_net** en Supabase (`scripts/scheduler/pg-cron.sql`) | Scheduler principal: dispara cada job cada 1 o 5 minutos. El secreto vive en Supabase Vault. |
| `.github/workflows/scheduled-jobs.yml` | Respaldo cada 30 minutos. El cron de GitHub no es confiable por sí solo (el 17/11 corrió 3 veces en el día). |
| `public.job_runs` | Una fila por corrida: estado, duración, resultado y error. Una sola corrida en curso por job. |
| `GET /internal/jobs/status` | Último OK de cada job; 503 si alguno está atrasado. |
| Sentry | Cada job que falla manda una excepción con el tag `job`. El monitor de Sentry Crons `mediconnect-scheduler` alerta si los recordatorios dejan de correr, que es la señal de que se cayó el scheduler entero. |
| `GET /health` | 200 solo si la base responde un `SELECT 1` en menos de 3 s; si no, 503. |

**El sueño de Render.** Render Free duerme el backend tras 15 minutos sin
requests y el primer request tarda 30-50 s en despertarlo. Como pg_cron llama al
backend cada minuto, el servicio no se duerme y no hay arranques en frío en pagos
ni webhooks. Encendido todo el mes usa como máximo 744 h, dentro de las 750 h
gratis del workspace (la web es un sitio estático y no consume horas). Si se
suma otro web service gratis al workspace, deja de alcanzar: ahí conviene el plan
pago de Render para el backend.

**Puesta en marcha en un entorno nuevo:** crear los dos secretos en Vault y
correr `scripts/scheduler/pg-cron.sql` en el SQL Editor de Supabase (las
instrucciones y las consultas de verificación están en el mismo archivo).

## Tests de integración (PostgreSQL 15 via Docker)

La suite de integración corre contra un PostgreSQL 15 real (base **separada** de la
de desarrollo, para no tocar tus datos). La provee
[`docker-compose.yml`](./docker-compose.yml) (servicio `postgres-test`, puerto
`5433`) localmente, y un contenedor `services:` de GitHub Actions en CI — ambos
los maneja [`scripts/test-integration.sh`](./scripts/test-integration.sh), que
aplica el esquema con `prisma db push` antes de correr los tests.

Los archivos de esta suite usan el sufijo `*.integration.spec.ts` (ver
[`test/jest-integration.json`](./test/jest-integration.json)), separado de los
unit tests (`pnpm run test`) y los e2e (`pnpm run test:e2e`).

### Desde el host (recomendado)

```bash
# arranca la BD de test (postgres:15, healthcheck vía pg_isready)
$ pnpm run db:test:up

# aplica el esquema y corre la suite de integración
$ pnpm run test:integration

# frena la BD de test (conserva el volumen)
$ pnpm run db:test:down

# frena la BD de test y borra su volumen
$ pnpm run db:test:reset
```

`test:integration` arranca la BD sola si no está corriendo, así que `db:test:up`
es opcional. Por defecto apunta a `localhost:5433/mediconnect_test`.

### Dentro del Dev Container

El devcontainer levanta la BD de **desarrollo** (`db`, base `mediconnect`) y corre
migraciones + seed automáticamente (ver [`post-create.sh`](./.devcontainer/post-create.sh)).
Su `DATABASE_URL` apunta a esa BD de dev, **no** a la de test. Para correr la suite
de integración dentro del contenedor, apuntá explícito a `postgres-test` y evitá que
el script intente `docker compose` (no hay Docker CLI adentro):

```bash
$ DATABASE_URL="postgresql://mediconnect:mediconnect@postgres-test:5432/mediconnect_test?schema=public" \
    SKIP_DOCKER=true pnpm run test:integration
```

### Variables de entorno

Los defaults de la BD de test (ver [`docker-compose.yml`](./docker-compose.yml) y
[`scripts/test-integration.sh`](./scripts/test-integration.sh)) funcionan sin
configurar nada. Para sobreescribirlos, poné en tu `.env` (ver
[`.env.example`](./.env.example)): `POSTGRES_TEST_USER`, `POSTGRES_TEST_PASSWORD`,
`POSTGRES_TEST_DB` (default `mediconnect_test`), `POSTGRES_TEST_PORT` (default
`5433`). En CI (ver
[`.github/workflows/integration-tests.yml`](./.github/workflows/integration-tests.yml)),
Postgres 15 corre como contenedor `services:` y `DATABASE_URL` apunta a él.

## Deployment

El deploy lo dispara [`deploy-production.yml`](./.github/workflows/deploy-production.yml):
cuando el workflow **CI** pasa sobre `main`, llamamos al deploy hook de Render
(Auto-Deploy = No, para que el gate lo controle CI).

**El esquema y los datos base se aplican en el propio workflow**, con
`pnpm run db:setup` (`prisma migrate deploy && pnpm run db:seed`), justo antes de
llamar al hook. Si eso falla, el hook no se dispara: la versión vieja sigue
arriba y no queda una release corriendo contra un esquema a medio migrar.

> **El Pre-Deploy Command de Render tiene que quedar VACÍO.** Si se configura, el
> esquema se aplica desde dos lados.

Va `db:setup` (migraciones **+ seed**) y no solo `db:migrate` por ENG-96: el seed
corría solo en local y el catálogo de especialidades quedó vacío en Supabase por
meses. Las dos partes son idempotentes (`migrate deploy` no hace nada si no hay
pendientes; el seed hace `upsert` por nombre), así que correrlas en cada release
no tiene costo.

### Por qué no va en el pre-deploy de Render (ENG-122)

Hasta agosto de 2026 esto vivía —en el papel— en el Pre-Deploy Command de Render,
con el argumento de que el runner de GitHub no tuviera que ver la connection
string de producción. **Nunca corrió, y no podía correr: el Pre-Deploy Command es
una función de los planes pagos y el servicio está en el tier gratuito.** El campo
estuvo vacío desde siempre.

O sea que durante meses el README describió un mecanismo que no existía, y todo
lo que llegó al esquema de producción se aplicó a mano sin que quedara registro.
Se descubrió al mergear ENG-85: el deploy salió en verde y `chain_head_snapshots`
no existía en Supabase. Antes había pasado lo mismo con el seed en ENG-96, y el
catálogo de especialidades quedó vacío por meses.

La lección no es "configurarlo bien". Es que un paso del que se depende no puede
vivir en un dashboard, fuera del repo, sin log y sin nada que avise cuando no
corre — ahí ni siquiera se puede notar que no existe.

El costo es tener `DATABASE_URL` de producción como secret del repo. Ese límite ya
se había cruzado en ENG-85 (el job de integridad tiene que leer la base real) y
Actions enmascara los secrets en los logs.

### Cuidado al escribir una migración

El esquema se aplica **antes** de que Render levante el código nuevo, así que
durante unos minutos la versión vieja corre contra el esquema nuevo. Las
migraciones tienen que ser compatibles hacia atrás (expand/contract): agregar
tablas y columnas es seguro; borrar o renombrar algo que el código vigente usa
rompe producción en esa ventana y hay que partirlo en dos releases.

### Si una migración falla en el deploy

Queda marcada como fallida en `_prisma_migrations` y **bloquea los deploys
siguientes** hasta que se resuelva. Para intervenir a mano, con la connection
string del Session pooler:

```bash
read -rsp "password: " PGPASS && echo
export DATABASE_URL="postgresql://postgres.<project-ref>:${PGPASS}@aws-1-sa-east-1.pooler.supabase.com:5432/postgres?schema=public"

pnpm exec prisma migrate status      # qué quedó pendiente o fallida
pnpm run db:migrate                  # reintentar
```

Si la migración fallida quedó a medias hay que decidir explícitamente qué pasó
con ella antes de reintentar:

```bash
# se aplicó de verdad pero Prisma no lo registró
pnpm exec prisma migrate resolve --applied <nombre_migracion>

# no llegó a aplicar nada: se descarta para poder reintentar
pnpm exec prisma migrate resolve --rolled-back <nombre_migracion>
```

`db:seed` usa `--env-file-if-exists=.env`, así que funciona igual en local (lee
tu `.env`) y en el runner (no hay archivo; `DATABASE_URL` viene del secret).

## Modelo de datos

Especificación completa en `mediconnect-docs/modelo-de-datos/` (`esquema.md`, `der.md`).
