import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** El administrador que entra al panel. */
export interface AdminProfile {
  id: string;
  email: string;
  role: 'ADMINISTRADOR';
}

/**
 * Lógica del panel del administrador (ENG-220). Por ahora solo identifica a
 * quién entra; la validación de matrículas (ENG-192), el listado y la
 * suspensión de profesionales (ENG-241) y el panel de plataforma (ENG-195) se
 * suman acá.
 */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async profile(userId: string): Promise<AdminProfile> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    // `RolesGuard` ya leyó el perfil: si desapareció en el medio, es un 404.
    if (!profile) {
      throw new NotFoundException('No se encontró el perfil del usuario.');
    }
    return { id: profile.id, email: profile.email, role: 'ADMINISTRADOR' };
  }
}
