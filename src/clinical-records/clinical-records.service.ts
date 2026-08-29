import {
  ConflictException,
  ForbiddenException,
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
import {
  CLINICAL_ENTRY_RESOURCE_TYPE,
  toClinicalImpression,
} from './clinical-entry.fhir';
import { CreateClinicalEntryDto } from './dto/create-clinical-entry.dto';

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
   * Agrega una entrada firmada por un profesional a la HC de un paciente
   * (ENG-58).
   *
   * Es `append()` más las dos cosas que `append()` no puede saber: que quien
   * firma tenga derecho a escribir en esa historia, y cómo se traduce el
   * formulario a FHIR.
   */
  async addEntryAsProfessional(
    professionalId: string,
    patientId: string,
    dto: CreateClinicalEntryDto,
    now: Date = new Date(),
  ): Promise<ClinicalEntryView> {
    await this.assertCanWriteFor(professionalId, patientId);

    // El mismo instante se usa para el recurso FHIR y para `created_at`, que
    // entra a la preimagen del hash. Si se tomaran por separado, el `date` del
    // recurso y la fecha de la fila diferirían por unos milisegundos y el asiento
    // diría dos cosas distintas sobre cuándo se escribió.
    const at = new Date(now.getTime());

    return this.append(
      {
        patientId,
        professionalId,
        entryType: dto.entryType,
        fhirResourceType: CLINICAL_ENTRY_RESOURCE_TYPE,
        content: toClinicalImpression(dto, { patientId, professionalId }, at),
        consultationId: dto.consultationId ?? null,
      },
      at,
    );
  }

  /**
   * Un profesional solo puede escribir en la HC de un paciente con el que tiene
   * o tuvo un turno.
   *
   * Sin esto, cualquier profesional validado podría agregar un asiento a la
   * historia de cualquier paciente del sistema con solo saber su UUID — y como la
   * tabla es append-only, ese asiento **no se podría borrar nunca**. La regla es
   * de negocio y cruza dos tablas, así que vive acá y no en una policy: RLS
   * decide sobre la fila que se toca, no sobre la relación entre dos personas.
   *
   * Se aceptan turnos en **cualquier** estado, incluidos cancelados y pasados. El
   * criterio de aceptación pide el formulario disponible "durante y después de la
   * consulta", y un profesional que atendió a alguien hace un mes sigue teniendo
   * que poder completar o ampliar ese registro. Lo que la regla frena es al
   * profesional que nunca tuvo nada que ver con ese paciente.
   */
  private async assertCanWriteFor(
    professionalId: string,
    patientId: string,
  ): Promise<void> {
    const appointment = await this.prisma.appointment.findFirst({
      where: { professional_id: professionalId, patient_id: patientId },
      select: { id: true },
    });

    if (!appointment) {
      throw new ForbiddenException(
        'Solo podés escribir en la historia clínica de un paciente al que atendiste.',
      );
    }
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
   * Se lee con el JWT de quien pregunta: **RLS es la autorización**. Tres
   * políticas de SELECT se suman sobre esta tabla: el paciente ve lo suyo
   * (ENG-57), el profesional ve lo que firmó (ENG-58) y el profesional con un
   * turno no cancelado ve la HC completa de ese paciente (ENG-60).
   *
   * Este método NO decide quién puede leer: devuelve lo que RLS deje pasar. El
   * 403 y la auditoría los pone `readPatientRecord`, que es el camino que usa el
   * controller. Llamar a este método directo saltea el registro de acceso.
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
   * Lee la HC de un paciente dejando registro de quién la abrió (ENG-60).
   *
   * Es el camino que usa el controller. Hace tres cosas que `listForPatient` no
   * hace, y que son el contenido de esta historia:
   *
   * 1. **Corta con 403** a quien no tiene relación con el paciente, en vez de
   *    devolverle una lista vacía.
   * 2. **Registra el acceso** en `audit_logs`.
   * 3. Distingue al paciente leyendo lo suyo del profesional leyendo lo ajeno.
   *
   * Sobre el 403: ENG-58 devolvía `[]` a propósito, para no confirmarle a un
   * tercero que ese paciente tiene historia clínica. El criterio de aceptación de
   * ENG-60 pide 403 explícito y esa es la decisión que se tomó, asumiendo el
   * costo: un 403 revela que el `patientId` corresponde a un paciente real. Se
   * mitiga en parte con el mensaje, que no dice nada de la HC en sí. Como el
   * `patientId` es un UUID v4 no adivinable, la superficie es acotada.
   */
  async readPatientRecord(
    viewerId: string,
    accessToken: string,
    patientId: string,
  ): Promise<ClinicalEntryView[]> {
    // `patientId` es el `profile_id` del paciente, el mismo valor que el `sub`
    // del JWT: si coinciden, es el paciente leyendo su propia historia y no hay
    // relación que validar.
    const asPatient = viewerId === patientId;

    if (!asPatient) {
      await this.assertCanReadFor(viewerId, patientId);
    }

    const entries = await this.listForPatient(accessToken, patientId);

    await this.recordAccess(viewerId, patientId, asPatient, entries.length);

    return entries;
  }

  /**
   * Exige una relación profesional-paciente para leer la HC.
   *
   * **Relación = un turno que no esté cancelado.** Desde que el paciente reserva
   * ya es su paciente, así que valen `RESERVADO_SIN_PAGAR`, `CONFIRMADO` y
   * `COMPLETADO`; `CANCELADO` no, porque un turno dado de baja nunca constituyó
   * una atención.
   *
   * Espeja la condición de la política de RLS a propósito. La política es la
   * autoridad —es la que protege la lectura por PostgREST—, pero sola solo puede
   * devolver cero filas, y de una HC vacía no se distingue. Esta consulta es la
   * que permite contestar 403.
   *
   * Es más amplia que `assertCanWriteFor` (ENG-58), que acepta cualquier turno
   * sin mirar el estado. La diferencia es deliberada: leer de más es un problema
   * de privacidad y escribir de más es un problema de integridad de la HC, así
   * que el filtro por estado va del lado de la lectura. Unificar los dos criterios
   * merece su propio ticket.
   */
  private async assertCanReadFor(
    professionalId: string,
    patientId: string,
  ): Promise<void> {
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        professional_id: professionalId,
        patient_id: patientId,
        status: { not: 'CANCELADO' },
      },
      select: { id: true },
    });

    if (!appointment) {
      throw new ForbiddenException(
        'Solo podés ver la historia clínica de un paciente con el que tenés un turno.',
      );
    }
  }

  /**
   * Deja constancia de un acceso a la HC en `audit_logs`.
   *
   * Es un requisito de la Ley 26.529 (el paciente tiene derecho a saber quién
   * miró su historia) y es lo que alimenta el "Historial de accesos" que el
   * diseño le muestra al paciente.
   *
   * **Falla cerrado a propósito**: si no se puede registrar el acceso, no se
   * entrega la HC. Un acceso sin registro es exactamente lo que la ley no
   * permite, y tragarse el error dejaría un hueco invisible en la bitácora. El
   * costo es real —una caída de la escritura de auditoría bloquea la lectura
   * clínica— y es el tradeoff que se eligió; si en operación resulta demasiado
   * caro, la salida es hacer durable la escritura (cola/outbox), no volverla
   * best-effort.
   *
   * Escribe por Prisma (owner) y no por PostgREST: `audit_logs` no tiene GRANT de
   * INSERT para `authenticated`, y no debe tenerlo — si el cliente pudiera
   * escribir su propia bitácora, podría no escribirla.
   */
  private async recordAccess(
    actorId: string,
    patientId: string,
    asPatient: boolean,
    entryCount: number,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actor_id: actorId,
          action: 'CLINICAL_RECORD_READ',
          resource_type: 'clinical_record_entries',
          // El recurso auditado es la HC, y la HC es del paciente: por eso va el
          // paciente y no cada entrada. Una lectura es un evento, no N.
          resource_id: patientId,
          metadata: {
            // Permite separar "el paciente miró lo suyo" de "un profesional miró
            // la HC de un paciente", que es lo único que el paciente quiere ver
            // en su historial de accesos.
            role: asPatient ? 'PACIENTE' : 'PROFESIONAL',
            entryCount,
          },
        },
      });
    } catch (error) {
      this.logger.error(
        `No se pudo auditar el acceso de ${actorId} a la HC de ${patientId}: ${String(error)}`,
      );
      throw new InternalServerErrorException(
        'No pudimos registrar el acceso a la historia clínica, así que no la mostramos. Probá de nuevo en unos minutos.',
      );
    }
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
