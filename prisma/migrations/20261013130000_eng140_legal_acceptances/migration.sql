-- EP-01 / EP-10 · Aceptación de términos, privacidad y consentimiento (ENG-140)
--
-- Los datos de salud son datos sensibles (Ley 25.326, arts. 2 y 7): tratarlos
-- exige el consentimiento expreso e informado del titular. Esta tabla es la
-- prueba de ese consentimiento: quién aceptó, qué versión de los textos y cuándo.
--
-- Además de lo mínimo, guarda desde dónde se aceptó: la IP real del cliente
-- (`CF-Connecting-IP`, ENG-84), el user-agent y el canal (`REGISTER` al crear la
-- cuenta, `REACCEPT` desde `POST /me/legal-acceptance`). Ante una disputa es lo
-- que permite reconstruir el contexto, y con la tabla append-only una fila que
-- no los tenga no los va a tener nunca. `ip` y `user_agent` son nullable: si no
-- se pueden determinar, la aceptación se guarda igual.
--
-- Las líneas `--;;` marcan el corte entre sentencias para los tests de
-- integración, igual que en las migraciones de ENG-57 y ENG-126.

-- CreateEnum
--;;
CREATE TYPE "legal_acceptance_source" AS ENUM ('REGISTER', 'REACCEPT');

-- CreateTable
--;;
CREATE TABLE "legal_acceptances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "version" VARCHAR(20) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "legal_acceptance_source" NOT NULL,
    "ip" INET,
    "user_agent" VARCHAR(512),

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--;;
CREATE UNIQUE INDEX "legal_acceptances_profile_id_version_key" ON "legal_acceptances"("profile_id", "version");

-- AddForeignKey
-- RESTRICT y no CASCADE: borrar el perfil no puede borrar la prueba de que
-- consintió. Mismo criterio que la HC. `audit_logs.actor_id` va por el mismo
-- lado, pero ojo: en `main` todavía es SET NULL (`20260708000000_ep02_ep10_schema`)
-- y lo pasa a RESTRICT ENG-87, en la PR backend #62.
--
-- Supresión de cuentas (Ley 25.326 art. 16). Consecuencia buscada de RESTRICT +
-- el trigger append-only: una cuenta con aceptación no se puede borrar, ni con
-- `auth.admin.deleteUser` (la cascada `auth.users -> profiles` choca con esta
-- FK). Eso incluye cuentas que nunca confirmaron el email, porque la aceptación
-- se guarda en el `signUp`. El procedimiento ante un pedido de supresión es:
--   1. Anonimizar el perfil: reemplazar email y datos personales de `profiles`,
--      `patients`/`professionals` por valores no identificatorios, y bloquear
--      el login en Supabase Auth (ban o cambio de email/contraseña aleatorios)
--      en lugar de borrar el usuario.
--   2. Conservar las filas de esta tabla: son la prueba de que el tratamiento
--      previo tuvo consentimiento (art. 16 inc. 5: la supresión no procede
--      cuando hay una obligación legal de conservar los datos).
-- Pendiente de decisión del equipo (review de la PR #63): si mantener esto o
-- guardar la aceptación recién al confirmar el email / primer login, para que
-- no queden filas indelebles de cuentas que nunca se usaron.
--;;
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Append-only
-- ---------------------------------------------------------------------------
-- Un consentimiento no se edita: si cambian los textos, se acepta una versión
-- nueva y queda otra fila. Mismo esquema que la HC (ENG-57 + ENG-126): trigger
-- por fila para UPDATE/DELETE, por statement para TRUNCATE, 42501, y
-- `security definer` con `search_path` fijo.
--;;
create or replace function legal_acceptances_block_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception
    'legal_acceptances es append-only: % no permitido. Un consentimiento nuevo es una fila nueva con otra versión.',
    tg_op
    using errcode = '42501';
end;
$$;
--;;
drop trigger if exists legal_acceptances_no_mutation on public.legal_acceptances;
--;;
create trigger legal_acceptances_no_mutation
  before update or delete on public.legal_acceptances
  for each row execute function legal_acceptances_block_mutation();
--;;
drop trigger if exists legal_acceptances_no_truncate on public.legal_acceptances;
--;;
create trigger legal_acceptances_no_truncate
  before truncate on public.legal_acceptances
  for each statement execute function legal_acceptances_block_mutation();

-- ---------------------------------------------------------------------------
-- Nada por PostgREST
-- ---------------------------------------------------------------------------
-- La escribe y la lee solo el backend, por Prisma. Se revoca lo que da el ALTER
-- DEFAULT PRIVILEGES de `public` y RLS queda activa sin políticas, como en ENG-85.
-- Guardado por existencia de rol: un Postgres pelado de CI no los tiene.
--;;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.legal_acceptances from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.legal_acceptances from authenticated;
  end if;
end $$;
--;;
alter table public.legal_acceptances enable row level security;
