import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  appendEntry,
  chainEntryFromRow,
  GENESIS_HASH,
  verifyChain,
  type ChainEntry,
  type ChainEntryRow,
  type ChainVerification,
} from '../common/hash-chain/hash-chain';

/**
 * Escritura y lectura de la Historia Clínica (ENG-57).
 *
 * Es la pieza compartida sobre la que se apoyan ENG-58 (agregar una entrada),
 * ENG-59 (el paciente ve su HC), ENG-60 (el profesional ve la del paciente) y
 * ENG-100 (corregir una entrada). Ninguna de esas historias debería volver a
 * calcular un hash ni a resolver el número de secuencia por su cuenta.
 *
 * Los dos caminos de datos del proyecto, y por qué cada uno:
 *
 * - **Prisma (owner)** para ESCRIBIR. `clinical_record_entries` no tiene GRANT de
 *   INSERT para `authenticated` y no debe tenerlo: el `content_hash` se calcula
 *   sobre una forma canónica del contenido y el `created_at` entra a la
 *   preimagen. Si el cliente pudiera insertar, podría sellar una entrada con una
 *   fecha que no es la real y la cadena la aceptaría, porque el hash cerraría
 *   igual. La fecha de un asiento clínico es justo lo que la Ley 26.529 pide que
 *   sea confiable.
 * - **PostgREST con el JWT del usuario** para LEER. La autoridad es RLS: el
 *   paciente ve su propia HC y nadie más. Cuando ENG-60 agregue la política del
 *   profesional, este mismo método la sirve sin tocar una línea.
 */

/** Tipos de entrada del enum `entry_type`. */
export type ClinicalEntryType =
  | 'CONSULTA'
  | 'DIAGNOSTICO'
  | 'PRESCRIPCION'
  | 'ESTUDIO'
  | 'CORRECCION';

/** Lo que aporta quien agrega una entrada. Todo lo demás lo pone el service. */
export interface NewClinicalEntry {
  patientId: string;
  /** Quien firma el asiento. Sale del JWT del profesional, nunca del body. */
  professionalId: string;
  entryType: ClinicalEntryType;
  /** Tipo de recurso FHIR R5 que hay en `content` (Observation, Condition…). */
  fhirResourceType: string;
  content: unknown;
  consultationId?: string | null;
  /** Entrada que esta corrige. La corregida NO se toca (ENG-100). */
  correctsEntryId?: string | null;
}

/** Entrada ya sellada y guardada. */
export interface ClinicalEntryView {
  id: string;
  patientId: string;
  professionalId: string;
  sequenceNumber: number;
  entryType: string;
  fhirResourceType: string;
  content: unknown;
  consultationId: string | null;
  correctsEntryId: string | null;
  createdAt: string;
  contentHash: string;
  previousHash: string;
}

/**
 * Reintentos ante colisión de `sequence_number`.
 *
 * El spike ENG-45 dejó dicho que el reintento **no es opcional**: el `for update`
 * del trigger de enlace bloquea la fila cabeza, pero al despertar no reevalúa el
 * `limit 1` y sigue viendo la cabeza vieja. Lo que realmente impide el duplicado
 * es la unique `(patient_id, sequence_number)`, y eso significa que el segundo
 * escritor recibe un error y tiene que volver a leer la cabeza.
 *
 * Tres alcanza y sobra: la colisión requiere dos escrituras simultáneas sobre el
 * MISMO paciente, que hoy solo puede pasar si el profesional y el pipeline de IA
 * (EP-07) escriben a la vez.
 */
const MAX_APPEND_ATTEMPTS = 3;

/** `P2002` de Prisma: violación de una restricción unique. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

const ENTRY_SELECT = {
  id: true,
  patient_id: true,
  professional_id: true,
  sequence_number: true,
  entry_type: true,
  fhir_resource_type: true,
  content: true,
  consultation_id: true,
  corrects_entry_id: true,
  created_at: true,
  content_hash: true,
  previous_hash: true,
} as const;

/** Columnas que pide PostgREST. Espeja `ENTRY_SELECT`. */
const ENTRY_COLUMNS =
  'id, patient_id, professional_id, sequence_number, entry_type, fhir_resource_type, content, consultation_id, corrects_entry_id, created_at, content_hash, previous_hash';

@Injectable()
export class ClinicalRecordsService {
  private readonly logger = new Logger(ClinicalRecordsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
  ) {}

  /**
   * Sella una entrada contra la cabeza de la cadena del paciente y la guarda.
   *
   * `now` es parámetro y no `new Date()` adentro por una razón concreta: el
   * timestamp entra a la preimagen del hash, así que tiene que ser exactamente el
   * mismo valor que se guarda. Tomarlo dos veces produciría un hash que no
   * corresponde a la fila.
   */
  async append(
    entry: NewClinicalEntry,
    now: Date = new Date(),
  ): Promise<ClinicalEntryView> {
    // Milisegundos, no microsegundos: la columna es `timestamptz(3)` y el `Date`
    // de JS no tiene más precisión que esa. Es el hallazgo bloqueante de ENG-45
    // — con `timestamptz(6)` el valor releído no coincide con el hasheado y la
    // entrada sale reportada como manipulada estando intacta.
    const createdAt = new Date(now.getTime());

    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
      const head = await this.headOf(entry.patientId);

      const sealed = appendEntry(
        {
          patientId: entry.patientId,
          professionalId: entry.professionalId,
          sequenceNumber: head.sequenceNumber + 1,
          entryType: entry.entryType,
          fhirResourceType: entry.fhirResourceType,
          content: entry.content,
          consultationId: entry.consultationId ?? null,
          correctsEntryId: entry.correctsEntryId ?? null,
          createdAt,
        },
        head.hash,
      );

      try {
        const row = await this.prisma.clinicalRecordEntry.create({
          data: {
            patient_id: sealed.patientId,
            professional_id: sealed.professionalId,
            sequence_number: sealed.sequenceNumber,
            entry_type: sealed.entryType as ClinicalEntryType,
            fhir_resource_type: sealed.fhirResourceType,
            content: sealed.content as never,
            consultation_id: sealed.consultationId ?? null,
            corrects_entry_id: sealed.correctsEntryId ?? null,
            created_at: sealed.createdAt,
            content_hash: sealed.contentHash,
            previous_hash: sealed.previousHash,
          },
          select: ENTRY_SELECT,
        });

        return toView(row);
      } catch (error) {
        if ((error as { code?: string }).code !== PRISMA_UNIQUE_VIOLATION) {
          this.logger.error(
            `No se pudo guardar la entrada de HC del paciente ${entry.patientId}: ${String(error)}`,
          );
          throw new InternalServerErrorException(
            'No pudimos guardar la entrada en la historia clínica. Probá de nuevo en unos minutos.',
          );
        }

        // Alguien escribió en esta cadena entre que leímos la cabeza y guardamos.
        // Volver a intentar es correcto: la entrada es válida, solo le tocaba otro
        // número. Reintentar NO duplica nada — el que llegó primero ya tiene su
        // fila y esta todavía no existe.
        this.logger.warn(
          `Colisión de sequence_number en la HC del paciente ${entry.patientId} (intento ${attempt}/${MAX_APPEND_ATTEMPTS})`,
        );
      }
    }

    throw new ConflictException(
      'La historia clínica está recibiendo otra entrada en este momento. Probá de nuevo.',
    );
  }

  /**
   * Cabeza actual de la cadena del paciente: su último hash y su número.
   *
   * Una cadena vacía devuelve el hash génesis y secuencia 0, así que la primera
   * entrada sale con `sequence_number` 1 encadenada contra los 64 ceros — que es
   * exactamente lo que valida el trigger.
   */
  async headOf(
    patientId: string,
  ): Promise<{ hash: string; sequenceNumber: number }> {
    const head = await this.prisma.clinicalRecordEntry.findFirst({
      where: { patient_id: patientId },
      orderBy: { sequence_number: 'desc' },
      select: { sequence_number: true, content_hash: true },
    });

    return head
      ? {
          hash: head.content_hash,
          sequenceNumber: Number(head.sequence_number),
        }
      : { hash: GENESIS_HASH, sequenceNumber: 0 };
  }

  /**
   * Historia clínica de un paciente, de la entrada más vieja a la más nueva.
   *
   * Se lee con el JWT de quien pregunta: **RLS es la autorización**. Hoy la única
   * política de SELECT es `clinical_record_entries_select_own_patient`, así que
   * un profesional recibe una lista vacía aunque el paciente sea suyo — eso lo
   * habilita ENG-60 agregando su política, sin tocar este método.
   *
   * El orden es por `sequence_number` y no por `created_at`: la secuencia es la
   * que define la cadena, y dos entradas pueden compartir el milisegundo.
   */
  async listForPatient(
    accessToken: string,
    patientId: string,
  ): Promise<ClinicalEntryView[]> {
    const client = this.supabase.getClientForToken(accessToken);

    const { data, error } = await client
      .from('clinical_record_entries')
      .select(ENTRY_COLUMNS)
      .eq('patient_id', patientId)
      .order('sequence_number', { ascending: true });

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos cargar la historia clínica. Probá de nuevo en unos minutos.',
      );
    }

    return ((data ?? []) as unknown as (ChainEntryRow & { id: string })[]).map(
      toView,
    );
  }

  /**
   * Recalcula la cadena de un paciente y dice si está íntegra.
   *
   * Es la verificación **puntual** —al abrir una HC, antes de agregarle algo—, no
   * la auditoría periódica: esa es ENG-85, que además compara contra el snapshot
   * de la cabeza para detectar truncado y reescritura, cosas que una cadena
   * aislada no puede ver por sí sola.
   */
  async verifyPatientChain(patientId: string): Promise<ChainVerification> {
    const rows = await this.prisma.clinicalRecordEntry.findMany({
      where: { patient_id: patientId },
      orderBy: { sequence_number: 'asc' },
      select: ENTRY_SELECT,
    });

    return verifyChain(
      rows.map((row) => chainEntryFromRow(row as ChainEntryRow)),
    );
  }
}

/** Fila de la base → objeto que sale por la API. */
function toView(row: ChainEntryRow & { id: string }): ClinicalEntryView {
  const entry: ChainEntry = chainEntryFromRow(row);

  return {
    id: row.id,
    patientId: entry.patientId,
    professionalId: entry.professionalId,
    sequenceNumber: entry.sequenceNumber,
    entryType: entry.entryType,
    fhirResourceType: entry.fhirResourceType,
    content: entry.content,
    consultationId: entry.consultationId ?? null,
    correctsEntryId: entry.correctsEntryId ?? null,
    createdAt: entry.createdAt.toISOString(),
    contentHash: entry.contentHash,
    previousHash: entry.previousHash,
  };
}
