import { randomInt, randomUUID } from 'node:crypto';
import {
  ConflictException,
  GoneException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpenEmergencySessionDto } from './dto/open-emergency-session.dto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  CODIGO_INVALIDO,
  SESSION_TTL_MS,
} from './medipass.config';
import {
  ACCESS_SELECT,
  toMediPassAccess,
  type MediPassAccess,
} from './medipass-access';
import {
  toVitalBlock,
  VITAL_SELECT,
  type PatientVitalSource,
  type VitalBlock,
} from './vital-block';

/** `GET /medipass/me`: el código vigente del paciente y cuándo rota. */
export interface MediPassCodeResponse {
  codigo: string;
  expiraEl: string;
}

/** `POST /medipass/sessions`: el acceso recién abierto, con la ficha adentro. */
export interface EmergencySessionResponse {
  sesionId: string;
  expiraEl: string;
  vital: VitalBlock;
}

/** `GET /medipass/sessions/:id`: la sesión sigue viva. */
export interface EmergencySessionStatusResponse {
  expiraEl: string;
  vital: VitalBlock;
}

/** Forma de un UUID v4, para no pegarle a la base con cualquier cosa. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El MediPass (EP-05): el código rotativo del paciente y el acceso de emergencia
 * que abre quien lo escanea.
 *
 * ## Por qué todo pasa por Prisma y no por Supabase con el token del usuario
 *
 * El resto de los módulos que leen datos del usuario usan
 * `SupabaseService.getClientForToken` y se apoyan en RLS. Acá no se puede, por
 * dos motivos distintos:
 *
 * 1. **`POST /medipass/sessions` y `GET /medipass/sessions/:id` son públicos.**
 *    Quien escanea el QR no tiene cuenta, así que no hay token con el que
 *    scopear nada: la autorización *es* el código, y la valida este service.
 * 2. **`medipass_access_logs` le revocó todos los privilegios a `authenticated`**
 *    (ENG-87, para que la bitácora sea append-only de verdad). Un cliente
 *    scopeado al usuario no puede escribirla ni leerla.
 *
 * La contracara es que el filtrado por `patient_id` es responsabilidad de este
 * código, no de la base, y por eso cada consulta lo lleva explícito. La
 * migración de ENG-72/ENG-73 habilita RLS sin políticas en `medipass_codes` y
 * `medipass_sessions` para que nadie más pueda llegar a ellas con la `anon key`.
 */
@Injectable()
export class MediPassService {
  private readonly logger = new Logger(MediPassService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * El código vigente del paciente; si no tiene uno, lo genera.
   *
   * Un solo código vigente por paciente: al pedirlo, los anteriores que
   * todavía no vencieron se vencen en el acto. Dos pestañas abiertas al mismo
   * tiempo podrían llegar a crear dos filas, y por eso la lectura toma siempre
   * **el de vencimiento más lejano**: el estado converge a uno solo y el QR de
   * la pantalla nunca muestra un código que el backend no aceptaría.
   */
  async getMyCode(patientId: string): Promise<MediPassCodeResponse> {
    await this.assertPatientExists(patientId);

    const ahora = new Date();
    const vigente = await this.prisma.mediPassCode.findFirst({
      where: { patient_id: patientId, expires_at: { gt: ahora } },
      orderBy: { expires_at: 'desc' },
      select: { code: true, expires_at: true },
    });

    if (vigente) {
      return {
        codigo: vigente.code,
        expiraEl: vigente.expires_at.toISOString(),
      };
    }

    const creado = await this.crearCodigo(patientId, ahora);

    return {
      codigo: creado.code,
      expiraEl: creado.expires_at.toISOString(),
    };
  }

  /**
   * Inserta el código nuevo, reintentando si el sorteo cayó en uno que ya existe.
   *
   * Desde ENG-170 `medipass_codes.code` es único (hallazgo 1 de ENG-105): antes,
   * dos pacientes con el mismo código vigente hacían que el canje resolviera a
   * uno de los dos y el consultante recibiera la ficha del paciente equivocado,
   * sin ninguna señal. Ahora la base lo rechaza con `P2002` y el reintento
   * sortea otro.
   *
   * Es el mismo patrón que `ClinicalRecordsService.append` ante una colisión de
   * `sequence_number`: la operación es válida, solo le tocó otro valor.
   */
  private async crearCodigo(
    patientId: string,
    ahora: Date,
  ): Promise<{ code: string; expires_at: Date }> {
    for (let intento = 1; intento <= CODE_MAX_ATTEMPTS; intento += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // Vencer lo que quedara vigente antes de insertar: si otra request
          // ganó la carrera, su código queda cortado acá y sobrevive uno solo.
          await tx.mediPassCode.updateMany({
            where: { patient_id: patientId, expires_at: { gt: ahora } },
            data: { expires_at: ahora },
          });

          return tx.mediPassCode.create({
            data: {
              patient_id: patientId,
              code: this.generarCodigo(),
              expires_at: new Date(ahora.getTime() + CODE_TTL_MS),
            },
            select: { code: true, expires_at: true },
          });
        });
      } catch (error) {
        if (!esCodigoRepetido(error) || intento === CODE_MAX_ATTEMPTS)
          throw error;

        // Con 28^8 combinaciones esto no debería verse nunca. Si aparece en los
        // logs con alguna frecuencia, el generador está mal, no hubo mala
        // suerte: vale la pena que quede como warning y no en silencio.
        this.logger.warn(
          `Colisión al generar el código MediPass del paciente ${patientId} (intento ${intento}/${CODE_MAX_ATTEMPTS})`,
        );
      }
    }

    // Inalcanzable: la última vuelta del loop relanza. Está por el tipo de
    // retorno, que TypeScript no puede inferir del `for`.
    throw new InternalServerErrorException(
      'No pudimos generar tu código. Probá de nuevo en unos segundos.',
    );
  }

  /** El bloque vital del propio paciente, que es lo que ve en su pantalla. */
  async getMyVitalBlock(patientId: string): Promise<VitalBlock> {
    const patient = await this.assertPatientExists(patientId);
    return toVitalBlock(patient, new Date());
  }

  /**
   * Abre un acceso de emergencia canjeando un código (HU-34, ENG-73).
   *
   * ## El código no es de un solo uso
   *
   * Cada canje abre **su propia sesión**, y el código sigue sirviendo hasta que
   * rota. Las dos razones son operativas: un médico que recarga la página no
   * puede quedar afuera teniendo que pedirle otro código a un paciente que
   * quizá no está en condiciones de mostrarlo, y en una guardia puede haber más
   * de una persona que necesita ver la ficha. Que cada canje tenga su sesión es
   * lo que permite que el paciente le corte el acceso a uno sin cortárselo a los
   * demás (HU-36, ENG-75), que es lo que el MediPass promete.
   *
   * `used_at` se escribe en el primer canje y no se vuelve a tocar: queda como
   * el dato de cuándo se usó por primera vez, no como una traba.
   *
   * Todo va en una transacción porque la sesión y su primera entrada en la
   * bitácora son un solo hecho: un acceso que no quedó registrado es
   * precisamente el que el paciente no puede auditar.
   */
  async openSession(
    dto: OpenEmergencySessionDto,
  ): Promise<EmergencySessionResponse> {
    const ahora = new Date();

    const code = await this.prisma.mediPassCode.findFirst({
      where: { code: dto.codigo, expires_at: { gt: ahora } },
      orderBy: { expires_at: 'desc' },
      select: {
        id: true,
        patient_id: true,
        used_at: true,
        patient: { select: VITAL_SELECT },
      },
    });

    // Mismo 404 para "no existe" y "venció" (ver CODIGO_INVALIDO).
    if (!code) throw new NotFoundException(CODIGO_INVALIDO);

    const expiraEl = new Date(ahora.getTime() + SESSION_TTL_MS);
    const sessionId = randomUUID();

    await this.prisma.$transaction(async (tx) => {
      await tx.mediPassSession.create({
        data: {
          id: sessionId,
          patient_id: code.patient_id,
          medipass_code_id: code.id,
          consultant_name: dto.nombre,
          consultant_license: dto.matricula ?? null,
          expires_at: expiraEl,
        },
      });

      if (!code.used_at) {
        await tx.mediPassCode.update({
          where: { id: code.id },
          data: { used_at: ahora },
        });
      }

      await tx.mediPassAccessLog.create({
        data: {
          session_id: sessionId,
          patient_id: code.patient_id,
          resource_accessed: 'medipass.vital',
        },
      });
    });

    return {
      sesionId: sessionId,
      expiraEl: expiraEl.toISOString(),
      vital: toVitalBlock(code.patient, ahora),
    };
  }

  /**
   * Estado de un acceso abierto. La ficha de emergencia lo consulta cada minuto.
   *
   * **El 410 no es un detalle de estilo.** Es lo único que le permite a la
   * pantalla distinguir "el acceso se terminó" de "se cayó la red", y de eso
   * depende que un médico no pierda la información vital en medio de una guardia
   * por un corte de WiFi. Un 404 genérico ante cualquier problema haría que la
   * ficha se cerrara sola cada vez que el micro pasa por un túnel.
   *
   * El vencimiento se evalúa acá, sobre el reloj del servidor, sin depender de
   * que un job haya marcado la fila: es el mismo criterio de ENG-101.
   *
   * No se escribe una entrada en la bitácora por cada consulta. El polling es
   * **el mismo acceso** que ya quedó registrado al abrirse: una fila por minuto
   * dejaría el historial de ENG-76 ilegible justo para lo que el paciente lo
   * necesita, que es ver quién entró y cuándo.
   */
  async getSessionStatus(
    sessionId: string,
  ): Promise<EmergencySessionStatusResponse> {
    // Un id con forma inválida se trata como inexistente y no como un 400: la
    // pantalla pública no tiene por qué saber si el id que recibió existe.
    if (!UUID_PATTERN.test(sessionId)) {
      throw new NotFoundException(CODIGO_INVALIDO);
    }

    const session = await this.prisma.mediPassSession.findUnique({
      where: { id: sessionId },
      select: {
        expires_at: true,
        revoked_at: true,
        patient: { select: VITAL_SELECT },
      },
    });

    if (!session) throw new NotFoundException(CODIGO_INVALIDO);

    const ahora = new Date();
    if (session.revoked_at || session.expires_at.getTime() <= ahora.getTime()) {
      throw new GoneException('El acceso venció o fue revocado.');
    }

    return {
      expiraEl: session.expires_at.toISOString(),
      vital: toVitalBlock(session.patient, ahora),
    };
  }

  /**
   * Los accesos abiertos ahora mismo sobre el MediPass del paciente (HU-35,
   * ENG-74).
   *
   * Es la mitad visible de lo que el MediPass promete: sin esta lista, el
   * paciente puede tener un acceso abierto y no saberlo, y el control sobre su
   * información clínica queda escrito en el diseño y en ningún otro lado. La
   * otra mitad es `revokeAccess`.
   *
   * ## El vencimiento se filtra acá, no en la base
   *
   * `expires_at: { gt: ahora }` contra el reloj del servidor, igual que
   * `getSessionStatus` y por el mismo motivo que ENG-101: ninguna lectura
   * devuelve una sesión vencida aunque el job de ENG-104 todavía no la haya
   * marcado. Si se confiara en una columna materializada, un job atrasado le
   * mostraría al paciente accesos abiertos que en realidad ya se cerraron —y,
   * peor, le dejaría "cortar" accesos que no existen.
   *
   * Ordenados por vencimiento ascendente: primero el que se cierra antes. Es el
   * orden que pide el ticket.
   */
  async listMyAccesses(patientId: string): Promise<MediPassAccess[]> {
    await this.assertPatientExists(patientId);

    const ahora = new Date();
    const sessions = await this.prisma.mediPassSession.findMany({
      where: {
        patient_id: patientId,
        revoked_at: null,
        expires_at: { gt: ahora },
      },
      orderBy: { expires_at: 'asc' },
      select: ACCESS_SELECT,
    });

    return sessions.map((session) => toMediPassAccess(session, ahora));
  }

  /**
   * El paciente corta un acceso (HU-36, ENG-75).
   *
   * Es **la** propiedad que el proyecto promete sobre el MediPass y la que hay
   * que poder demostrar en vivo: a partir de acá, el siguiente
   * `GET /medipass/sessions/:id` de esa sesión devuelve 410 y la ficha de
   * emergencia se cierra en el próximo poll. No hace falta ningún job: el 410
   * ya sale de `revoked_at` en `getSessionStatus`.
   *
   * Cortar un acceso **no corta los demás**, y eso es consecuencia directa de
   * que cada canje del código abra su propia sesión (ver `openSession`): en una
   * guardia con dos médicos mirando, el paciente le saca el acceso a uno sin
   * dejar al otro afuera.
   *
   * ## Por qué es idempotente y no da error si ya estaba cerrado
   *
   * Un acceso ya revocado, o que venció solo mientras el paciente apretaba el
   * botón, termina en el mismo estado que se pedía: cerrado. Devolver un error
   * ahí sería decirle al paciente que algo falló cuando el resultado es
   * exactamente el que quería, y un doble click no puede verse como una falla.
   * Lo que sí devuelve 404 es la sesión de otro paciente, con el mismo criterio
   * que `CODIGO_INVALIDO`: distinguirla de una inexistente diría si ese id
   * existe.
   *
   * ## Por qué la auditoría va en la misma transacción
   *
   * La revocación y su registro en `audit_logs` son un solo hecho. Si el log
   * fallara y la revocación quedara igual, el paciente vería "acceso cortado"
   * sin que haya quedado constancia de cuándo lo cortó, que es justo lo que
   * tendría que poder probar después. Y si se escribiera el log sin revocar,
   * sería una constancia falsa. Juntas en una transacción, un fallo devuelve
   * 500 y el paciente sabe que tiene que reintentar: de los tres resultados
   * posibles, el único inaceptable es que crea que cortó un acceso que sigue
   * abierto.
   */
  async revokeAccess(patientId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.mediPassSession.findUnique({
      where: { id: sessionId },
      select: {
        patient_id: true,
        revoked_at: true,
        expires_at: true,
        consultant_name: true,
        consultant_license: true,
      },
    });

    if (!session || session.patient_id !== patientId) {
      throw new NotFoundException('Ese acceso no existe.');
    }

    const ahora = new Date();
    const yaCerrado =
      session.revoked_at !== null ||
      session.expires_at.getTime() <= ahora.getTime();

    // Ya estaba cerrado: nada que revocar y nada que auditar. El paciente no
    // cortó este acceso —se cerró solo— y marcarlo como revocado falsearía el
    // historial de accesos que ENG-76 le va a mostrar.
    if (yaCerrado) return;

    try {
      await this.prisma.$transaction(async (tx) => {
        // `updateMany` con el estado esperado en el `where`, y no `update` por
        // id: si el job de ENG-104 o otra pestaña ganaron la carrera entre la
        // lectura de arriba y esto, `count` vuelve en 0 y no se escribe el log
        // de una revocación que no ocurrió.
        const { count } = await tx.mediPassSession.updateMany({
          where: {
            id: sessionId,
            patient_id: patientId,
            revoked_at: null,
            expires_at: { gt: ahora },
          },
          data: { revoked_at: ahora, revoked_by: patientId },
        });

        if (count === 0) return;

        await tx.auditLog.create({
          data: {
            actor_id: patientId,
            action: 'MEDIPASS_ACCESS_REVOKED',
            resource_type: 'medipass_sessions',
            resource_id: sessionId,
            metadata: {
              // Quién era, congelado en el log: la sesión se puede borrar alguna
              // vez por retención, y entonces el log sería el único lugar donde
              // dice a quién se le cortó el acceso.
              consultante: session.consultant_name,
              matricula: session.consultant_license,
              // Cuánto le quedaba. Es el dato que distingue "le corté el acceso
              // enseguida" de "lo dejé casi hasta el final".
              minutosRestantes: Math.max(
                0,
                Math.ceil(
                  (session.expires_at.getTime() - ahora.getTime()) / 60_000,
                ),
              ),
            },
          },
        });
      });
    } catch (error) {
      this.logger.error(
        `No se pudo revocar el acceso ${sessionId} del paciente ${patientId}: ${String(error)}`,
      );
      throw new InternalServerErrorException(
        'No pudimos cortar el acceso. Probá de nuevo en unos segundos.',
      );
    }
  }

  /**
   * La fila de `patients` tiene que existir: `medipass_codes.patient_id` apunta
   * a ella, y el bloque vital sale de ahí.
   *
   * Un paciente que todavía no completó su perfil no tiene fila (nace con la
   * primera carga, ENG-47), así que esto es un estado esperado y no un error del
   * servidor. Sale como 409 con un mensaje que dice qué hacer, y la pantalla lo
   * muestra tal cual.
   */
  private async assertPatientExists(
    patientId: string,
  ): Promise<PatientVitalSource> {
    const patient = await this.prisma.patient.findUnique({
      where: { profile_id: patientId },
      select: VITAL_SELECT,
    });

    if (!patient) {
      throw new ConflictException(
        'Completá tu perfil para poder usar el MediPass.',
      );
    }

    return patient;
  }

  /**
   * Un código nuevo.
   *
   * `randomInt` de `node:crypto` y no `Math.random()`: `Math.random()` no es
   * criptográficamente seguro y su estado se puede reconstruir observando
   * salidas. Para los datos de demo de `seed-demo.ts` da igual; para el código
   * que abre la ficha clínica de alguien, no.
   */
  private generarCodigo(): string {
    let codigo = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      codigo += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return codigo;
  }
}

/**
 * `P2002` de Prisma sobre la unique de `code` (ENG-170).
 *
 * Se mira el `target` y no solo el código de error: `medipass_codes` podría
 * tener otra unique alguna vez, y reintentar con un código nuevo no arreglaría
 * una colisión en otra columna —solo la escondería detrás de tres intentos.
 */
function esCodigoRepetido(error: unknown): boolean {
  if ((error as { code?: string }).code !== 'P2002') return false;

  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) return target.includes('code');
  if (typeof target === 'string') return target.includes('code');

  // Sin `meta.target` no se puede saber qué unique fue. Se trata como la de
  // `code`, que hoy es la única de la tabla.
  return true;
}
