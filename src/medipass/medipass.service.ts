import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  accessStatus,
  resourceLabel,
  type AccessStatus,
} from './access-history';
import { OpenEmergencySessionDto } from './dto/open-emergency-session.dto';
import { UpdateMediPassScopeDto } from './dto/update-medipass-scope.dto';
import { applyScope, MediPassScope, resolveScope } from './medipass-scope';
import {
  CARD_TOKEN_BYTES,
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
/** Estado de la tarjeta de emergencia, sin el token (ENG-176). */
export interface EmergencyCardStatusResponse {
  activa: boolean;
  creadaEl: string | null;
}

/**
 * La tarjeta recién generada. **Es la única vez que el token sale del
 * backend**: se guarda solo su hash, así que para reimprimirla hay que generar
 * otra (y la anterior deja de funcionar).
 */
export interface EmergencyCardCreatedResponse {
  tarjeta: string;
  creadaEl: string;
}

/** Por dónde entró un consultante: el código rotativo o la tarjeta (ENG-176). */
export type MediPassOrigin = 'CODIGO' | 'TARJETA';

export interface EmergencySessionStatusResponse {
  expiraEl: string;
  vital: VitalBlock;
}

/** Un acceso de un consultante al MediPass, con lo que miró (ENG-76). */
export interface MediPassAccessView {
  sesionId: string;
  consultante: { nombre: string | null; matricula: string | null };
  origen: MediPassOrigin;
  inicio: string;
  vence: string;
  revocadoEl: string | null;
  estado: AccessStatus;
  vistas: { recurso: string | null; etiqueta: string; el: string }[];
}

/** `GET /medipass/me/historial`: una página de accesos, del más reciente al más viejo. */
export interface MediPassHistoryResponse {
  accesos: MediPassAccessView[];
  pagina: number;
  hayMas: boolean;
}

/** Accesos por página del historial. */
const HISTORY_PAGE_SIZE = 10;

/** Sesiones que cierra cada UPDATE del job, y tope de UPDATEs por corrida. */
const CLOSE_BATCH = 1000;
const CLOSE_MAX_BATCHES = 20;

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly inApp: InAppNotificationsService,
  ) {}

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

  /**
   * El bloque vital del propio paciente, **entero**: es su información, y la
   * pantalla marca qué bloques no ve el consultante según el scope (ENG-149).
   */
  async getMyVitalBlock(patientId: string): Promise<VitalBlock> {
    const patient = await this.assertPatientExists(patientId);
    return toVitalBlock(patient, new Date());
  }

  /** Qué bloques ve un consultante externo (ENG-149). Sin configurar, todos. */
  async getMyScope(patientId: string): Promise<MediPassScope> {
    const fila = await this.prisma.patient.findUnique({
      where: { profile_id: patientId },
      select: { medipass_scope: true },
    });
    if (!fila) throw this.perfilIncompleto();
    return resolveScope(fila.medipass_scope);
  }

  /**
   * Cambia qué ve un consultante externo (ENG-149). Filtra por el `profile_id`
   * del JWT: un paciente solo puede tocar su propia fila. Vale también para las
   * sesiones ya abiertas, en su próximo refresco: el recorte se aplica al leer,
   * no al abrir la sesión.
   */
  async updateMyScope(
    patientId: string,
    dto: UpdateMediPassScopeDto,
  ): Promise<MediPassScope> {
    const scope = resolveScope(dto);
    try {
      await this.prisma.patient.update({
        where: { profile_id: patientId },
        data: { medipass_scope: { ...scope }, updated_at: new Date() },
      });
    } catch (err) {
      // P2025: no hay fila de `patients` (perfil sin completar), mismo 409 que
      // el resto de los endpoints del paciente.
      if ((err as { code?: string }).code === 'P2025') {
        throw this.perfilIncompleto();
      }
      throw err;
    }
    return scope;
  }

  /**
   * Cierra los accesos que vencieron o se cortaron (ENG-104): completa
   * `closed_at` con `revoked_at` o con `expires_at`, lo que haya pasado antes.
   * Lo llama el job cada 5 minutos.
   *
   * Es idempotente (solo toca las que siguen con `closed_at` en null) y no es
   * lo que impide ver una sesión vencida: eso ya lo hace cada lectura contra el
   * reloj del servidor.
   *
   * **`closed_at` es informativo, no autoriza nada.** Puede quedar desfasado
   * hasta 5 minutos (una sesión ya vencida o cortada y todavía en null hasta la
   * próxima corrida), así que para decidir si un acceso sigue abierto hay que
   * mirar `expires_at` y `revoked_at`.
   *
   * Trabaja de a `CLOSE_BATCH` filas, con un tope de vueltas por corrida: la
   * primera corrida después del deploy tiene que cerrar todo el histórico y no
   * puede pasarse del `--max-time 60` del workflow. Lo que no entre queda para
   * la corrida siguiente y converge solo.
   *
   * Un SQL y no `updateMany` porque el valor sale de otra columna de la misma
   * fila. Las dos condiciones van en un `union` y no en un `or` para que cada
   * una use su índice parcial (ver la migración de ENG-104).
   */
  async closeExpiredSessions(now: Date = new Date()): Promise<number> {
    let total = 0;
    for (let i = 0; i < CLOSE_MAX_BATCHES; i++) {
      const cerradas = await this.prisma.$executeRaw`
        update medipass_sessions
           set closed_at = least(coalesce(revoked_at, expires_at), expires_at)
         where id in (
           select id from (
             select id from medipass_sessions
              where closed_at is null and expires_at <= ${now}
             union
             select id from medipass_sessions
              where closed_at is null and revoked_at is not null
           ) abiertas
           limit ${CLOSE_BATCH})`;
      total += cerradas;
      if (cerradas < CLOSE_BATCH) break;
    }
    return total;
  }

  /**
   * Abre un acceso de emergencia canjeando un código (HU-34, ENG-73) o la
   * tarjeta de emergencia del paciente (ENG-176). Las dos credenciales abren lo
   * mismo: una sesión de 30 minutos, con su entrada en la bitácora y el aviso
   * al paciente. Lo único que cambia es qué se guarda como origen.
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
    const credencial = await this.resolveCredential(dto, ahora);

    const expiraEl = new Date(ahora.getTime() + SESSION_TTL_MS);
    const sessionId = randomUUID();

    await this.prisma.$transaction(async (tx) => {
      await tx.mediPassSession.create({
        data: {
          id: sessionId,
          patient_id: credencial.patientId,
          medipass_code_id: credencial.codeId,
          emergency_card_id: credencial.cardId,
          consultant_name: dto.nombre,
          consultant_license: dto.matricula ?? null,
          expires_at: expiraEl,
        },
      });

      if (credencial.codeId && credencial.codeUsedAt === null) {
        await tx.mediPassCode.update({
          where: { id: credencial.codeId },
          data: { used_at: ahora },
        });
      }

      await tx.mediPassAccessLog.create({
        data: {
          session_id: sessionId,
          patient_id: credencial.patientId,
          resource_accessed: 'medipass.vital',
        },
      });
    });

    // Después del commit: el acceso ya existe y quedó en la bitácora. El aviso
    // no puede frenar la ficha del médico, así que no espera ni tira (ENG-177).
    void this.inApp.notifyMediPassAccess(
      credencial.patientId,
      {
        sesionId: sessionId,
        consultante: dto.nombre,
        matricula: dto.matricula ?? null,
        origen: credencial.cardId ? 'TARJETA' : 'CODIGO',
      },
      ahora,
    );

    return {
      sesionId: sessionId,
      expiraEl: expiraEl.toISOString(),
      vital: applyScope(
        toVitalBlock(credencial.patient, ahora),
        resolveScope(credencial.patient.medipass_scope),
      ),
    };
  }

  /**
   * Qué abre el canje: el código rotativo vigente o la tarjeta activa
   * (ENG-176). Cualquier rechazo es el mismo 404 de `CODIGO_INVALIDO`, venga
   * por donde venga: distinguir "esa tarjeta se desactivó" de "nunca existió"
   * le diría a quien prueba tokens cuáles fueron reales.
   */
  private async resolveCredential(
    dto: OpenEmergencySessionDto,
    ahora: Date,
  ): Promise<{
    patientId: string;
    codeId: string | null;
    codeUsedAt: Date | null;
    cardId: string | null;
    patient: PatientVitalSource & { medipass_scope: unknown };
  }> {
    // El DTO valida cada campo por separado; que vengan los dos (o ninguno) es
    // un pedido mal armado, no un código inválido.
    if ((dto.codigo === undefined) === (dto.tarjeta === undefined)) {
      throw new BadRequestException(
        'Mandá el código del MediPass o la tarjeta de emergencia, uno de los dos.',
      );
    }

    if (dto.tarjeta !== undefined) {
      const card = await this.prisma.mediPassEmergencyCard.findFirst({
        where: { token_hash: hashCardToken(dto.tarjeta), revoked_at: null },
        select: {
          id: true,
          patient_id: true,
          patient: { select: { ...VITAL_SELECT, medipass_scope: true } },
        },
      });
      if (!card) throw new NotFoundException(CODIGO_INVALIDO);
      return {
        patientId: card.patient_id,
        codeId: null,
        codeUsedAt: null,
        cardId: card.id,
        patient: card.patient,
      };
    }

    const code = await this.prisma.mediPassCode.findFirst({
      where: { code: dto.codigo, expires_at: { gt: ahora } },
      orderBy: { expires_at: 'desc' },
      select: {
        id: true,
        patient_id: true,
        used_at: true,
        patient: { select: { ...VITAL_SELECT, medipass_scope: true } },
      },
    });
    // Mismo 404 para "no existe" y "venció" (ver CODIGO_INVALIDO).
    if (!code) throw new NotFoundException(CODIGO_INVALIDO);
    return {
      patientId: code.patient_id,
      codeId: code.id,
      codeUsedAt: code.used_at,
      cardId: null,
      patient: code.patient,
    };
  }

  /**
   * Si el paciente tiene una tarjeta de emergencia activa, y desde cuándo
   * (ENG-176). Nunca devuelve el token: solo existe su hash.
   */
  async getMyEmergencyCard(
    patientId: string,
  ): Promise<EmergencyCardStatusResponse> {
    await this.assertPatientExists(patientId);

    const card = await this.prisma.mediPassEmergencyCard.findFirst({
      where: { patient_id: patientId, revoked_at: null },
      select: { created_at: true },
    });

    return {
      activa: card !== null,
      creadaEl: card?.created_at.toISOString() ?? null,
    };
  }

  /**
   * Genera la tarjeta de emergencia, o una nueva si ya había una (ENG-176).
   *
   * ## Regenerar invalida la anterior, y corta lo que abrió
   *
   * Se regenera cuando la tarjeta se perdió o alguien la fotografió, así que la
   * anterior tiene que dejar de abrir fichas **en el mismo instante**, y los
   * accesos que se hayan abierto con ella también se cortan: si alguien la usó
   * antes de que el paciente se diera cuenta, seguiría adentro hasta que venza.
   * Los accesos abiertos con el código rotativo no se tocan.
   *
   * Todo en una transacción: no puede quedar un momento con dos tarjetas
   * válidas, ni uno sin ninguna si algo falla a mitad de camino. Si dos pedidos
   * llegan a la vez, el índice único parcial de la migración deja pasar uno
   * solo y el otro recibe 409.
   */
  async createMyEmergencyCard(
    patientId: string,
  ): Promise<EmergencyCardCreatedResponse> {
    await this.assertPatientExists(patientId);

    const tarjeta = randomBytes(CARD_TOKEN_BYTES).toString('base64url');
    const ahora = new Date();

    try {
      const creada = await this.prisma.$transaction(async (tx) => {
        await this.revokeActiveCard(tx, patientId, ahora);
        return tx.mediPassEmergencyCard.create({
          data: {
            patient_id: patientId,
            token_hash: hashCardToken(tarjeta),
            created_at: ahora,
          },
          select: { id: true, created_at: true },
        });
      });

      await this.auditCard(patientId, creada.id, 'MEDIPASS_CARD_CREATED');
      return { tarjeta, creadaEl: creada.created_at.toISOString() };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(
          'Ya se estaba generando una tarjeta. Recargá la página y probá de nuevo.',
        );
      }
      throw err;
    }
  }

  /**
   * Desactiva la tarjeta de emergencia (ENG-176). Idempotente, como cortar un
   * acceso: si no había ninguna activa, el resultado ya es el pedido.
   */
  async disableMyEmergencyCard(patientId: string): Promise<void> {
    await this.assertPatientExists(patientId);
    const ahora = new Date();
    const cardId = await this.prisma.$transaction((tx) =>
      this.revokeActiveCard(tx, patientId, ahora),
    );
    if (cardId) {
      await this.auditCard(patientId, cardId, 'MEDIPASS_CARD_DISABLED');
    }
  }

  /**
   * Marca la tarjeta activa como revocada y corta los accesos abiertos con
   * ella. Devuelve el id de la tarjeta, o `null` si no había ninguna.
   *
   * `updateMany` con `revoked_at: null` en el `where`, y no `update` por id:
   * si otro pedido la revocó entre la lectura y esto, `count` vuelve en 0 y no
   * se informa una revocación que hizo otro.
   */
  private async revokeActiveCard(
    tx: Pick<PrismaService, 'mediPassEmergencyCard' | 'mediPassSession'>,
    patientId: string,
    ahora: Date,
  ): Promise<string | null> {
    const activa = await tx.mediPassEmergencyCard.findFirst({
      where: { patient_id: patientId, revoked_at: null },
      select: { id: true },
    });
    if (!activa) return null;

    const { count } = await tx.mediPassEmergencyCard.updateMany({
      where: { id: activa.id, revoked_at: null },
      data: { revoked_at: ahora },
    });
    if (count === 0) return null;

    await tx.mediPassSession.updateMany({
      where: {
        emergency_card_id: activa.id,
        revoked_at: null,
        expires_at: { gt: ahora },
      },
      data: { revoked_at: ahora, revoked_by: patientId },
    });
    return activa.id;
  }

  /**
   * Deja constancia en `audit_logs` (ENG-87). Fuera de la transacción y sin
   * tirar: la tarjeta ya quedó generada o desactivada, y un fallo del log no
   * puede hacerle creer al paciente que no pasó.
   */
  private async auditCard(
    patientId: string,
    cardId: string,
    action: 'MEDIPASS_CARD_CREATED' | 'MEDIPASS_CARD_DISABLED',
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actor_id: patientId,
          action,
          resource_type: 'medipass_emergency_cards',
          resource_id: cardId,
        },
      });
    } catch (err) {
      this.logger.error(
        `No se pudo auditar ${action} de ${patientId}: ${String(err)}`,
      );
    }
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
        patient: { select: { ...VITAL_SELECT, medipass_scope: true } },
      },
    });

    if (!session) throw new NotFoundException(CODIGO_INVALIDO);

    const ahora = new Date();
    if (session.revoked_at || session.expires_at.getTime() <= ahora.getTime()) {
      throw new GoneException('El acceso venció o fue revocado.');
    }

    return {
      expiraEl: session.expires_at.toISOString(),
      // El scope se lee en cada refresco: un cambio del paciente llega a las
      // sesiones ya abiertas (ENG-149).
      vital: applyScope(
        toVitalBlock(session.patient, ahora),
        resolveScope(session.patient.medipass_scope),
      ),
    };
  }

  /**
   * Historial de accesos al MediPass del paciente (HU-38, ENG-76): quién lo
   * abrió, cuándo, si sigue abierto, si se cortó, y qué miró.
   *
   * Se agrupa por sesión y no se lista fila por fila de la bitácora: lo que el
   * paciente necesita saber es "el Dr. X entró el martes", y las vistas de esa
   * visita van adentro. Se pagina por sesión, de la más reciente a la más
   * vieja; el `id` desempata dos sesiones abiertas en el mismo instante para
   * que una página nunca repita ni saltee filas.
   *
   * Las lecturas de la historia clínica (`audit_logs`, `CLINICAL_RECORD_READ`)
   * no van acá: son de ENG-165.
   */
  async getMyHistory(
    patientId: string,
    pagina = 1,
    now: Date = new Date(),
  ): Promise<MediPassHistoryResponse> {
    await this.assertPatientExists(patientId);

    // Uno de más para saber si hay otra página sin un COUNT aparte.
    const rows = await this.prisma.mediPassSession.findMany({
      where: { patient_id: patientId },
      orderBy: [{ started_at: 'desc' }, { id: 'desc' }],
      skip: (pagina - 1) * HISTORY_PAGE_SIZE,
      take: HISTORY_PAGE_SIZE + 1,
      select: {
        id: true,
        consultant_name: true,
        consultant_license: true,
        emergency_card_id: true,
        started_at: true,
        expires_at: true,
        revoked_at: true,
        access_logs: {
          // La bitácora es del paciente; el filtro lo repite por si alguna vez
          // una sesión quedara mal asociada.
          where: { patient_id: patientId },
          orderBy: { accessed_at: 'asc' },
          select: { resource_accessed: true, accessed_at: true },
        },
      },
    });

    return {
      pagina,
      hayMas: rows.length > HISTORY_PAGE_SIZE,
      accesos: rows.slice(0, HISTORY_PAGE_SIZE).map((s) => ({
        sesionId: s.id,
        consultante: {
          nombre: s.consultant_name,
          matricula: s.consultant_license,
        },
        origen: s.emergency_card_id ? 'TARJETA' : 'CODIGO',
        inicio: s.started_at.toISOString(),
        vence: s.expires_at.toISOString(),
        revocadoEl: s.revoked_at?.toISOString() ?? null,
        estado: accessStatus(s, now),
        vistas: s.access_logs.map((log) => ({
          recurso: log.resource_accessed,
          etiqueta: resourceLabel(log.resource_accessed),
          el: log.accessed_at.toISOString(),
        })),
      })),
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

    if (!patient) throw this.perfilIncompleto();

    return patient;
  }

  private perfilIncompleto(): ConflictException {
    return new ConflictException(
      'Completá tu perfil para poder usar el MediPass.',
    );
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

/**
 * SHA-256 en hex del token de la tarjeta (ENG-176). Es lo único que se guarda:
 * con 256 bits de azar no hay diccionario contra el cual probar, así que un
 * hash rápido alcanza y no hace falta uno lento como el de una contraseña.
 */
export function hashCardToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
