#!/usr/bin/env bash
# Runs the integration test suite against a real PostgreSQL 15 instance.
#
# Locally: starts the postgres-test service from docker-compose.yml (unless
# SKIP_DOCKER=true), applies the Prisma schema, then runs the integration
# Jest suite.
#
# In CI: PostgreSQL is provided as a GitHub Actions `services:` container, so
# the workflow sets SKIP_DOCKER=true and DATABASE_URL to point at it.
set -euo pipefail

: "${DATABASE_URL:=postgresql://mediconnect:mediconnect@localhost:5433/mediconnect_test?schema=public}"
export DATABASE_URL

# `db push --accept-data-loss` y los specs reescriben la base: nunca contra una
# que no sea local (ver test/integration-db-guard.ts).
# Se valida el hostname parseado, no un patrón de texto (una query con
# `@localhost:` en la URL no debe pasar).
if ! node -e 'process.exit(["localhost","127.0.0.1","::1","[::1]"].includes(new URL(process.env.DATABASE_URL).hostname)?0:1)' 2>/dev/null; then
  echo "DATABASE_URL no es local; abortando." >&2
  exit 1
fi

if [ "${SKIP_DOCKER:-}" != "true" ]; then
  docker compose up -d --wait postgres-test
fi

pnpm exec prisma db push --accept-data-loss
pnpm exec jest --config ./test/jest-integration.json --runInBand "$@"
