import { ForbiddenException, Injectable } from '@nestjs/common';
import { professionalReadsOf } from '../clinical-records/clinical-record-accesses.service';
import { lastDays, resolvePeriod } from '../common/time/period';
import { PrismaService } from '../prisma/prisma.service';

/** El resumen del inicio del paciente (ENG-198). */
export interface PatientSummary {
  from: string;
  to: string;
  currency: string;
  consultas: { realizadas: number; profesionales: number };
  /**
   * `turnos`: cuántos turnos pagó en el período. `porVenir`: cuántos de esos
   * todavía no pasaron. Se paga al reservar, así que lo pagado incluye turnos
   * futuros que todavía no son consultas realizadas.
   */
  pagos: {
    pagado: number;
    reembolsado: number;
    neto: number;
    turnos: number;
    porVenir: number;
  };
  accesos: { medipass: number; historiaClinica: number; total: number };
}

/** Período por defecto: los últimos 30 días. */
export const SUMMARY_DEFAULT_DAYS = 30;

/**
 * Resumen del paciente (ENG-198): consultas, lo que pagó y quién accedió a su
 * información en el período. Parte de la reportería que pidió la cátedra.
 *
 * - **Consultas realizadas**: turnos `COMPLETADO` con fecha en el período, y
 *   cuántos profesionales distintos.
 * - **Pagos**: el mismo criterio que "Mis cobros" del profesional (ENG-194),
 *   del otro lado: pagos acreditados en el período, menos los reembolsos ya
 *   procesados de esos pagos. Se paga al reservar, así que incluye turnos que
 *   todavía no pasaron: por eso se informan aparte (`porVenir`), para que no
 *   parezca que no cierra con las consultas realizadas.
 * - **Accesos**: sesiones del MediPass abiertas en el período y lecturas de la
 *   HC por profesionales, con el mismo filtro que el historial de accesos
 *   (`professionalReadsOf`): sus propias lecturas no cuentan.
 *
 * Todo filtra por el id del JWT: no hay forma de pedir el de otro paciente.
 */
@Injectable()
export class PatientSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    patientId: string,
    query: { from?: string; to?: string },
    now: Date = new Date(),
  ): Promise<PatientSummary> {
    const period = resolvePeriod(
      query.from,
      query.to,
      lastDays(SUMMARY_DEFAULT_DAYS, now),
    );
    const patient = await this.prisma.patient.findUnique({
      where: { profile_id: patientId },
      select: { profile_id: true },
    });
    if (!patient) {
      throw new ForbiddenException('El resumen es solo para pacientes.');
    }
    const enPeriodo = { gte: period.start, lt: period.end };

    const [completados, pagos, medipass, historiaClinica] = await Promise.all([
      this.prisma.appointment.findMany({
        where: {
          patient_id: patientId,
          status: 'COMPLETADO',
          scheduled_at: enPeriodo,
        },
        select: { professional_id: true },
      }),
      this.prisma.payment.findMany({
        where: {
          status: { in: ['APROBADO', 'REEMBOLSADO'] },
          confirmed_at: enPeriodo,
          appointment: { patient_id: patientId },
        },
        select: {
          amount: true,
          appointment: { select: { status: true, scheduled_at: true } },
          refunds: { where: { status: 'PROCESADO' }, select: { amount: true } },
        },
      }),
      this.prisma.mediPassSession.count({
        where: { patient_id: patientId, started_at: enPeriodo },
      }),
      this.prisma.auditLog.count({
        where: { ...professionalReadsOf(patientId), created_at: enPeriodo },
      }),
    ]);

    // En centavos, por el mismo motivo que en "Mis cobros".
    const cents = (v: { toString(): string }) => Math.round(Number(v) * 100);
    const pagado = pagos.reduce((t, p) => t + cents(p.amount), 0);
    const reembolsado = pagos.reduce(
      (t, p) => t + p.refunds.reduce((r, ref) => r + cents(ref.amount), 0),
      0,
    );

    return {
      from: period.from,
      to: period.to,
      currency: 'ARS',
      consultas: {
        realizadas: completados.length,
        profesionales: new Set(completados.map((a) => a.professional_id)).size,
      },
      pagos: {
        pagado: pagado / 100,
        reembolsado: reembolsado / 100,
        neto: (pagado - reembolsado) / 100,
        turnos: pagos.length,
        porVenir: pagos.filter(
          (p) =>
            p.appointment.status === 'CONFIRMADO' &&
            p.appointment.scheduled_at > now,
        ).length,
      },
      accesos: { medipass, historiaClinica, total: medipass + historiaClinica },
    };
  }
}
