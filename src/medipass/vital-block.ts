/**
 * El bloque vital del MediPass (HU-32, ENG-103, ENG-134).
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
 * Las columnas de `patients` que este módulo necesita.
 *
 * Los cuatro `jsonb` entran como `unknown` a propósito: Prisma los tipa como
 * `JsonValue`, pero el tipo no dice nada sobre la forma real de lo guardado.
 * Postgres acepta cualquier JSON válido en esas columnas y no hay CHECK que lo
 * acote (ver la migración de ENG-134), así que la forma se verifica al leer y no
 * se asume.
 */
export interface PatientVitalSource {
  first_name: string;
  last_name: string;
  birth_date: Date | null;
  sex: string | null;
  blood_type: string | null;
  allergies: unknown;
  medications: unknown;
  conditions: unknown;
  emergency_contact: unknown;
}

/** `select` de Prisma que corresponde a `PatientVitalSource`. */
export const VITAL_SELECT = {
  first_name: true,
  last_name: true,
  birth_date: true,
  sex: true,
  blood_type: true,
  allergies: true,
  medications: true,
  conditions: true,
  emergency_contact: true,
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

/** Un string con contenido, o `null`. Lo que no es texto útil no se devuelve. */
function texto(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const limpio = value.trim();
  return limpio.length > 0 ? limpio : null;
}

/** Igual que `texto` pero devuelve `''`: para las claves que el contrato de la
 *  web tipa como obligatorias y que no se pueden omitir. */
function textoOpcional(value: unknown): string {
  return texto(value) ?? '';
}

/** `true` si es un objeto plano con el que vale la pena intentar. */
function esObjeto(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Mapea una columna `jsonb` que tiene que ser una lista.
 *
 * Lo que no es un array se descarta entero, y dentro del array se descarta
 * entrada por entrada: una alergia mal cargada no puede hacer desaparecer las
 * otras tres. Una lista que queda vacía vuelve como `null`, que es lo que la
 * pantalla sabe omitir — un array vacío la haría dibujar la sección con nada
 * adentro.
 */
function lista<T>(
  value: unknown,
  mapper: (entry: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;

  const items = value.map(mapper).filter((item): item is T => item !== null);

  return items.length > 0 ? items : null;
}

/**
 * Una alergia es útil si dice **a qué**. La gravedad puede faltar: saber que es
 * alérgico a la penicilina sin saber cuán grave sigue siendo la información que
 * cambia una decisión en una guardia. Lo que no se hace es inventar un valor
 * —"sin especificar" sería texto que el paciente nunca escribió frente a un
 * médico—, así que va vacío y la pantalla no lo muestra.
 */
function toAllergy(entry: unknown): VitalAllergy | null {
  if (!esObjeto(entry)) return null;
  const que = texto(entry.que);
  if (!que) return null;
  return { que, gravedad: textoOpcional(entry.gravedad) };
}

/** Una medicación es útil si dice la droga. La dosis puede faltar. */
function toMedication(entry: unknown): VitalMedication | null {
  if (!esObjeto(entry)) return null;
  const droga = texto(entry.droga);
  if (!droga) return null;
  return {
    droga,
    dosis: textoOpcional(entry.dosis),
    nota: texto(entry.nota),
  };
}

/** Una condición es útil si tiene nombre. El código de clasificación es extra. */
function toCondition(entry: unknown): VitalCondition | null {
  if (!esObjeto(entry)) return null;
  const nombre = texto(entry.nombre);
  if (!nombre) return null;
  return { nombre, codigo: textoOpcional(entry.codigo) };
}

/**
 * El contacto de emergencia necesita **nombre y teléfono**: sin el teléfono no
 * se puede llamar a nadie, y es lo único para lo que existe el campo. El vínculo
 * es contexto y puede faltar.
 */
function toContact(value: unknown): VitalContact | null {
  if (!esObjeto(value)) return null;
  const nombre = texto(value.nombre);
  const telefono = texto(value.telefono);
  if (!nombre || !telefono) return null;
  return { nombre, telefono, vinculo: textoOpcional(value.vinculo) };
}

/**
 * Arma el bloque vital con la fila de `patients`.
 *
 * Desde ENG-134 las seis columnas clínicas existen, así que esto devuelve lo que
 * el paciente haya cargado y `null` en lo que no. Lo que **no** se lee de la
 * base es `pais`: el tipo de la web lo tiene, pero ENG-134 no definió columna
 * para él y no se inventó una. Queda en `null` hasta que se decida si el
 * MediPass lo necesita.
 *
 * Los cuatro `jsonb` se parsean a la defensiva. No es paranoia de más: la
 * columna acepta cualquier JSON, el seed y una corrección manual en la base
 * escriben ahí, y esta función corre en la ficha de emergencia de alguien en una
 * urgencia. Una fila mal cargada tiene que degradar a "ese campo no se muestra",
 * nunca a un 500 que deje al médico sin la ficha entera.
 */
export function toVitalBlock(
  patient: PatientVitalSource,
  now: Date,
): VitalBlock {
  return {
    nombre: `${patient.first_name} ${patient.last_name}`.trim(),
    edad: patient.birth_date ? ageAt(patient.birth_date, now) : null,
    sexo: texto(patient.sex),
    grupoSanguineo: texto(patient.blood_type),
    // Sin columna en ENG-134: ver el comentario de arriba.
    pais: null,
    alergias: lista(patient.allergies, toAllergy),
    medicacion: lista(patient.medications, toMedication),
    condiciones: lista(patient.conditions, toCondition),
    contacto: toContact(patient.emergency_contact),
  };
}
