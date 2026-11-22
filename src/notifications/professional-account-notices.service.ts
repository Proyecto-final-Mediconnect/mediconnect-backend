import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { renderNoticeEmail } from './appointment-emails';
import { EmailService } from './email.service';

/** Lo que el administrador decidió sobre la matrícula (ENG-192). */
export type LicenseDecisionNotice = 'VALIDADO' | 'RECHAZADO';

/**
 * Avisos al profesional sobre su cuenta, que decide el administrador (ENG-220):
 * la validación de la matrícula (ENG-192) y la suspensión y reactivación
 * (ENG-241).
 *
 * Van por mail, que es lo que el profesional mira cuando todavía no puede
 * atender. Son **best-effort**: la decisión ya quedó escrita y auditada, así que
 * un mail que no sale se loguea y no la deshace. Sin Resend configurado no se
 * manda nada.
 */
@Injectable()
export class ProfessionalAccountNoticesService {
  private readonly logger = new Logger(ProfessionalAccountNoticesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /** Le avisa al profesional que su matrícula se validó o se rechazó. */
  async licenseDecided(
    professionalId: string,
    decision: LicenseDecisionNotice,
    reason: string | null,
  ): Promise<void> {
    if (!this.email.isConfigured()) return;
    try {
      const professional = await this.prisma.professional.findUnique({
        where: { profile_id: professionalId },
        select: { first_name: true, profile: { select: { email: true } } },
      });
      if (!professional) return;

      const greeting = professional.first_name
        ? `Hola, ${professional.first_name}:`
        : 'Hola:';
      const rendered =
        decision === 'VALIDADO'
          ? renderNoticeEmail({
              greeting,
              title: 'Tu matrícula fue validada',
              body: 'Revisamos tu matrícula y ya aparecés en el catálogo de MediConnect. Para que los pacientes te puedan reservar, revisá que tu perfil tenga precio y tu agenda tenga horarios.',
              url: this.webUrl('/profesional'),
              label: 'Ir a mi panel',
            })
          : renderNoticeEmail({
              greeting,
              title: 'No pudimos validar tu matrícula',
              body: `Revisamos tu matrícula y no la pudimos validar. Motivo: ${reason ?? 'sin detalle'}. Mientras tanto tu perfil no aparece en el catálogo. Si creés que hay un error, comunicate con el equipo de MediConnect.`,
              url: null,
              label: '',
            });

      await this.email.send({
        to: professional.profile.email,
        ...rendered,
        // Una decisión por profesional: si el envío se reintenta, no llega dos veces.
        idempotencyKey: `license:${professionalId}:${decision}`,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar la decisión de matrícula a ${professionalId}: ${String(error)}`,
      );
    }
  }

  /**
   * Le avisa al profesional que el administrador lo suspendió (ENG-241), con
   * el motivo y qué pasó con sus turnos.
   */
  async suspended(
    professionalId: string,
    reason: string,
    turnos: { refunded: number; cancelled: number },
    now: Date,
  ): Promise<void> {
    const total = turnos.refunded + turnos.cancelled;
    // Una clave por suspensión: si se suspende otra vez después de reactivarlo,
    // es otro aviso.
    await this.sendTo(
      professionalId,
      `suspended:${professionalId}:${now.toISOString()}`,
      (greeting) =>
        renderNoticeEmail({
          greeting,
          title: 'Suspendimos tu cuenta de MediConnect',
          body: `Suspendimos tu cuenta. Motivo: ${reason}. Mientras esté suspendida no aparecés en el catálogo y no podés recibir turnos.${
            total > 0
              ? ` Cancelamos tus ${total === 1 ? 'turno pendiente' : `${total} turnos pendientes`} y les avisamos a los pacientes; a los que ya habían pagado les devolvemos el 100 %.`
              : ''
          } Si creés que hay un error, comunicate con el equipo de MediConnect.`,
          url: null,
          label: '',
        }),
    );
  }

  /** Le avisa al profesional que el administrador lo reactivó (ENG-241). */
  async reactivated(professionalId: string, now: Date): Promise<void> {
    await this.sendTo(
      professionalId,
      `reactivated:${professionalId}:${now.toISOString()}`,
      (greeting) =>
        renderNoticeEmail({
          greeting,
          title: 'Reactivamos tu cuenta de MediConnect',
          body: 'Tu cuenta está activa otra vez: volvés a aparecer en el catálogo y los pacientes te pueden reservar. Revisá que tu agenda tenga horarios.',
          url: this.webUrl('/profesional/agenda'),
          label: 'Ir a mi agenda',
        }),
    );
  }

  /** Arma el saludo, manda el mail y loguea si falla. Nunca tira. */
  private async sendTo(
    professionalId: string,
    idempotencyKey: string,
    render: (greeting: string) => ReturnType<typeof renderNoticeEmail>,
  ): Promise<void> {
    if (!this.email.isConfigured()) return;
    try {
      const professional = await this.prisma.professional.findUnique({
        where: { profile_id: professionalId },
        select: { first_name: true, profile: { select: { email: true } } },
      });
      if (!professional) return;
      const greeting = professional.first_name
        ? `Hola, ${professional.first_name}:`
        : 'Hola:';
      await this.email.send({
        to: professional.profile.email,
        ...render(greeting),
        idempotencyKey,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo mandar el aviso de cuenta a ${professionalId}: ${String(error)}`,
      );
    }
  }

  /** Una ruta de la web, o `null` si `WEB_ORIGIN` no es una URL única. */
  private webUrl(path: string): string | null {
    const configured = this.config.get<string>('WEB_ORIGIN');
    if (!configured || configured.includes(',')) return null;
    try {
      return `${new URL(configured).origin}${path}`;
    } catch {
      return null;
    }
  }
}
