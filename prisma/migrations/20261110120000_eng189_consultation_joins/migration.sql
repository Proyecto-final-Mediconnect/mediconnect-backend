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

alter table public.consultations
  add column if not exists patient_joined_at timestamptz,
  add column if not exists professional_joined_at timestamptz;
