/**
 * El bloque vital del MediPass (HU-32, ENG-103).
 *
 * Es lo único que ve un consultante externo sin autorización expresa del
 * paciente, así que lo que entra acá es una decisión de privacidad, no de
 * formato: cada campo tiene que justificarse por su utilidad en una urgencia.
 *
 * **El contrato lo fija la web, no este archivo.** Las pantallas ya están en
 * producción (ENG-135, web #36) consumiendo exactamente esta forma, con los
 * nombres en español, y lo mismo hace la app mobile. Está tipado en
 * `mediconnect-web/src/features/medipass/types/medipass.ts`: si acá cambia un
 * nombre de campo, hay que tocar web y mobile en el mismo momento.
 */

/** Una alergia del paciente, tal como la muestra la ficha de emergencia. */
export interface VitalAllergy {
  que: string;
  gravedad: string;
}

/** Medicación crónica: la droga y la dosis, más una nota opcional. */
export interface VitalMedication {
  droga: string;
  dosis: string;
  nota?: string | null;
}

/** Condición preexistente, con su código de clasificación si se cargó. */
export interface VitalCondition {
  nombre: string;
  codigo: string;
}

/** A quién llamar. Es el campo que más se usa y el que nunca está cargado. */
export interface VitalContact {
  nombre: string;
  vinculo: string;
  telefono: string;
}

/**
 * El bloque vital.
 *
 * Solo `nombre` es obligatorio: es lo que le permite al médico confirmar que la
 * ficha que abrió es de la persona que tiene adelante. Todo el resto es
 * `undefined` o `null` cuando el paciente no lo cargó, y la pantalla lo omite en
 * vez de mostrar "undefined" frente a un médico.
 */
export interface VitalBlock {
  nombre: string;
  edad?: number | null;
  sexo?: string | null;
  grupoSanguineo?: string | null;
  pais?: string | null;
  alergias?: VitalAllergy[] | null;
  medicacion?: VitalMedication[] | null;
  condiciones?: VitalCondition[] | null;
  contacto?: VitalContact | null;
}

/**
 * Las columnas de `patients` que este módulo necesita para armar el bloque.
 *
 * Tipado a mano y no con `Prisma.PatientGetPayload` a propósito: deja ver de un
 * vistazo que hoy el bloque vital se construye con **tres columnas**, y que todo
 * lo demás está en `null` porque los campos clínicos todavía no existen en la
 * tabla.
 */
export interface PatientVitalSource {
  first_name: string;
  last_name: string;
  birth_date: Date | null;
}

/** `select` de Prisma que corresponde a `PatientVitalSource`. */
export const VITAL_SELECT = {
  first_name: true,
  last_name: true,
  birth_date: true,
} as const;

/**
 * Edad en años cumplidos.
 *
 * Se calcula en UTC porque `birth_date` es un `date` sin huso: construirlo en
 * hora local haría que, para alguien nacido un 1° de enero, la edad cambiara
 * según el servidor. Argentina no tiene horario de verano, pero el servidor de
 * producción corre en UTC y los tests en la máquina de cada uno.
 */
export function ageAt(birthDate: Date, now: Date): number {
  let edad = now.getUTCFullYear() - birthDate.getUTCFullYear();

  const cumplioEsteAnio =
    now.getUTCMonth() > birthDate.getUTCMonth() ||
    (now.getUTCMonth() === birthDate.getUTCMonth() &&
      now.getUTCDate() >= birthDate.getUTCDate());

  if (!cumplioEsteAnio) edad -= 1;
  return edad;
}

/**
 * Arma el bloque vital con lo que hay hoy en `patients`.
 *
 * **Los campos clínicos salen en `null` a propósito, no por olvido.** La tabla
 * `patients` tiene cinco columnas (nombre, apellido, fecha de nacimiento, DNI y
 * teléfono) y ninguna es clínica: grupo sanguíneo, alergias, medicación crónica,
 * condiciones y contacto de emergencia los agrega **ENG-134**, y el formulario
 * para que el paciente los cargue es **ENG-136**.
 *
 * Se devuelven en `null` en vez de postergar el endpoint porque la pantalla del
 * MediPass ya está en producción y hoy falla: con el nombre y la edad deja de
 * fallar, y los campos aparecen solos cuando ENG-134 entre. Cuando eso pase,
 * esta función es el único lugar que hay que tocar — sumar las columnas a
 * `VITAL_SELECT` y mapearlas acá.
 */
export function toVitalBlock(
  patient: PatientVitalSource,
  now: Date,
): VitalBlock {
  return {
    nombre: `${patient.first_name} ${patient.last_name}`.trim(),
    edad: patient.birth_date ? ageAt(patient.birth_date, now) : null,
    // Pendientes de ENG-134 (columnas) y ENG-136 (carga).
    sexo: null,
    grupoSanguineo: null,
    pais: null,
    alergias: null,
    medicacion: null,
    condiciones: null,
    contacto: null,
  };
}
