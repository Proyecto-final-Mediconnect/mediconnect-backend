import type { CreateClinicalEntryDto } from './dto/create-clinical-entry.dto';

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
 * Arma el recurso a partir del formulario.
 *
 * El orden de las claves acá **no importa**: `canonicalJson` las ordena antes de
 * hashear, justamente para que el hash no dependa de cómo se construyó el objeto.
 */
export function toClinicalImpression(
  dto: CreateClinicalEntryDto,
  parties: { patientId: string; professionalId: string },
  effectiveAt: Date,
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

  return resource;
}
