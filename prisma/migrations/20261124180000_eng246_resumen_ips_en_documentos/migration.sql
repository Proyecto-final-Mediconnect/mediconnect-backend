-- ENG-246 (ADR-022): el resumen de salud IPS que trae el paciente se guarda como
-- un documento más de los que aporta (ENG-164), en el mismo bucket privado, con
-- el mismo cifrado, cuota, auditoría y permisos. Lo único que cambia es que el
-- bucket acepte su tipo, `application/fhir+json`.
--
-- No toca datos ni políticas: solo suma un valor a `allowed_mime_types`. El
-- backend valida el archivo antes de subirlo (que sea un resumen IPS, hasta 1 MB
-- y del mismo DNI que el paciente).
--
-- Como en ENG-164, el schema `storage` no existe en el Postgres local: el bloque
-- se saltea y el DDL va por `execute` para que ni se parsee.
do $do$
begin
  if to_regclass('storage.objects') is null then
    raise notice
      'ENG-246: schema "storage" ausente (Postgres local) — se saltea el bucket de documentos';
    return;
  end if;

  execute $sql$
    update storage.buckets
       set allowed_mime_types =
             array['application/pdf', 'image/jpeg', 'image/png', 'application/fhir+json']
     where id = 'patient-documents'
  $sql$;
end
$do$;
