import type {
  VitalAllergyDto,
  VitalConditionDto,
  VitalMedicationDto,
} from '../../patients/dto/update-vital-info.dto';

/**
 * Lee un resumen de paciente IPS de Argentina (ENG-246, ADR-022).
 *
 * El IPS-AR es FHIR R4: un `Bundle` de tipo `document` con una `Composition` y
 * los recursos de las secciones del piloto nacional (problemas, medicamentos,
 * alergias y vacunas), codificados con SNOMED CT. Es lo que el paciente trae de
 * otro sistema ("intercambio mediado por el paciente") y sube como un documento
 * más de los que aporta (ENG-164).
 *
 * Sirve para dos cosas: mostrarle el resumen ordenado al profesional y al
 * paciente, y proponerle al paciente sumar las alergias, la medicación y las
 * condiciones a su MediPass, con los topes de `UpdateVitalInfoDto` para que se
 * puedan guardar tal cual.
 *
 * **Función pura:** no guarda nada ni llama a nadie. Nada de esto entra a la
 * historia clínica firmada: no lo escribió un profesional de MediConnect.
 *
 * Lo que no conoce lo ignora y lo informa, sin fallar: un documento "casi IPS"
 * de otro sistema igual aporta lo que se puede leer.
 */

/** Los mismos topes que `UpdateVitalInfoDto`: la propuesta tiene que poder guardarse. */
const MAX = {
  que: 120,
  gravedad: 60,
  droga: 120,
  dosis: 60,
  nombre: 120,
  codigo: 30,
};
/** Lo que se acepta por lista, igual que el DTO. */
const MAX_FILAS = 30;
const SNOMED = /^https?:\/\/snomed\.info\/sct/;
const DNI_RENAPER = /renaper\.gob\.ar\/dni/;

/** Recursos que se leen o que son parte normal del documento: no se informan como ignorados. */
const CONOCIDOS = new Set([
  'Composition',
  'Patient',
  'AllergyIntolerance',
  'MedicationStatement',
  'Medication',
  'Condition',
  'Immunization',
  'Organization',
  'Practitioner',
  'PractitionerRole',
  'Device',
]);

/** Lo mínimo de FHIR que se lee. El resto del recurso se ignora. */
type Coding = { system?: unknown; code?: unknown; display?: unknown };
type Concepto = { text?: unknown; coding?: unknown };
type Recurso = Record<string, unknown> & {
  resourceType?: unknown;
  id?: unknown;
};

export class InvalidIpsError extends Error {}

export interface IpsPreview {
  documento: {
    titulo: string | null;
    /** Fecha del documento, tal como viene (ISO). */
    fecha: string | null;
    /** El DNI del paciente del documento, si lo trae (sistema de RENAPER). */
    dni: string | null;
  };
  propuesta: {
    allergies: VitalAllergyDto[];
    medications: VitalMedicationDto[];
    conditions: VitalConditionDto[];
  };
  /** Las vacunas no tienen lugar en el MediPass: se muestran, no se cargan. */
  vacunas: { vacuna: string; fecha: string | null }[];
  /** Qué no se leyó, en palabras, para mostrárselo al paciente. */
  ignorados: string[];
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const texto = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

function codings(concepto: unknown): Coding[] {
  if (!esObjeto(concepto) || !Array.isArray((concepto as Concepto).coding))
    return [];
  return ((concepto as Concepto).coding as unknown[]).filter(esObjeto);
}

/**
 * Lo que se muestra de un concepto: el texto, o el primer `display`, sin la
 * etiqueta semántica de SNOMED ("asma (trastorno)" pasa a "asma").
 */
function nombreDe(concepto: unknown): string {
  const crudo =
    (esObjeto(concepto) ? texto(concepto.text) : undefined) ??
    codings(concepto)
      .map((c) => texto(c.display))
      .find(Boolean) ??
    '';
  return crudo.replace(/\s*\([^()]*\)\s*$/, '').trim();
}

/** Con la primera letra en mayúscula, como lo escribiría el paciente: "Asma". */
function conMayuscula(nombre: string): string {
  return nombre
    ? nombre[0].toLocaleUpperCase('es-AR') + nombre.slice(1)
    : nombre;
}

/**
 * Lo que va en "A qué" de una alergia: la sustancia, no el trastorno. SNOMED
 * dice "alergia a la penicilina"; el paciente escribe "Penicilina", y así se
 * reconoce como la misma y no se suma dos veces.
 */
function sustanciaDeAlergia(nombre: string): string {
  return conMayuscula(
    nombre.replace(/^alergia (?:al|a la|a el|a los|a las|a) /i, ''),
  );
}

/**
 * El nombre de una vacuna sin el comienzo genérico de SNOMED: "producto que
 * contiene solamente antígeno de virus de la influenza" pasa a "Antígeno de
 * virus de la influenza".
 */
function nombreDeVacuna(nombre: string): string {
  return conMayuscula(
    nombre.replace(/^producto que contiene (?:solamente |exactamente )?/i, ''),
  );
}

function codigoSnomed(concepto: unknown): string | undefined {
  const c = codings(concepto).find((x) => SNOMED.test(texto(x.system) ?? ''));
  const code = texto(c?.code);
  return code ? `SNOMED ${code}` : undefined;
}

function recortar(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `clinicalStatus` dice que ya no corresponde (resuelta, inactiva, en remisión). */
function yaNoVigente(recurso: Recurso): boolean {
  const codigo = codings(recurso.clinicalStatus)[0]?.code;
  return (
    typeof codigo === 'string' && /inactive|resolved|remission/.test(codigo)
  );
}

/** Sin repetidos: un documento puede listar dos veces lo mismo. */
function unicos<T>(items: T[], clave: (t: T) => string): T[] {
  const vistos = new Set<string>();
  return items.filter((item) => {
    const k = clave(item).toLocaleLowerCase('es-AR');
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

export function readIps(bundle: unknown): IpsPreview {
  if (
    !esObjeto(bundle) ||
    bundle.resourceType !== 'Bundle' ||
    bundle.type !== 'document'
  ) {
    throw new InvalidIpsError(
      'El archivo no es un resumen de salud IPS: tiene que ser un documento FHIR (Bundle de tipo "document").',
    );
  }
  const recursos = (Array.isArray(bundle.entry) ? bundle.entry : [])
    .map((e) => (esObjeto(e) ? e.resource : undefined))
    .filter(esObjeto) as Recurso[];

  const composicion = recursos.find((r) => r.resourceType === 'Composition');
  if (!composicion) {
    throw new InvalidIpsError(
      'El archivo no es un resumen de salud IPS: le falta la composición del documento.',
    );
  }

  // Las referencias pueden ser absolutas (`http://.../Medication/123`): se
  // resuelven dentro del documento por tipo e id.
  const porId = new Map(
    recursos
      .filter(
        (r) => typeof r.resourceType === 'string' && typeof r.id === 'string',
      )
      .map((r) => [`${r.resourceType as string}/${r.id as string}`, r]),
  );
  const resolver = (ref: unknown): Recurso | undefined => {
    const valor = esObjeto(ref) ? texto(ref.reference) : undefined;
    const m = valor ? /([A-Za-z]+\/[^/]+)$/.exec(valor) : null;
    return m ? porId.get(m[1]) : undefined;
  };
  const de = (tipo: string) => recursos.filter((r) => r.resourceType === tipo);

  const paciente = de('Patient')[0];
  const identificadores = Array.isArray(paciente?.identifier)
    ? paciente.identifier
    : [];
  const dni = identificadores
    .filter(esObjeto)
    .find((i) => DNI_RENAPER.test(texto(i.system) ?? ''));

  const allergies = unicos(
    de('AllergyIntolerance')
      .filter((r) => !yaNoVigente(r))
      .map((r): VitalAllergyDto => {
        const gravedad =
          r.criticality === 'high'
            ? 'Grave'
            : r.criticality === 'low'
              ? 'Leve'
              : undefined;
        return {
          que: recortar(sustanciaDeAlergia(nombreDe(r.code)), MAX.que),
          ...(gravedad ? { gravedad } : {}),
        };
      })
      .filter((a) => a.que),
    (a) => a.que,
  ).slice(0, MAX_FILAS);

  const medications = unicos(
    de('MedicationStatement')
      .filter((r) => (texto(r.status) ?? 'active') === 'active')
      .map((r): VitalMedicationDto => {
        const medicamento = resolver(r.medicationReference);
        // El nombre SNOMED del producto es larguísimo ("producto que contiene
        // exactamente salbutamol 200 microgramos/disparo en polvo…"): si el
        // Medication trae los principios activos, van esos con su concentración.
        const activos = (
          Array.isArray(medicamento?.ingredient) ? medicamento.ingredient : []
        )
          .filter(esObjeto)
          .filter((i) => i.isActive !== false)
          .map((i) => {
            const nombre = conMayuscula(
              nombreDe(i.itemCodeableConcept ?? i.code),
            );
            const strength = esObjeto(i.strength) ? i.strength : undefined;
            const n = esObjeto(strength?.numerator)
              ? strength.numerator
              : undefined;
            return nombre && typeof n?.value === 'number' && texto(n.unit)
              ? `${nombre} ${n.value} ${texto(n.unit)}`
              : nombre;
          })
          .filter(Boolean);
        const droga = activos.length
          ? activos.join(' + ')
          : conMayuscula(
              nombreDe(r.medicationCodeableConcept ?? medicamento?.code),
            );

        const dosage = Array.isArray(r.dosage)
          ? r.dosage.filter(esObjeto)[0]
          : undefined;
        const doseAndRate = Array.isArray(dosage?.doseAndRate)
          ? dosage.doseAndRate.filter(esObjeto)[0]
          : undefined;
        const cantidad = esObjeto(doseAndRate?.doseQuantity)
          ? doseAndRate.doseQuantity
          : undefined;
        const dosis =
          typeof cantidad?.value === 'number' && texto(cantidad.unit)
            ? recortar(
                `${cantidad.value} ${nombreDe({ text: cantidad.unit })}`,
                MAX.dosis,
              )
            : texto(dosage?.text)
              ? recortar(texto(dosage?.text)!, MAX.dosis)
              : undefined;

        return {
          droga: recortar(droga, MAX.droga),
          ...(dosis ? { dosis } : {}),
        };
      })
      .filter((m) => m.droga),
    (m) => m.droga,
  ).slice(0, MAX_FILAS);

  const conditions = unicos(
    de('Condition')
      .filter((r) => !yaNoVigente(r))
      .map((r): VitalConditionDto => {
        const codigo = codigoSnomed(r.code);
        return {
          nombre: recortar(conMayuscula(nombreDe(r.code)), MAX.nombre),
          ...(codigo && codigo.length <= MAX.codigo ? { codigo } : {}),
        };
      })
      .filter((c) => c.nombre),
    (c) => c.nombre,
  ).slice(0, MAX_FILAS);

  const vacunas = de('Immunization')
    .map((r) => ({
      vacuna: nombreDeVacuna(nombreDe(r.vaccineCode)),
      fecha: texto(r.occurrenceDateTime) ?? null,
    }))
    .filter((v) => v.vacuna);

  const ignorados = [
    ...new Set(
      recursos
        .map((r) => texto(r.resourceType) ?? 'Recurso sin tipo')
        .filter((tipo) => !CONOCIDOS.has(tipo)),
    ),
  ].map((tipo) => `${tipo}: no es parte del MediPass.`);

  return {
    documento: {
      titulo: texto(composicion.title) ?? null,
      fecha: texto(composicion.date) ?? null,
      dni: texto(dni?.value)?.replace(/\D/g, '') || null,
    },
    propuesta: { allergies, medications, conditions },
    vacunas,
    ignorados,
  };
}
