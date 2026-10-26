-- ENG-70: "Borrar chat" lo oculta solo para quien lo borra.
--
-- Un chat entre paciente y profesional puede tener indicaciones médicas, así
-- que borrarlo no puede borrárselo también a la otra persona. Cada lado tiene
-- su marca: con ella puesta, la conversación no aparece en su bandeja. Los
-- mensajes no se tocan, y un mensaje nuevo (de cualquiera de los dos) limpia las
-- dos marcas, así el chat vuelve a aparecer para quien lo había ocultado.
--
-- Un chat sin mensajes sí se borra de verdad: no hay nada que conservar.
ALTER TABLE "conversations"
  ADD COLUMN "patient_hidden_at" TIMESTAMPTZ(6),
  ADD COLUMN "professional_hidden_at" TIMESTAMPTZ(6);
