import type { ClinicalEntryContentDto } from './dto/clinical-entry-content.dto';

/**
 * Traducción del formulario de ENG-58 a un recurso **FHIR R5**.
 *
 * `clinical_record_entries.content` es JSONB y el Sprint 0 (ADR-013) decidió que
 * lo que va ahí es un recurso FHIR, no un blob propio. El motivo es el MediPass:
 * una historia clínica que se comparte fuera de MediConnect tiene que hablar un
 * idioma que el que la recibe entienda.
 *
 * **Es un subconjunto pragmático, no un perfil certificado.** Se usa
 * `ClinicalImpression` porque es el recurso de R5 que modela exactamente una
 * evaluación clínica en un momento dado —motivo, hallazgos, impresión
 * diagnóstica y plan— que es justo lo que pide el formulario. Un `Composition`
 * daría un documento más completo pero exige estructura de secciones y autoría
 * referenciada que hoy no tenemos dónde apoyar.
 *
 * Dos cosas deliberadas:
 *
 * - **Sin códigos SNOMED/ICD-10.** El formulario es texto libre estructurado, y
 *   poner un `coding` inventado sería peor que no ponerlo: un sistema receptor lo
 *   leería como si significara algo. La codificación llega cuando exista el
 *   buscador de términos, y el `text` de cada campo sobrevive intacto.
 * - **`subject` y `performer` son referencias por UUID interno.** No son
 *   identificadores federados todavía; el MediPass define ese esquema.
 *
 * La función es pura y está separada del service para poder testear el mapeo sin
 * base: lo que produce entra al hash, así que un cambio acá cambia el
 * `content_hash` de todo lo que se escriba después.
 */

/** Tipo de recurso FHIR que se guarda. Va también en la columna
 *  `fhir_resource_type`, para poder filtrar sin abrir el JSONB. */
export const CLINICAL_ENTRY_RESOURCE_TYPE = 'ClinicalImpression';

/**
 * URL de la extensión que lleva el motivo de la corrección (ENG-100).
 *
 * Es una **extensión** y no un campo del recurso porque R5 no modela "este
 * asiento corrige aquel otro". Lo más cercano que hay es `previous`, que sí se
 * usa —abajo— para el enlace, pero cuyo significado es "la evaluación anterior de
 * este paciente", no "la entrada equivocada". El porqué del error no tiene dónde
 * ir, y una extensión es el mecanismo que FHIR define exactamente para eso.
 *
 * Es un `urn:` y no una URL `https://` a propósito: la convención de FHIR pide
 * una URL resoluble donde esté publicada la definición de la extensión, y el
 * proyecto no tiene dominio ni servidor de perfiles. Inventar
 * `https://mediconnect.../StructureDefinition/...` sería declarar una dirección
 * que no responde. El día que exista el canonical base del MediPass, esto cambia
 * a esa URL — y hay que tener presente que **cambiarla cambia el
 * `content_hash`** de toda corrección escrita después, no de las anteriores.
 */
export const CORRECTION_REASON_EXTENSION =
  'urn:mediconnect:fhir:extension:correction-reason';

/** Datos de la corrección, cuando el asiento es una (ENG-100). */
export interface CorrectionContext {
  /** Entrada que este asiento corrige. */
  correctsEntryId: string;
  /** Qué estaba mal en la original. */
  reason: string;
}

/**
 * Arma el recurso a partir del formulario.
 *
 * El orden de las claves acá **no importa**: `canonicalJson` las ordena antes de
 * hashear, justamente para que el hash no dependa de cómo se construyó el objeto.
 *
 * `correction` solo viene desde ENG-100. Cuando falta, el recurso sale
 * **byte por byte** igual que antes de que esta rama existiera: los dos campos
 * que agrega la corrección se omiten en vez de ir en `null`, así que el
 * `content_hash` de un alta normal no cambió.
 */
export function toClinicalImpression(
  dto: ClinicalEntryContentDto,
  parties: { patientId: string; professionalId: string },
  effectiveAt: Date,
  correction?: CorrectionContext,
): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    resourceType: CLINICAL_ENTRY_RESOURCE_TYPE,
    // `completed`: la entrada se guarda ya cerrada. La tabla es append-only, así
    // que no existe el estado "en progreso" — no hay forma de volver a editarla.
    status: 'completed',
    subject: { reference: `Patient/${parties.patientId}` },
    performer: { reference: `Practitioner/${parties.professionalId}` },
    date: effectiveAt.toISOString(),
    // Motivo de consulta.
    description: dto.reason,
  };

  if (dto.findings) {
    // `summary` es el campo de R5 para la síntesis narrativa de la evaluación.
    resource.summary = dto.findings;
  }

  if (dto.diagnosis) {
    // `finding` es una lista: una evaluación puede arrojar más de una impresión.
    // Hoy el formulario captura una sola, y se guarda como lista igual para que
    // agregar la segunda no cambie la forma del recurso —y por lo tanto el hash—
    // de lo ya escrito.
    resource.finding = [{ item: { concept: { text: dto.diagnosis } } }];
  }

  if (dto.plan) {
    resource.note = [{ text: dto.plan }];
  }

  if (correction) {
    // `previous` es Reference(ClinicalImpression) y acá apunta a la entrada
    // corregida. Es el mismo UUID que `corrects_entry_id` en la fila: la columna
    // es la que usa MediConnect para armar la vista, y esto es para que el enlace
    // sobreviva al export FHIR, donde la columna no viaja.
    resource.previous = {
      reference: `${CLINICAL_ENTRY_RESOURCE_TYPE}/${correction.correctsEntryId}`,
    };
    resource.extension = [
      {
        url: CORRECTION_REASON_EXTENSION,
        valueString: correction.reason,
      },
    ];
  }

  return resource;
}
