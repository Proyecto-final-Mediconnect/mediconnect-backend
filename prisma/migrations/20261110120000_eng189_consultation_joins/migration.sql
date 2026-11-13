-- EP-03 · Quién entró a la sala de la videoconsulta (ENG-189)
--
-- La consulta se crea con el primero que entra (`started_at`), pero no queda
-- escrito quién fue ni si el otro llegó a entrar. Sin eso, el cierre
-- automático del turno no puede distinguir una consulta que ocurrió (entraron
-- los dos → COMPLETADO) de una a la que el paciente faltó (solo el
-- profesional → NO_ASISTIO).
--
-- Cada columna guarda la PRIMERA entrada de ese rol: reconectarse no la pisa.
-- Solo agrega columnas nullable, así que es compatible con el código vigente
-- durante el deploy (expand/contract).
--
-- Sin backfill, a propósito: de las consultas anteriores no se sabe quién
-- entró, y completar las columnas a ciegas podría marcar "no asistió" a quien
-- sí estuvo. Quedan con las dos en NULL, así que el job no las cierra y hay que
-- cerrarlas a mano si hace falta. Al 13/11 son 4 turnos CONFIRMADO de prueba,
-- de septiembre y octubre (review de #113).

alter table public.consultations
  add column if not exists patient_joined_at timestamptz,
  add column if not exists professional_joined_at timestamptz;
