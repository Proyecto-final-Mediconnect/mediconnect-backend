#!/usr/bin/env bash
# Se corre una vez al crear el devcontainer. Deja el backend listo para trabajar:
# dependencias, cliente de Prisma, esquema aplicado a la BD del compose y seed.
set -euo pipefail

# La imagen typescript-node ya trae pnpm en el PATH. No usamos corepack: como
# usuario `node` no puede symlinkear en /usr/local/bin (EACCES) y, además, el
# pnpm de la imagen tapa al shim de corepack, con lo que el pin no aplicaría.
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
