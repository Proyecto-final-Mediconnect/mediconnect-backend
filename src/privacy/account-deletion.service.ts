import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PATIENT_DOCUMENTS_BUCKET } from '../clinical-records/patient-documents.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';

/** Turnos que todavía pueden pasar: con uno de estos no se da de baja. */
const PENDIENTES = ['RESERVADO_SIN_PAGAR', 'CONFIRMADO'] as const;

/** El email que queda en la cuenta dada de baja. `.invalid` es reservado (RFC 2606). */
export function emailDeBaja(userId: string): string {
  return `baja+${userId}@mediconnect.invalid`;
}

/** Cuánto dura el bloqueo del usuario en Supabase Auth: en la práctica, siempre. */
const BAN_DURATION = '876000h';

/**
 * Derecho de supresión (ENG-86, Ley 25.326 art. 16): dar de baja la cuenta.
 *
 * ## Por qué anonimiza y no borra
 *
 * Borrar la fila de `profiles` no es posible ni correcto, y es la decisión D1:
 *
 * - **La historia clínica se conserva 10 años** desde la última atención
 *   (Ley 26.529 art. 18), aunque el paciente cierre la cuenta. Es append-only
 *   por trigger y su FK al paciente es RESTRICT. Para que siga siendo la
 *   historia de *alguien*, se quedan el nombre, el apellido, el DNI y la fecha
 *   de nacimiento del paciente. Del profesional se quedan el nombre y la
 *   matrícula, que son la firma de las entradas que asentó.
 * - **La constancia del consentimiento** (`legal_acceptances`) es la prueba de
 *   que esa persona autorizó el tratamiento de sus datos de salud: append-only
 *   y RESTRICT por lo mismo.
 * - Los **pagos y reembolsos** son registros contables.
 *
 * Todo lo demás se suprime: el contacto (email, teléfono, domicilio), los
 * datos de emergencia del MediPass y sus credenciales, las reseñas escritas,
 * los avisos, los dispositivos, los documentos aportados (que no son HC), y la
 * agenda y el perfil público del profesional. El acceso se cierra en Supabase
 * Auth: el usuario queda bloqueado y sin sesiones.
 *
 * ## Por qué no con turnos pendientes
 *
 * Un turno pagado tiene plata en juego: cancelarlo dispara un reembolso con la
 * política del profesional (ENG-65), y esa decisión es de la persona, no de una
 * baja automática. Así que primero los cancela y después da de baja.
 *
 * ## Orden e idempotencia
 *
 * Primero la base, en una transacción, y después Supabase Auth. Si Supabase
 * falla, los datos ya quedaron suprimidos y el pedido devuelve 500: volver a
 * pedirlo saltea la base (ya tiene `deleted_at`) y reintenta solo el bloqueo.
 * Al revés, un bloqueo exitoso con la base fallando dejaría a la persona
 * afuera de su cuenta y con todos sus datos adentro, sin forma de reintentar.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
  ) {}

  async deleteMyAccount(
    userId: string,
    accessToken: string,
    now: Date = new Date(),
  ): Promise<void> {
    // Sin la service role no se puede cerrar el acceso: mejor no tocar nada
    // que dejar los datos suprimidos con la cuenta abierta.
    let admin: ReturnType<SupabaseService['getServiceClient']>;
    try {
      admin = this.supabase.getServiceClient();
    } catch {
      throw new ServiceUnavailableException(
        'La baja de cuentas no está disponible en este momento. Escribinos y la hacemos a mano.',
      );
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { role: true, deleted_at: true },
    });
    if (!profile) return;

    let paths: string[] = [];
    if (!profile.deleted_at) {
      const pendientes = await this.prisma.appointment.count({
        where: {
          OR: [{ patient_id: userId }, { professional_id: userId }],
          status: { in: [...PENDIENTES] },
          scheduled_at: { gt: now },
        },
      });
      if (pendientes > 0) {
        throw new ConflictException(
          pendientes === 1
            ? 'Tenés un turno pendiente. Cancelalo antes de dar de baja la cuenta.'
            : `Tenés ${pendientes} turnos pendientes. Cancelalos antes de dar de baja la cuenta.`,
        );
      }
      paths = await this.suprimirDatos(userId, profile.role, now);
    }

    await this.cerrarAcceso(admin, userId, accessToken);

    // Los archivos al final y sin tirar: la fila ya quedó retirada, y un
    // archivo huérfano en un bucket privado no se puede leer sin una URL
    // firmada que ya nadie puede pedir.
    if (paths.length > 0) {
      const { error } = await admin.storage
        .from(PATIENT_DOCUMENTS_BUCKET)
        .remove(paths);
      if (error) {
        this.logger.error(
          `Baja de ${userId}: no se pudieron borrar ${paths.length} archivos: ${error.message}`,
        );
      }
    }
  }

  /** Todo lo que se suprime en la base, en una transacción. Devuelve los archivos a borrar. */
  private async suprimirDatos(
    userId: string,
    role: string,
    now: Date,
  ): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.profile.update({
        where: { id: userId },
        data: {
          email: emailDeBaja(userId),
          deleted_at: now,
          email_reminders: false,
          mfa_enabled: false,
        },
      });

      // Avisos in-app y dispositivos. Las filas de EMAIL quedan: no tienen el
      // destinatario y son lo que evita reenviar un aviso de un turno viejo.
      await tx.notification.deleteMany({
        where: { user_id: userId, channel: { not: 'EMAIL' } },
      });
      await tx.pushToken.deleteMany({ where: { user_id: userId } });

      let paths: string[] = [];

      if (role === 'PACIENTE') {
        await tx.patient.updateMany({
          where: { profile_id: userId },
          data: {
            phone: null,
            address: null,
            sex: null,
            blood_type: null,
            // `DbNull` y no `null`: en un jsonb, `null` sería el valor JSON
            // `null` guardado, no la columna vacía.
            allergies: Prisma.DbNull,
            medications: Prisma.DbNull,
            conditions: Prisma.DbNull,
            emergency_contact: Prisma.DbNull,
            medipass_scope: Prisma.DbNull,
          },
        });

        // El MediPass deja de abrir: códigos vencidos, tarjeta revocada y los
        // accesos abiertos, cortados.
        await tx.mediPassCode.updateMany({
          where: { patient_id: userId, expires_at: { gt: now } },
          data: { expires_at: now },
        });
        await tx.mediPassEmergencyCard.updateMany({
          where: { patient_id: userId, revoked_at: null },
          data: { revoked_at: now },
        });
        await tx.mediPassSession.updateMany({
          where: {
            patient_id: userId,
            revoked_at: null,
            expires_at: { gt: now },
          },
          data: { revoked_at: now, revoked_by: userId },
        });

        // Sus opiniones son datos suyos y nada obliga a conservarlas.
        await tx.review.deleteMany({ where: { patient_id: userId } });

        // Lo que aportó no es HC: se retira y el archivo se borra después.
        const docs = await tx.patientDocument.findMany({
          where: { patient_id: userId, withdrawn_at: null },
          select: { storage_path: true },
        });
        await tx.patientDocument.updateMany({
          where: { patient_id: userId, withdrawn_at: null },
          data: { withdrawn_at: now },
        });
        paths = docs.map((d) => d.storage_path);

        await tx.conversation.updateMany({
          where: { patient_id: userId },
          data: { patient_hidden_at: now },
        });
      }

      if (role === 'PROFESIONAL') {
        // Fuera del catálogo y sin agenda: nadie le puede reservar.
        await tx.professional.updateMany({
          where: { profile_id: userId },
          data: {
            status: 'SUSPENDIDO',
            bio: null,
            photo_url: null,
            consultation_price: null,
            mercadopago_account_id: null,
          },
        });
        await tx.scheduleRule.deleteMany({
          where: { professional_id: userId },
        });
        await tx.scheduleBlock.deleteMany({
          where: { professional_id: userId },
        });
        await tx.conversation.updateMany({
          where: { professional_id: userId },
          data: { professional_hidden_at: now },
        });
      }

      await tx.auditLog.create({
        data: {
          actor_id: userId,
          action: 'ARCO_ACCOUNT_DELETED',
          resource_type: 'profiles',
          resource_id: userId,
          metadata: { role },
        },
      });

      return paths;
    });
  }

  /**
   * Bloquea al usuario en Supabase Auth, le cambia el email y cierra todas sus
   * sesiones. El access token que tenga encima vence solo (como mucho en una
   * hora) y para entonces ya no hay nada suyo que leer.
   */
  private async cerrarAcceso(
    admin: ReturnType<SupabaseService['getServiceClient']>,
    userId: string,
    accessToken: string,
  ): Promise<void> {
    const { error } = await admin.auth.admin.updateUserById(userId, {
      email: emailDeBaja(userId),
      // Sin esto Supabase manda un mail de confirmación al email nuevo.
      email_confirm: true,
      ban_duration: BAN_DURATION,
      user_metadata: {},
    });
    if (error) {
      this.logger.error(
        `Baja de ${userId}: Supabase no bloqueó al usuario: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Tus datos ya se borraron, pero no pudimos cerrar tu acceso. Probá de nuevo en unos minutos.',
      );
    }

    // Que una sesión abierta en otro dispositivo no pueda renovarse.
    const { error: signOutError } = await admin.auth.admin.signOut(
      accessToken,
      'global',
    );
    if (signOutError) {
      this.logger.warn(
        `Baja de ${userId}: no se cerraron las sesiones: ${signOutError.message}`,
      );
    }
  }
}
