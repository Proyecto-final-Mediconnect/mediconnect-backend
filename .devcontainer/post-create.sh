#!/usr/bin/env bash
# Se corre una vez al crear el devcontainer. Deja el backend listo para trabajar:
# dependencias, cliente de Prisma, esquema aplicado a la BD del compose y seed.
set -euo pipefail

corepack enable
corepack prepare pnpm@10 --activate

pnpm install

# .env local (idempotente). Apunta al Postgres del docker-compose (host "db").
if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝 .env creado desde .env.example"
fi

pnpm prisma generate
pnpm prisma migrate deploy   # aplica TODAS las migraciones sobre la BD ya bootstrapeada
pnpm run db:seed             # carga el catálogo base (especialidades)

echo "✅ Backend listo."
echo "   BD local: localhost:5432  ·  DBeaver → user=postgres pass=postgres db=mediconnect"
