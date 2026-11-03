import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PreferencesResponse {
  recordatoriosPorEmail: boolean;
}

/**
 * Derecho de oposición (ENG-86, Ley 25.326 art. 27).
 *
 * El único tratamiento de MediConnect que no es imprescindible para el servicio
 * es el recordatorio por email a 24 h y 1 h del turno, así que eso es lo que se
 * puede apagar. La confirmación de la reserva sigue saliendo: es el comprobante
 * de lo que se contrató. Para oponerse a todo lo demás, el camino es la baja
 * (`DELETE /me`), porque sin tratar los datos de salud no hay servicio que dar.
 */
@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<PreferencesResponse> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { email_reminders: true, deleted_at: true },
    });
    if (!profile || profile.deleted_at) {
      throw new NotFoundException('No encontramos tu cuenta.');
    }
    return { recordatoriosPorEmail: profile.email_reminders };
  }

  async update(
    userId: string,
    recordatoriosPorEmail: boolean,
  ): Promise<PreferencesResponse> {
    const { count } = await this.prisma.profile.updateMany({
      where: { id: userId, deleted_at: null },
      data: { email_reminders: recordatoriosPorEmail },
    });
    if (count === 0) throw new NotFoundException('No encontramos tu cuenta.');
    return { recordatoriosPorEmail };
  }
}
