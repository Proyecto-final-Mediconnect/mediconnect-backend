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
import { holdExpiresAt } from '../appointments/unpaid-hold';
import type { CheckoutOrigin } from './dto/create-checkout.dto';
import {
  MercadoPagoApiError,
  MercadoPagoService,
  Preference,
} from './mercadopago.service';

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
 *
 * ## Por qué la preferencia vence
 *
 * Un link de Checkout Pro sigue cobrable mientras no venza, aunque el turno ya
 * no se pueda confirmar: el paciente cancela y paga desde la pestaña que le
 * quedó abierta, o el turno pasa y el link sigue vivo. En esos casos el webhook
 * marca el pago `APROBADO` y contesta `turno-no-confirmable`: se cobra sin dar
 * nada a cambio, y hasta ENG-65 no hay reembolso automático. Por eso la
 * preferencia vence a los {@link PREFERENCE_TTL_MS}, al empezar el turno o al
 * vencer la retención de la reserva (ENG-101), lo que llegue antes. Tampoco
 * acepta efectivo ni pagos pendientes, y se vence a mano al cancelar o al
 * liberar el turno ({@link AppointmentPaymentService.expireCheckout}).
 *
 * Lo que esto **no** cubre: una misma preferencia acepta más de un pago (dos
 * pestañas, dos tarjetas). Si se aprueban dos, el webhook toma el segundo como
 * `ya-procesado` y esa plata hay que devolverla a mano. Detectarlo y
 * reembolsarlo queda para ENG-65.
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
  scheduled_at: string;
  created_at: string;
}

const APPOINTMENT_SELECT =
  'id, patient_id, professional_id, price, status, scheduled_at, created_at';

/**
 * Cuánto vive como máximo un link de pago, contado desde que se pide.
 *
 * Además nunca vive más que la retención de la reserva (`holdExpiresAt`,
 * ENG-101): un link pedido al minuto 14 de la reserva vence al 15, no al 29. Si
 * viviera más, el paciente podría pagar un turno que el job ya liberó.
 */
export const PREFERENCE_TTL_MS = 15 * 60 * 1000;

/**
 * Margen mínimo de vida que tiene que tener una preferencia guardada para
 * reutilizarla. Mandar al paciente a un checkout que vence mientras carga la
 * tarjeta es peor que crearle uno nuevo.
 */
const REUSE_MIN_REMAINING_MS = 2 * 60 * 1000;

/**
 * Estados del turno que admiten pago.
 *
 * Solo `RESERVADO_SIN_PAGAR`. `CONFIRMADO` ya está pago —volver a cobrarlo sería
 * cobrar dos veces— y el resto son turnos muertos.
 */
const PAYABLE_APPOINTMENT_STATUS = 'RESERVADO_SIN_PAGAR';

/**
 * Esquema de la app mobile (`scheme` en el `app.json` de mediconnect-mobile).
 * MercadoPago lo acepta en los `back_urls` con `auto_return`: al aprobarse el
 * pago el navegador abre la app y se cierra solo (ENG-172).
 */
const APP_SCHEME = 'mediconnect';

/** Estados del pago que ya cerraron el intento con plata adentro. */
const SETTLED_PAYMENT_STATUSES: ('APROBADO' | 'REEMBOLSADO')[] = [
  'APROBADO',
  'REEMBOLSADO',
];

/** Estados del pago con una preferencia que todavía se podría cobrar. */
const OPEN_PAYMENT_STATUSES: ('PENDIENTE' | 'RECHAZADO')[] = [
  'PENDIENTE',
  'RECHAZADO',
];

/** Código de Prisma para violación de unicidad. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

const PAYMENTS_UNAVAILABLE =
  'Los pagos no están disponibles en este momento. Probá de nuevo más tarde.';

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
   * Pedir el link dos veces —doble click, volver atrás en el navegador,
   * reintentar tras un error de red— devuelve **la misma preferencia** mientras
   * siga vigente: la guardada en `payments` se reutiliza en vez de crear otra.
   * Recién cuando venció se pide una nueva, y la clave de idempotencia cubre a
   * dos requests simultáneos que todavía no vieron la fila.
   *
   * Eso evita links duplicados, no cobros duplicados: una preferencia acepta
   * más de un pago (ver el comentario del archivo).
   */
  async createCheckout(
    accessToken: string,
    userId: string,
    appointmentId: string,
    now: Date = new Date(),
    origen: CheckoutOrigin = 'web',
  ): Promise<CheckoutLink> {
    if (!this.mercadopago.isConfigured()) {
      throw new ServiceUnavailableException(PAYMENTS_UNAVAILABLE);
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

    // ENG-101 no libera los turnos que ya empezaron, así que uno de ayer puede
    // seguir en RESERVADO_SIN_PAGAR y el webhook lo pasaría a CONFIRMADO.
    const scheduledAt = new Date(appointment.scheduled_at);
    if (scheduledAt <= now) {
      throw new ConflictException('Ese turno ya pasó: no se puede pagar.');
    }

    // La retención venció pero el job todavía no pasó (corre cada 5 minutos).
    // El turno ya no es del paciente: cobrarlo sería cobrar algo que en minutos
    // pasa a LIBERADO.
    const holdEndsAt = holdExpiresAt(new Date(appointment.created_at));
    if (holdEndsAt <= now) {
      throw new ConflictException(
        'La reserva venció porque no se pagó a tiempo. Volvé a reservar el turno.',
      );
    }

    // Antes de tocar MercadoPago: si falta configuración, mejor no cobrar.
    const notificationUrl = this.notificationUrl();
    const backUrls = this.backUrls(appointment.id, origen);

    const { amount, currency, professionalName } =
      await this.readChargeDetails(appointment);

    const existing = await this.prisma.payment.findUnique({
      where: { appointment_id: appointment.id },
      select: { id: true, status: true, mercadopago_preference_id: true },
    });

    if (
      existing &&
      (SETTLED_PAYMENT_STATUSES as string[]).includes(existing.status)
    ) {
      // Defensa en profundidad: el estado del turno ya debería haberlo frenado,
      // pero si quedaron desincronizados, la que manda es la fila del pago.
      throw new ConflictException('Ese turno ya tiene un pago registrado.');
    }

    const reusable = await this.reusablePreference(
      existing?.mercadopago_preference_id ?? null,
      appointment.id,
      now,
    );

    // Se empezó a pagar desde la otra punta: la misma preferencia, pero que
    // vuelva adonde está el paciente ahora. Si tiene el checkout abierto en las
    // dos puntas, el último en llamar decide adónde vuelve la preferencia (la
    // pestaña web podría terminar en `mediconnect://`); el estado igual sale
    // del webhook, no del retorno.
    if (reusable && reusable.backUrlSuccess !== backUrls.success) {
      await this.mercadopago.updateBackUrls(reusable.id, backUrls);
    }

    const preference =
      reusable ??
      (await this.mercadopago.createPreference({
        // EL contrato con ENG-64. No tocar sin cambiar el webhook.
        externalReference: appointment.id,
        notificationUrl,
        item: {
          title: `Consulta con ${professionalName}`,
          quantity: 1,
          unitPrice: amount,
          currencyId: currency,
        },
        backUrls,
        expiresAt: new Date(
          Math.min(
            now.getTime() + PREFERENCE_TTL_MS,
            scheduledAt.getTime(),
            holdEndsAt.getTime(),
          ),
        ),
        // Atada a la preferencia que se reemplaza: dos requests simultáneos ven
        // la misma fila y comparten clave, pero una vez vencida la anterior la
        // clave cambia y MercadoPago no devuelve la preferencia muerta.
        idempotencyKey: `${appointment.id}:${existing?.mercadopago_preference_id ?? 'inicial'}`,
      }));

    const payment = await this.savePayment(
      appointment.id,
      amount,
      currency,
      preference.id,
    );

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
   * Vence el link de pago del turno, si hay uno que todavía se pueda cobrar.
   *
   * Lo llaman la cancelación (ENG-55) y la liberación por falta de pago
   * (ENG-101): sin esto, la pestaña de MercadoPago que el paciente dejó abierta
   * sigue cobrando un turno que ya no existe.
   *
   * **Nunca tira.** Cancelar el turno es lo importante y ya pasó; si MercadoPago
   * no contesta, la preferencia igual vence sola a los {@link PREFERENCE_TTL_MS}
   * como mucho, y el error queda en el log.
   */
  async expireCheckout(appointmentId: string, now: Date = new Date()) {
    try {
      const payment = await this.prisma.payment.findUnique({
        where: { appointment_id: appointmentId },
        select: { status: true, mercadopago_preference_id: true },
      });

      if (
        !payment?.mercadopago_preference_id ||
        !(OPEN_PAYMENT_STATUSES as string[]).includes(payment.status) ||
        !this.mercadopago.isConfigured()
      ) {
        return;
      }

      await this.mercadopago.expirePreference(
        payment.mercadopago_preference_id,
        now,
      );
    } catch (err) {
      this.logger.error(
        `No se pudo vencer la preferencia del turno ${appointmentId}: ${String(err)}`,
      );
    }
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
   * La preferencia guardada, si todavía sirve: es del turno y le queda margen
   * de vida. `null` si hay que crear otra.
   *
   * Un 404 de MercadoPago (la preferencia es de otra cuenta, por ejemplo tras
   * rotar credenciales) también es "crear otra". Cualquier otro error se
   * propaga: si MercadoPago no contesta un GET, tampoco va a contestar el POST.
   */
  private async reusablePreference(
    preferenceId: string | null,
    appointmentId: string,
    now: Date,
  ): Promise<Preference | null> {
    if (!preferenceId) {
      return null;
    }

    let preference: Preference;
    try {
      preference = await this.mercadopago.getPreference(preferenceId);
    } catch (err) {
      if (err instanceof MercadoPagoApiError && err.providerStatus === 404) {
        return null;
      }
      throw err;
    }

    const vigente =
      preference.expiresAt !== null &&
      preference.expiresAt.getTime() - now.getTime() >= REUSE_MIN_REMAINING_MS;

    return vigente && preference.externalReference === appointmentId
      ? preference
      : null;
  }

  /**
   * Guarda (o actualiza) la fila del pago con la preferencia vigente.
   *
   * El monto se guarda ACÁ y no se vuelve a calcular: el webhook de ENG-64
   * compara lo que MercadoPago cobró contra esta fila. Si quedara en cero o
   * desactualizado, un pago legítimo se rechazaría —o peor, uno por menos plata
   * se aceptaría.
   *
   * Un reintento después de un pago rechazado vuelve la fila a `PENDIENTE`: hay
   * un intento nuevo en curso y la pantalla no tiene por qué seguir mostrando el
   * rechazo anterior. El `where` excluye los estados cerrados por si el webhook
   * aprobó el pago entre la lectura y esta escritura: ahí el upsert intenta
   * crear, choca con la unicidad de `appointment_id` y sale como 409 en vez de
   * pisar un `APROBADO`.
   */
  private async savePayment(
    appointmentId: string,
    amount: number,
    currency: string,
    preferenceId: string,
  ): Promise<{ status: string; amount: unknown; currency: string }> {
    try {
      return await this.prisma.payment.upsert({
        where: {
          appointment_id: appointmentId,
          status: { notIn: SETTLED_PAYMENT_STATUSES },
        },
        create: {
          appointment_id: appointmentId,
          amount,
          currency,
          status: 'PENDIENTE',
          mercadopago_preference_id: preferenceId,
        },
        update: {
          mercadopago_preference_id: preferenceId,
          status: 'PENDIENTE',
        },
        select: { status: true, amount: true, currency: true },
      });
    } catch (err) {
      if ((err as { code?: string }).code === PRISMA_UNIQUE_VIOLATION) {
        throw new ConflictException('Ese turno ya tiene un pago registrado.');
      }
      throw err;
    }
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

  /**
   * Adónde MercadoPago manda el webhook de ENG-64.
   *
   * Exige también `MERCADOPAGO_WEBHOOK_SECRET`: sin él el webhook descarta todas
   * las notificaciones (`sin-secreto-configurado`), que para el paciente es lo
   * mismo que si no llegaran.
   */
  private notificationUrl(): string {
    const url = this.config.get<string>('MERCADOPAGO_NOTIFICATION_URL');
    const secret = this.config.get<string>('MERCADOPAGO_WEBHOOK_SECRET');

    if (!url || !secret) {
      // Sin esto el pago se cobraría y el turno nunca se confirmaría, porque la
      // notificación no llegaría a ningún lado. Es preferible no cobrar.
      this.logger.error(
        'Cobro deshabilitado: falta MERCADOPAGO_NOTIFICATION_URL o MERCADOPAGO_WEBHOOK_SECRET.',
      );
      throw new ServiceUnavailableException(PAYMENTS_UNAVAILABLE);
    }

    return url;
  }

  /**
   * Adónde vuelve el navegador después de pagar.
   *
   * Las tres apuntan a la misma pantalla con un query param distinto: el
   * resultado real se lee del backend, así que la pantalla solo necesita saber
   * qué contarle al paciente mientras tanto.
   *
   * Sale de `WEB_ORIGIN`. En producción tiene que estar y ser **una** URL: el
   * fallback a `localhost` solo vale en desarrollo, y si `WEB_ORIGIN` pasara a
   * ser una lista de orígenes para CORS, el paciente que acaba de pagar volvería
   * a una URL rota. En los dos casos, 503 antes de cobrar.
   */
  private backUrls(
    appointmentId: string,
    origen: CheckoutOrigin,
  ): {
    success: string;
    failure: string;
    pending: string;
  } {
    // Desde la app vuelve a la app. El resultado lo sigue leyendo la pantalla
    // del backend: el query param solo dice qué contar mientras tanto.
    if (origen === 'app') {
      const app = `${APP_SCHEME}://pago/${appointmentId}`;
      return {
        success: `${app}?resultado=exito`,
        failure: `${app}?resultado=fallo`,
        pending: `${app}?resultado=pendiente`,
      };
    }

    const configured = this.config.get<string>('WEB_ORIGIN');
    const production = this.config.get<string>('NODE_ENV') === 'production';

    if (!configured && production) {
      this.logger.error('Cobro deshabilitado: falta WEB_ORIGIN en producción.');
      throw new ServiceUnavailableException(PAYMENTS_UNAVAILABLE);
    }

    let web: string;
    try {
      // Una lista separada por comas puede parsear como un host raro: se
      // rechaza antes de que `URL` la acepte.
      if (configured?.includes(',')) throw new Error('lista');
      web = new URL(configured ?? 'http://localhost:5173').origin;
    } catch {
      this.logger.error(
        `Cobro deshabilitado: WEB_ORIGIN no es una URL única (${configured}).`,
      );
      throw new ServiceUnavailableException(PAYMENTS_UNAVAILABLE);
    }
    const base = `${web}/turnos/${appointmentId}/pago`;

    return {
      success: `${base}?resultado=exito`,
      failure: `${base}?resultado=fallo`,
      pending: `${base}?resultado=pendiente`,
    };
  }
}
