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

## Modelo de datos

Especificación completa en `mediconnect-docs/modelo-de-datos/` (`esquema.md`, `der.md`).
