-- EP-09 · Tarjeta de emergencia del MediPass (ENG-176)
--
-- El código rotativo solo se ve en la pantalla del paciente. Si el paciente
-- está inconsciente o sin el celular, nadie puede abrir su ficha, que es el
-- caso que más sentido le da al MediPass (Estudio Inicial §2.5). La tarjeta es
-- un QR fijo que el paciente imprime o guarda: canjearla abre una sesión de 30
-- minutos como el código, con el mismo rate limit, la misma bitácora y el mismo
-- aviso al paciente.
--
-- Las líneas `--;;` marcan el corte entre sentencias para los tests de
-- integración, igual que en las demás migraciones.

-- CreateTable
--;;
CREATE TABLE "medipass_emergency_cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    -- SHA-256 en hex del token. El token tiene 256 bits de azar, así que un
    -- hash rápido alcanza: no hay diccionario contra el cual probar.
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "medipass_emergency_cards_pkey" PRIMARY KEY ("id")
);

-- Lo que se guarda tiene forma de SHA-256 en hex: un token en claro guardado
-- por error no pasa.
--;;
ALTER TABLE "medipass_emergency_cards" ADD CONSTRAINT "medipass_emergency_cards_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

-- CreateIndex
--;;
CREATE UNIQUE INDEX "medipass_emergency_cards_token_hash_key" ON "medipass_emergency_cards"("token_hash");
--;;
CREATE INDEX "medipass_emergency_cards_patient_id_created_at_idx" ON "medipass_emergency_cards"("patient_id", "created_at" DESC);
-- Una sola tarjeta activa por paciente. Dos regeneraciones simultáneas no
-- pueden dejar dos QR válidos: la segunda choca acá y el backend contesta 409.
-- Prisma no modela índices parciales: no lo borres al regenerar el schema.
--;;
CREATE UNIQUE INDEX "medipass_emergency_cards_one_active_per_patient" ON "medipass_emergency_cards"("patient_id") WHERE "revoked_at" IS NULL;

-- AddForeignKey
-- CASCADE como `medipass_codes`: la tarjeta es una credencial del paciente, no
-- un registro clínico.
--;;
ALTER TABLE "medipass_emergency_cards" ADD CONSTRAINT "medipass_emergency_cards_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Una sesión entra por el código o por la tarjeta, nunca por los dos
-- ---------------------------------------------------------------------------
--;;
ALTER TABLE "medipass_sessions" ALTER COLUMN "medipass_code_id" DROP NOT NULL;
--;;
ALTER TABLE "medipass_sessions" ADD COLUMN "emergency_card_id" UUID;
--;;
ALTER TABLE "medipass_sessions" ADD CONSTRAINT "medipass_sessions_emergency_card_id_fkey" FOREIGN KEY ("emergency_card_id") REFERENCES "medipass_emergency_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
--;;
ALTER TABLE "medipass_sessions" ADD CONSTRAINT "medipass_sessions_origin_check" CHECK (num_nonnulls("medipass_code_id", "emergency_card_id") = 1);
-- Para cortar de una los accesos abiertos con una tarjeta al regenerarla.
--;;
CREATE INDEX "medipass_sessions_emergency_card_id_idx" ON "medipass_sessions"("emergency_card_id") WHERE "emergency_card_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Nada por PostgREST
-- ---------------------------------------------------------------------------
-- La lee y la escribe solo el backend, por Prisma. RLS activa sin políticas,
-- como `legal_acceptances` y `patient_documents`.
--;;
alter table public.medipass_emergency_cards enable row level security;
--;;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.medipass_emergency_cards from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.medipass_emergency_cards from authenticated;
  end if;
end $$;
