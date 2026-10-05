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

> **No hay pantalla de moderación, y es deliberado.** El sistema tiene el rol
> `MODERADOR` en el enum `user_role`, pero construir la pantalla es alcance nuevo:
> no está en las 48 historias del backlog y contradice la decisión del Sprint 0 de
> que en el MVP la validación sea manual. Si en algún momento el volumen lo pide, la
> pantalla entra como historia propia y con su release asignado — no como un agregado
> de este procedimiento.

#### Quién valida

**Responsable: Juan Cruz García Amadey.** Ocupa operativamente el rol `MODERADOR`,
que hasta ENG-109 existía en el enum sin que nadie lo ejerciera para validar
matrículas (la web tiene `/moderacion`, pero es el placeholder de la moderación de
reseñas de ENG-81, no de esto). Es también el
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

Se corre con el **SQL Editor de Supabase** (Dashboard → SQL Editor) con una cuenta
del equipo con acceso al proyecto. No hay endpoint ni script: son tres consultas y
dejarlas a mano evita construir un camino de escritura sobre `professionals.status`
que hoy nadie más necesita.

**1. Listar las pendientes.** Es el disparador del procedimiento:

```sql
select profile_id, first_name, last_name, license_number, created_at
from public.professionals
where status = 'PENDIENTE_VALIDACION_MATRICULA'
order by created_at;
```

**2. Aprobar**, una vez verificada la matrícula en el registro del colegio:

```sql
update public.professionals
set status = 'VALIDADO', updated_at = now()
where profile_id = '<profile_id de la consulta 1>'
  and status = 'PENDIENTE_VALIDACION_MATRICULA';
```

**3. Rechazar**, si la matrícula no existe, está vencida o el nombre no coincide:

```sql
update public.professionals
set status = 'RECHAZADO', updated_at = now()
where profile_id = '<profile_id de la consulta 1>'
  and status = 'PENDIENTE_VALIDACION_MATRICULA';
```

Las dos escrituras van acotadas por `profile_id`, copiado de la consulta 1, y no por
`license_number`: la matrícula **no tiene unique** (`varchar(30)`) y dos colegios
provinciales pueden emitir el mismo número, así que un `where` por matrícula puede
validar de un saque a alguien que nadie miró — y "confirmar después que afectó una
fila" llega tarde, porque el `update` ya cambió las dos. Por la misma razón no se
filtra por especialidad ni por fecha.

El `and status = 'PENDIENTE_VALIDACION_MATRICULA'` evita pisar una decisión ya
tomada: si otro miembro del equipo la resolvió en el medio, el `update` afecta
**cero** filas en vez de dar vuelta un rechazo. El SQL Editor muestra cuántas filas
cambió: tiene que ser **una**.

`updated_at` se pone a mano porque la columna tiene `default now()` solo en el
INSERT: sin esto, la ficha queda diciendo que no se tocó desde el registro.

#### Verificación

- Registrar un profesional nuevo y confirmar que aparece en la consulta de pendientes.
- Aplicar el SQL de aprobación y confirmar que `GET /professionals/me` devuelve
  `status: "VALIDADO"`.
- Confirmar que recién ahí aparece en el catálogo público (`GET /catalog/professionals`,
  ENG-49) y que su perfil público responde (`GET /professionals/:id`, ENG-50). Antes
  de aprobar, las dos cosas lo ignoran: los dos caminos filtran por
  `status = 'VALIDADO'`.
- Aplicar el SQL de rechazo sobre otro profesional y confirmar que **no** aparece en
  el catálogo.

#### Antecedente

Verificado el 13/08/2026: los 2 profesionales que había en la base estaban los dos
en `PENDIENTE_VALIDACION_MATRICULA`. Se los pasó a `VALIDADO` a mano para desbloquear
ENG-49 — un parche puntual, sin verificar ninguna matrícula contra ningún registro y
sin procedimiento detrás. Esta sección es lo que faltaba para que el próximo que se
registre no dependa de que alguien se acuerde.

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
