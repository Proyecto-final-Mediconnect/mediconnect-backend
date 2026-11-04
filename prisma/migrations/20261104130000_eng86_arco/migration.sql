-- EP-01 · Derechos ARCO de la Ley 25.326 (ENG-86)
--
-- deleted_at: la baja de la cuenta (supresión) anonimiza el perfil en lugar de
-- borrar la fila. La historia clínica se conserva 10 años (Ley 26.529 art. 18) y
-- legal_acceptances es append-only con FK RESTRICT (decisión D1): borrar el
-- perfil no es posible ni correcto.
--
-- email_reminders: oposición a los recordatorios por email (art. 27). La
-- confirmación del turno sigue saliendo: es parte del servicio contratado.

ALTER TABLE "profiles" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "profiles" ADD COLUMN "email_reminders" BOOLEAN NOT NULL DEFAULT true;
