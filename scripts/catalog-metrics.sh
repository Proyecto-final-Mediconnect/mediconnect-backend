#!/usr/bin/env bash
# ENG-49 — corre las métricas del catálogo contra la MISMA base descartable que
# los tests de integración (postgres-test, puerto 5433). Nunca contra Supabase:
# el script siembra cientos de profesionales de prueba.
set -euo pipefail

: "${DATABASE_URL:=postgresql://mediconnect:mediconnect@localhost:5433/mediconnect_test?schema=public}"
export DATABASE_URL

if [ "${SKIP_DOCKER:-}" != "true" ]; then
  docker compose up -d --wait postgres-test
fi

pnpm exec prisma db push --accept-data-loss --skip-generate
pnpm exec tsx scripts/catalog-metrics.ts
