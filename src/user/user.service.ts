import { Injectable, NotFoundException } from '@nestjs/common';
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
    };
  }
}
