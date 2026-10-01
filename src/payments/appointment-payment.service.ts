import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { MercadoPagoService } from './mercadopago.service';

/**
 * Cobro del turno con MercadoPago Checkout Pro (ENG-63).
 *
 * Devuelve el link de pago de un turno reservado. Lo que pasa **después** del
 * pago no es de acá: confirmar el turno es ENG-64 (webhook), liberarlo si no se
 * paga es ENG-101 y devolver la plata al cancelar es ENG-65.
 *
 * ## Por qué esto no vive dentro de `book()`
 *
 * Reservar y pagar son dos operaciones con dueños distintos. Si crear la
 * preferencia fuera parte de la reserva, una caída de MercadoPago haría fallar
 * la reserva entera — y de las dos cosas, la que no se puede perder es el turno:
 * el horario queda tomado y el paciente puede reintentar el pago. Separarlas
 * también es lo que deja que ENG-101 libere el turno sin tener que deshacer nada
 * del lado del cobro.
 *
 * ## El contrato con ENG-64
 *
 * `external_reference` es **el id del turno**, y es lo único que ata la
 * notificación con la reserva: el webhook recibe un `payment_id` y busca el
 * `Payment` por `appointment_id` con ese valor. Si acá se mandara otra cosa, el
 * webhook loguearía "pago sin Payment asociado" y el turno no se confirmaría
 * nunca, con la plata ya cobrada. Es el punto de acople de toda la épica.
 */

/** Lo que el front necesita para mandar al paciente a pagar. */
export interface CheckoutLink {
  appointmentId: string;
  /** URL del Checkout Pro a la que hay que redirigir. */
  checkoutUrl: string;
  /** `true` si se está operando contra credenciales de prueba. La web lo usa
   *  para mostrar un aviso y que nadie crea que cobró de verdad. */
  sandbox: boolean;
  amount: number;
  currency: string;
  status: string;
}

/** Fila de `appointments` que necesita este flujo. */
interface AppointmentRow {
  id: string;
  patient_id: string;
  professional_id: string;
  price: string | number;
  status: string;
}

const APPOINTMENT_SELECT = 'id, patient_id, professional_id, price, status';

/**
 * Estados del turno que admiten pago.
 *
 * Solo `RESERVADO_SIN_PAGAR`. `CONFIRMADO` ya está pago —volver a cobrarlo sería
 * cobrar dos veces— y el resto son turnos muertos.
 */
const PAYABLE_APPOINTMENT_STATUS = 'RESERVADO_SIN_PAGAR';

/** Estados del pago que ya cerraron el intento con plata adentro. */
const SETTLED_PAYMENT_STATUSES = ['APROBADO', 'REEMBOLSADO'];

@Injectable()
export class AppointmentPaymentService {
  private readonly logger = new Logger(AppointmentPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly mercadopago: MercadoPagoService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Crea (o recupera) el link de pago del turno.
   *
   * Es **idempotente de punta a punta**: la fila de `payments` se busca antes de
   * crearla y la preferencia se pide con el id del turno como clave de
   * idempotencia, así que pedir el link dos veces —doble click, volver atrás en
   * el navegador, reintentar tras un error de red— devuelve el mismo checkout y
   * nunca genera un segundo cobro.
   */
  async createCheckout(
    accessToken: string,
    userId: string,
    appointmentId: string,
  ): Promise<CheckoutLink> {
    if (!this.mercadopago.isConfigured()) {
      throw new ServiceUnavailableException(
        'Los pagos no están disponibles en este momento. Probá de nuevo más tarde.',
      );
    }

    const appointment = await this.readAppointment(accessToken, appointmentId);

    // Solo el paciente paga. El profesional ve el turno (la policy de SELECT
    // cubre los dos roles) pero no tiene nada que pagar.
    if (appointment.patient_id !== userId) {
      throw new ForbiddenException('Solo el paciente puede pagar este turno.');
    }

    if (appointment.status !== PAYABLE_APPOINTMENT_STATUS) {
      throw new ConflictException(
        appointment.status === 'CONFIRMADO'
          ? 'Ese turno ya está pago.'
          : 'Ese turno ya no está activo, así que no se puede pagar.',
      );
    }

    const { amount, currency, professionalName } =
      await this.readChargeDetails(appointment);

    const existing = await this.prisma.payment.findUnique({
      where: { appointment_id: appointment.id },
      select: { id: true, status: true },
    });

    if (existing && SETTLED_PAYMENT_STATUSES.includes(existing.status)) {
      // Defensa en profundidad: el estado del turno ya debería haberlo frenado,
      // pero si quedaron desincronizados, la que manda es la fila del pago.
      throw new ConflictException('Ese turno ya tiene un pago registrado.');
    }

    const preference = await this.mercadopago.createPreference({
      // EL contrato con ENG-64. No tocar sin cambiar el webhook.
      externalReference: appointment.id,
      notificationUrl: this.notificationUrl(),
      item: {
        title: `Consulta con ${professionalName}`,
        quantity: 1,
        unitPrice: amount,
        currencyId: currency,
      },
      backUrls: this.backUrls(appointment.id),
      // Mismo turno ⇒ misma preferencia. Es lo que impide que un doble click
      // genere dos checkouts para el mismo horario.
      idempotencyKey: appointment.id,
    });

    // El monto se guarda ACÁ y no se vuelve a calcular: el webhook de ENG-64
    // compara lo que MercadoPago cobró contra esta fila. Si quedara en cero o
    // desactualizado, un pago legítimo se rechazaría —o peor, uno por menos
    // plata se aceptaría.
    const payment = await this.prisma.payment.upsert({
      where: { appointment_id: appointment.id },
      create: {
        appointment_id: appointment.id,
        amount,
        currency,
        status: 'PENDIENTE',
        mercadopago_preference_id: preference.id,
      },
      update: { mercadopago_preference_id: preference.id },
      select: { status: true, amount: true, currency: true },
    });

    const sandbox = this.mercadopago.isSandbox();

    return {
      appointmentId: appointment.id,
      // En sandbox hay que usar el `sandbox_init_point`: el `init_point` de
      // producción con un token de prueba muestra un checkout que no se puede
      // completar.
      checkoutUrl: sandbox ? preference.sandboxInitPoint : preference.initPoint,
      sandbox,
      amount: Number(payment.amount),
      currency: payment.currency,
      status: payment.status,
    };
  }

  /**
   * Estado del pago de un turno, para que la pantalla de vuelta pueda decir algo
   * cierto.
   *
   * La vuelta del `back_url` **no confirma nada**: la dispara el navegador del
   * pagador y es trivial de falsificar. Quien mueve el estado es el webhook, y
   * esto solo lee lo que el webhook ya escribió. Puede devolver `PENDIENTE`
   * aunque el pago haya salido bien: MercadoPago redirige antes de notificar.
   */
  async readStatus(
    accessToken: string,
    userId: string,
    appointmentId: string,
  ): Promise<{
    appointmentId: string;
    status: string;
    appointmentStatus: string;
  }> {
    const appointment = await this.readAppointment(accessToken, appointmentId);

    if (appointment.patient_id !== userId) {
      throw new ForbiddenException('Solo el paciente puede ver este pago.');
    }

    const payment = await this.prisma.payment.findUnique({
      where: { appointment_id: appointment.id },
      select: { status: true },
    });

    return {
      appointmentId: appointment.id,
      // Sin fila todavía es "no empezó", no un error: el paciente puede abrir la
      // pantalla de pago sin haber generado el link.
      status: payment?.status ?? 'SIN_INICIAR',
      appointmentStatus: appointment.status,
    };
  }

  /**
   * Lee el turno con el JWT del usuario: la autorización es RLS
   * (`appointments_select_own`). Un turno ajeno simplemente no vuelve, y la
   * respuesta es 404 — un 403 confirmaría que ese id existe.
   */
  private async readAppointment(
    accessToken: string,
    appointmentId: string,
  ): Promise<AppointmentRow> {
    const client = this.supabase.getClientForToken(accessToken);

    const { data, error } = await client
      .from('appointments')
      .select(APPOINTMENT_SELECT)
      .eq('id', appointmentId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos procesar el pago. Probá de nuevo en unos minutos.',
      );
    }
    if (!data) {
      throw new NotFoundException('Ese turno no existe.');
    }

    return data as unknown as AppointmentRow;
  }

  /**
   * Monto, moneda y nombre del profesional.
   *
   * El monto sale del turno y no del perfil del profesional: ENG-54 lo congela
   * en `appointments.price` al reservar, justamente para que un cambio de precio
   * posterior no altere lo que el paciente aceptó pagar.
   *
   * La moneda y el nombre sí salen del profesional —`appointments` no tiene
   * columna de moneda— y se leen por Prisma porque RLS no deja a un paciente
   * leer la fila de `professionals`.
   */
  private async readChargeDetails(appointment: AppointmentRow): Promise<{
    amount: number;
    currency: string;
    professionalName: string;
  }> {
    const professional = await this.prisma.professional.findUnique({
      where: { profile_id: appointment.professional_id },
      select: { first_name: true, last_name: true, currency: true },
    });

    const amount = Number(appointment.price);

    if (!Number.isFinite(amount) || amount <= 0) {
      // Un turno con precio cero o ilegible no se cobra: mandar eso a
      // MercadoPago da un error del proveedor que no dice nada útil.
      this.logger.error(
        `Turno ${appointment.id} con precio no cobrable: ${String(appointment.price)}`,
      );
      throw new ConflictException(
        'Ese turno no tiene un precio válido. Avisale al profesional.',
      );
    }

    return {
      amount,
      currency: professional?.currency ?? 'ARS',
      professionalName: professional
        ? `${professional.first_name} ${professional.last_name}`
        : 'profesional',
    };
  }

  /** Adónde MercadoPago manda el webhook de ENG-64. */
  private notificationUrl(): string {
    const url = this.config.get<string>('MERCADOPAGO_NOTIFICATION_URL');

    if (!url) {
      // Sin esto el pago se cobraría y el turno nunca se confirmaría, porque la
      // notificación no llegaría a ningún lado. Es preferible no cobrar.
      throw new ServiceUnavailableException(
        'Los pagos no están disponibles en este momento. Probá de nuevo más tarde.',
      );
    }

    return url;
  }

  /**
   * Adónde vuelve el navegador después de pagar.
   *
   * Las tres apuntan a la misma pantalla con un query param distinto: el
   * resultado real se lee del backend, así que la pantalla solo necesita saber
   * qué contarle al paciente mientras tanto.
   */
  private backUrls(appointmentId: string): {
    success: string;
    failure: string;
    pending: string;
  } {
    const web =
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:5173';
    const base = `${web}/turnos/${appointmentId}/pago`;

    return {
      success: `${base}?resultado=exito`,
      failure: `${base}?resultado=fallo`,
      pending: `${base}?resultado=pendiente`,
    };
  }
}
