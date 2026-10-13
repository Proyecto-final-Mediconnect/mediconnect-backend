import { Injectable, NotFoundException } from '@nestjs/common';
import { LEGAL_VERSION } from '../legal/legal';
import { PrismaService } from '../prisma/prisma.service';
import { MeResponseDto } from './dto/me-response.dto';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Devuelve el perfil público del usuario cuyo `id` (= `payload.sub` del JWT,
   * = `auth.uid()` de RLS) se recibe. Lee desde `profiles` con Prisma: el rol y
   * el email salen de la base, no del token. `select` explícito para no filtrar
   * columnas sensibles/internas por accidente.
   */
  async getProfile(userId: string): Promise<MeResponseDto> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        patient: { select: { first_name: true, last_name: true } },
        professional: { select: { first_name: true, last_name: true } },
        legal_acceptances: {
          where: { version: LEGAL_VERSION },
          select: { id: true },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException('No se encontró el perfil del usuario.');
    }

    // El nombre vive en la fila de paciente o de profesional según el rol; un
    // MODERADOR (u otro perfil sin fila asociada) no tiene nombre → null.
    const named = profile.patient ?? profile.professional;

    return {
      id: profile.id,
      email: profile.email,
      role: profile.role,
      firstName: named?.first_name ?? null,
      lastName: named?.last_name ?? null,
      legalAccepted: profile.legal_acceptances.length > 0,
      legalVersion: LEGAL_VERSION,
    };
  }

  /**
   * Registra que el usuario aceptó la versión vigente de los textos legales
   * (ENG-140). Es el camino de quien ya tenía cuenta cuando se publicaron, o
   * cuando cambian: el registro ya deja la aceptación hecha.
   *
   * `version` llega validada por `AcceptLegalDto`: es la vigente.
   *
   * Idempotente: aceptar dos veces la misma versión no es un error, y la tabla es
   * append-only, así que no hay nada que pisar.
   */
  async acceptLegal(userId: string, version: string): Promise<MeResponseDto> {
    await this.prisma.legalAcceptance.createMany({
      data: [{ profile_id: userId, version }],
      skipDuplicates: true,
    });
    return this.getProfile(userId);
  }
}
