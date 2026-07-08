-- ===========================================================================
-- BOOTSTRAP DEL POSTGRES LOCAL  ("el dump" del que hablamos)
-- ===========================================================================
-- Postgres corre este archivo UNA sola vez, al inicializar el volumen vacío
-- (montado en /docker-entrypoint-initdb.d). Recrea localmente las piezas que en
-- PRODUCCIÓN provee Supabase y de las que dependen nuestras migraciones:
--
--   * extensiones (pg_trgm para búsqueda fuzzy, pgcrypto para hash SHA-256, citext)
--   * los roles de Postgres que usa la RLS: anon / authenticated / service_role
--   * el schema `auth` con una tabla `auth.users` mínima (el trigger de alta de
--     perfil de EP-01 dispara AFTER INSERT sobre ella)
--   * las funciones `auth.uid()` / `auth.role()` / `auth.jwt()` con la MISMA
--     semántica que Supabase (leen el claim publicado en `request.jwt.claims`)
--
-- Con esto, las mismas migraciones de Prisma que corren contra Supabase en prod
-- aplican sin cambios contra este Postgres local. En prod NO se usa este archivo:
-- Supabase ya trae todo esto.

-- --- Extensiones -----------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest() (SHA-256 de la HC)
CREATE EXTENSION IF NOT EXISTS citext;     -- emails case-insensitive
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- índice GIN de búsqueda del catálogo

-- --- Roles que Supabase crea por nosotros ----------------------------------
-- La RLS y los GRANT de las migraciones apuntan a estos roles. Son NOLOGIN:
-- el backend entra como `postgres` y hace `SET ROLE authenticated` por request.
DO $$ BEGIN CREATE ROLE anon NOLOGIN NOINHERIT;          EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Que el superusuario `postgres` pueda adoptar esos roles (SET ROLE ...).
GRANT anon, authenticated, service_role TO postgres;

-- --- Schema auth (gestionado por Supabase en prod) -------------------------
CREATE SCHEMA IF NOT EXISTS auth;

-- Tabla mínima: solo las columnas que lee el trigger handle_new_user de EP-01.
CREATE TABLE IF NOT EXISTS auth.users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT UNIQUE,
  raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
  email_confirmed_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Helpers auth.* con la semántica de Supabase ---------------------------
-- El backend publica el JWT como setting de sesión:
--   SELECT set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true);
-- y estas funciones lo leen (idéntico a Supabase). Ver scripts/verify-rls.ts.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(auth.jwt() ->> 'role', 'anon');
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
