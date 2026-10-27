-- ENG-134: los campos vitales del paciente.
--
-- `patients` tenía nombre, apellido, fecha de nacimiento, DNI, teléfono y un
-- `address` que ningún flujo escribe. Ninguno es clínico, y son justo los que el
-- MediPass existe para mostrar: hasta ahora `GET /medipass/me/vital` (ENG-103)
-- devolvía el nombre y la edad, y todo el resto en `null` a propósito, esperando
-- esta migración. Con estas seis columnas el bloque vital pasa a decir algo, y
-- se desbloquea ENG-136 (el formulario para que el paciente los cargue).
--
-- ## Por qué jsonb y no tablas propias
--
-- Alergias, medicación y condiciones son listas de objetos, y lo normalizado
-- serían tres tablas con sus FKs, sus índices y su CRUD. Se eligió `jsonb` a
-- conciencia, y el ticket lo dice: es un atajo para llegar a la fecha. Se puede
-- defender por lo que el dominio necesita hoy —se leen y se escriben siempre
-- completas, como un bloque; nunca se filtra ni se agrega por una alergia
-- suelta— pero **es deuda técnica reconocida**, y si en algún momento hay que
-- buscar "todos los pacientes alérgicos a X", esto se normaliza.
--
-- La forma de cada columna la fija el tipo `VitalBlock` que la web ya consume en
-- producción (`mediconnect-web/src/features/medipass/types/medipass.ts`), así
-- que las claves van en español: `{ que, gravedad }`, `{ droga, dosis, nota }`,
-- `{ nombre, codigo }`, `{ nombre, vinculo, telefono }`.
--
-- **No hay CHECK sobre la forma del jsonb.** Postgres puede validar que sea JSON
-- válido pero no que tenga las claves correctas sin un CHECK largo y frágil, y
-- el que lo escribe es el DTO de la API. Lo que sí se hace es leerlo a la
-- defensiva: `toVitalBlock` descarta las entradas malformadas en vez de
-- confiar en la base, porque una fila mal cargada no puede romper la ficha de
-- emergencia de alguien en una guardia.
--
-- ## Son datos sensibles
--
-- Grupo sanguíneo, alergias, medicación y condiciones son datos de salud: dato
-- sensible de la Ley 25.326, con régimen especial. Entran en el alcance del
-- consentimiento de ENG-140 —que `JwtAuthGuard` ya exige en las rutas del
-- paciente— y las políticas RLS `patients_select_own` / `patients_update_own`
-- que ya existen sobre `patients` siguen valiendo tal cual: cada paciente solo
-- ve y escribe su propia fila. No hace falta tocarlas.
--
-- Todas las columnas son nullable: un paciente que no cargó nada es el estado
-- normal, no un error, y la pantalla omite lo que falta en vez de mostrar
-- huecos.

alter table public.patients
  add column if not exists "sex" varchar(30),
  add column if not exists "blood_type" varchar(3),
  add column if not exists "allergies" jsonb,
  add column if not exists "medications" jsonb,
  add column if not exists "conditions" jsonb,
  add column if not exists "emergency_contact" jsonb;
