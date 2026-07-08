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

if [ "${SKIP_DOCKER:-}" != "true" ]; then
  docker compose up -d --wait postgres-test
fi

pnpm exec prisma db push --accept-data-loss
pnpm exec jest --config ./test/jest-integration.json --runInBand "$@"
