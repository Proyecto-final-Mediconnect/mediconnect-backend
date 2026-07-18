# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Security
- Prevent privilege escalation at signup: `handle_new_user` now clamps the role
  from client-controlled `raw_user_meta_data` to non-privileged roles
  (PACIENTE / PROFESIONAL); MODERADOR can only be assigned by service_role (ENG-37)
- FORCE ROW LEVEL SECURITY on profiles/patients/professionals as defense in depth,
  mirrored in the Supabase migrations (ENG-37)

### Added
- RLS verification script now checks the signup role clamp and asserts the exact
  RLS/trigger error on negative cases to avoid false positives (ENG-37)
- `JwtAuthGuard`: verifies Supabase JWTs locally against the project's JWKS
  (ES256 allowlisted, `authenticated` audience, issuer and expiration all
  checked, no shared secret), reading the token from the `Authorization`
  header or the `sb-access-token` cookie, rejecting tokens without a `sub`,
  and attaches the authenticated user to the request. JWKS infra failures
  (timeout/network) surface as 503 instead of being mistaken for an invalid
  token (401) (ENG-92)
- Environment variable validation on startup (`DATABASE_URL`, `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`) so misconfiguration fails fast with a clear error (ENG-92)
- `GET /auth/me` (protected by `JwtAuthGuard`, returns the authenticated user)
  and `POST /auth/logout` (clears the session cookies) so the frontend has a
  concrete way to exercise the guard end-to-end (ENG-92)
- `RequestLoggerMiddleware`: logs method, path, status code, duration and the
  authenticated user id (never body/headers/cookies/tokens) for every request
  except `GET /health` (ENG-92)
- `POST /auth/refresh`: exchanges the `sb-refresh-token` cookie for a new
  access/refresh token pair via Supabase, re-setting both cookies. Invalid,
  expired or reused refresh tokens clear the session cookies and respond
  401; a Supabase rate limit responds 503 without touching the cookies
  (ENG-92)

## 1.0.0 - 2026-07-06

### Added
- Patient registration and login with email verification (ENG-42)
- Professional registration with license number pending manual validation (ENG-43)
- Docker Compose setup with PostgreSQL 15 for local integration tests (ENG-39)
- GitHub Actions workflow running integration tests against a service container (ENG-39)
- Automatic Prisma schema sync before each integration suite (ENG-39)

### Changed
- Prisma client generator switched to prisma-client-js for CommonJS compatibility (ENG-39)