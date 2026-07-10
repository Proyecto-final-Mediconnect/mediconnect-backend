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

## Modelo de datos

Especificación completa en `mediconnect-docs/modelo-de-datos/` (`esquema.md`, `der.md`).
