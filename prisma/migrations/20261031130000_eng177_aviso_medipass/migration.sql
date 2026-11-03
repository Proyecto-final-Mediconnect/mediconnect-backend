-- ENG-177: aviso in-app al paciente cada vez que alguien abre su MediPass.
-- Solo un valor nuevo del enum; el aviso usa la tabla `notifications` de ENG-69.
alter type "notification_type" add value if not exists 'MEDIPASS_ACCESO';
