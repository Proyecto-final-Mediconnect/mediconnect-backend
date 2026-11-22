import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { renderNoticeEmail } from './appointment-emails';
import { EmailService } from './email.service';

/** Lo que el administrador decidió sobre la matrícula (ENG-192). */
export type LicenseDecisionNotice = 'VALIDADO' | 'RECHAZADO';

/**
 * Avisos al profesional sobre su cuenta, que decide el administrador (ENG-220):
 * la validación de la matrícula (ENG-192) y, después, la suspensión (ENG-241).
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
