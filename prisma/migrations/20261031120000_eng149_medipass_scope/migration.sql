-- ENG-149: qué bloques del MediPass ve un consultante externo.
--
-- Un `jsonb` con un booleano por bloque (`grupoSanguineo`, `alergias`,
-- `medicacion`, `condiciones`, `contacto`). `null` es "nunca lo configuró" y
-- vale el default: **todo visible**. En una emergencia lo que salva una vida es
-- la información, así que el paciente apaga lo que no quiere mostrar en vez de
-- tener que acordarse de prender cada bloque.
--
-- Va en `patients` y no en una tabla aparte porque es una preferencia del
-- paciente, uno a uno con su fila; las políticas RLS de identidad que ya
-- existen sobre `patients` (`patients_select_own` / `patients_update_own`)
-- alcanzan. El backend lo escribe con Prisma filtrando por el `profile_id` del
-- JWT, y lo lee al armar la ficha del consultante.
alter table public.patients
  add column if not exists "medipass_scope" jsonb;
