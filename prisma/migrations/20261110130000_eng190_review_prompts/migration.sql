-- EP-02 · Pedir la reseña al terminar la consulta (ENG-190)
--
-- 1. `review_prompt_dismissals`: el paciente descartó la tarjeta "¿Cómo fue tu
--    consulta?" de un turno. Se guarda en la base y no en el dispositivo para
--    que, descartada en la web, tampoco vuelva en la app, y para que el mail
--    del job no salga si ya dijo que no.
-- 2. `RESENA_PEDIDA`: el mail que pide la reseña. La fila en `notifications`
--    con la unicidad (appointment_id, type, channel) es lo que garantiza que
--    salga uno solo por turno, igual que los recordatorios (ENG-68).

alter type "notification_type" add value if not exists 'RESENA_PEDIDA';

create table "review_prompt_dismissals" (
    "id" uuid not null default gen_random_uuid(),
    "patient_id" uuid not null,
    "appointment_id" uuid not null,
    "created_at" timestamptz(6) not null default now(),

    constraint "review_prompt_dismissals_pkey" primary key ("id")
);

create unique index "review_prompt_dismissals_appointment_key"
  on "review_prompt_dismissals"("appointment_id");
create index "review_prompt_dismissals_patient_idx"
  on "review_prompt_dismissals"("patient_id");

alter table "review_prompt_dismissals"
  add constraint "review_prompt_dismissals_patient_id_fkey"
  foreign key ("patient_id") references "profiles"("id")
  on delete cascade on update cascade;
alter table "review_prompt_dismissals"
  add constraint "review_prompt_dismissals_appointment_id_fkey"
  foreign key ("appointment_id") references "appointments"("id")
  on delete cascade on update cascade;

-- Solo la escribe y la lee el backend (Prisma). Mismo patrón que `push_tokens`
-- (ENG-71) y `notifications` (ENG-68): RLS prendido sin políticas y sin GRANTs
-- para los roles de PostgREST, así que por la API pública no se ve ni se toca.
-- El rol del backend (ENG-138) tiene BYPASSRLS. El bloque chequea que los roles
-- existan para que la migración corra igual en el Postgres pelado del CI.
alter table public.review_prompt_dismissals enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.review_prompt_dismissals from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.review_prompt_dismissals from authenticated';
  end if;
end
$$;
