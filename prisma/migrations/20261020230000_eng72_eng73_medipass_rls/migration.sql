-- ENG-72 / ENG-73: cerrar `medipass_codes` y `medipass_sessions` antes de ponerlas en uso.
--
-- Las tres tablas del MediPass se crearon con el esquema inicial (EP-02/EP-10) y
-- hasta ahora ninguna ruta las tocaba. `medipass_access_logs` ya quedó cerrada con
-- ENG-87: RLS habilitado y privilegios revocados a `authenticated`. Las otras dos
-- quedaron abiertas, y son las que guardan el código que abre la ficha de
-- emergencia de un paciente.
--
-- Esta migración las deja con la misma forma que ENG-87 le dio a la bitácora:
-- RLS habilitado y sin políticas, es decir **denegado por defecto** para
-- `authenticated` y `anon`. Todo el acceso pasa por el backend, que conecta con el
-- rol dueño de las tablas (al que RLS no se le aplica) y filtra por `patient_id`
-- en cada consulta. No hay ninguna ruta que necesite que el cliente lea estas
-- tablas directamente: el código se pide por `GET /medipass/me` y la sesión se
-- abre por `POST /medipass/sessions`, que es público a propósito y valida el
-- código del lado del servidor.
--
-- Por qué importa: la `anon key` de Supabase está en el bundle de la web, es
-- pública por diseño y no es un secreto. Sin RLS, cualquiera con esa clave podía
-- leer `medipass_codes` entero y abrir el MediPass de cualquier paciente sin
-- escanear nada. Es el mismo razonamiento de ENG-87 y de la validación de RLS de
-- ENG-37.
--
-- Cuando entre ENG-138 (que saca al backend del rol dueño y lo pasa a un rol de
-- aplicación sin BYPASSRLS), estas dos tablas van a necesitar o un GRANT
-- explícito a ese rol o políticas propias. Queda anotado en el ticket.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.medipass_codes from anon;
    revoke all on public.medipass_sessions from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.medipass_codes from authenticated;
    revoke all on public.medipass_sessions from authenticated;
  end if;
end $$;
--;;
alter table public.medipass_codes enable row level security;
--;;
alter table public.medipass_sessions enable row level security;
--;;
-- El código vigente se busca por `code` en cada canje (`POST /medipass/sessions`),
-- que es un endpoint público: sin índice es un scan secuencial sobre una tabla que
-- crece con cada rotación de cada paciente, y encima es la ruta que alguien
-- intentaría martillar.
create index if not exists "medipass_codes_code_expires_at_idx"
  on public.medipass_codes ("code", "expires_at");
--;;
-- El código vigente de un paciente se pide en cada carga de su pantalla.
create index if not exists "medipass_codes_patient_id_expires_at_idx"
  on public.medipass_codes ("patient_id", "expires_at");
