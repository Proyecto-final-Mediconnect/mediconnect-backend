import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_CANCELLATION_POLICY,
  resolvePolicy,
  validatePolicy,
  type CancellationPolicy,
} from './cancellation-policy';
import { UpdateCancellationPolicyDto } from './dto/update-cancellation-policy.dto';

/**
 * Política de cancelación del profesional (ENG-67, HU-26).
 *
 * Solo el CRUD de la política. **Reembolsar no es de acá**: eso es ENG-65, que
 * usa `refundPercentFor()` de `cancellation-policy.ts` para saber cuánto
 * devolver. Esta historia va antes justamente para que esa función exista y
 * tenga de dónde leer los valores.
 *
 * Lee y escribe por Prisma y no por PostgREST con el JWT del profesional.
 * `cancellation_policies` no tiene `GRANT` para `authenticated` ni RLS —es una
 * de las 12 tablas que todavía no estrenó ninguna ruta—, y esta historia **no**
 * se los agrega: el perfil público de ENG-50 ya expone los datos del profesional
 * por Prisma, y la política viaja ahí. Abrir la tabla al cliente obligaría a
 * escribir políticas de RLS para un acceso que ningún flujo necesita.
 */
export interface CancellationPolicyView extends CancellationPolicy {
  /**
   * `false` cuando el profesional no configuró la suya y lo que viaja es el
   * default.
   *
   * La pantalla lo usa para distinguir "esto es lo que elegí" de "esto es lo que
   * se aplica mientras no elija nada", que para el profesional no es lo mismo.
   */
  configured: boolean;
}

const POLICY_SELECT = {
  hours_full_refund: true,
  hours_partial_refund: true,
  partial_refund_percent: true,
} as const;

@Injectable()
export class CancellationPolicyService {
  private readonly logger = new Logger(CancellationPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * La política del profesional, o el default si no configuró ninguna.
   *
   * **No crea la fila al leer.** Un `GET` que escribe deja filas de profesionales
   * que solo abrieron la pantalla, y entonces `configured` dejaría de distinguir
   * nada. La fila nace en el primer `PUT`, igual que la de `patients` nace en la
   * primera carga del perfil (ENG-47).
   */
  async getMyPolicy(professionalId: string): Promise<CancellationPolicyView> {
    await this.assertProfessionalExists(professionalId);

    const row = await this.prisma.cancellationPolicy.findUnique({
      where: { professional_id: professionalId },
      select: POLICY_SELECT,
    });

    const { policy, configured } = resolvePolicy(row);

    return { ...policy, configured };
  }

  /**
   * Reemplaza la política del profesional.
   *
   * `upsert` y no `update`: la primera vez la fila no existe, y pedirle al
   * profesional que "cree" su política antes de editarla sería una distinción que
   * solo tiene sentido del lado de la base.
   */
  async replaceMyPolicy(
    professionalId: string,
    dto: UpdateCancellationPolicyDto,
  ): Promise<CancellationPolicyView> {
    await this.assertProfessionalExists(professionalId);

    const policy: CancellationPolicy = {
      hoursFullRefund: dto.hoursFullRefund,
      hoursPartialRefund: dto.hoursPartialRefund,
      partialRefundPercent: dto.partialRefundPercent,
    };

    // Lo que un decorador por campo no puede ver: la relación entre los plazos.
    const problema = validatePolicy(policy);
    if (problema) throw new BadRequestException(problema);

    try {
      await this.prisma.cancellationPolicy.upsert({
        where: { professional_id: professionalId },
        create: {
          professional_id: professionalId,
          hours_full_refund: policy.hoursFullRefund,
          hours_partial_refund: policy.hoursPartialRefund,
          partial_refund_percent: policy.partialRefundPercent,
        },
        update: {
          hours_full_refund: policy.hoursFullRefund,
          hours_partial_refund: policy.hoursPartialRefund,
          partial_refund_percent: policy.partialRefundPercent,
          updated_at: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(
        `No se pudo guardar la política de cancelación de ${professionalId}: ${String(error)}`,
      );
      throw new InternalServerErrorException(
        'No pudimos guardar la política. Probá de nuevo en unos minutos.',
      );
    }

    return { ...policy, configured: true };
  }

  /**
   * La política de **otro** profesional, para el perfil público (ENG-50).
   *
   * Nunca devuelve `null`: si no la configuró, viaja el default. Un paciente que
   * está por reservar tiene que poder ver a qué atenerse, y "sin política" no es
   * una respuesta útil frente a un turno que va a pagar.
   */
  async policyFor(professionalId: string): Promise<CancellationPolicy> {
    const row = await this.prisma.cancellationPolicy.findUnique({
      where: { professional_id: professionalId },
      select: POLICY_SELECT,
    });

    return resolvePolicy(row).policy;
  }

  /**
   * La fila de `professionals` tiene que existir.
   *
   * Un paciente autenticado llegando a esta ruta no tiene fila, así que recibe un
   * 409 y nunca toca la política de nadie. No hay guard de roles en el proyecto y
   * este es el mismo mecanismo que usa `MediPassService` para sostener "solo
   * pacientes" en sus rutas.
   */
  private async assertProfessionalExists(
    professionalId: string,
  ): Promise<void> {
    const professional = await this.prisma.professional.findUnique({
      where: { profile_id: professionalId },
      select: { profile_id: true },
    });

    if (!professional) {
      throw new ConflictException(
        'Solo un profesional puede configurar la política de cancelación.',
      );
    }
  }
}

/** El default, reexportado para que la pantalla no importe el archivo puro. */
export { DEFAULT_CANCELLATION_POLICY };
