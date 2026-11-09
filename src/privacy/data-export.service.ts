import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Versión del formato del archivo. Si cambia la forma, se sube. */
export const DATA_EXPORT_FORMAT = 'mediconnect-datos-personales/1';

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;
const fecha = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;
const dinero = (v: { toString(): string } | null | undefined): string | null =>
  v == null ? null : v.toString();
const nombre = (p: { first_name: string; last_name: string } | null) =>
  p ? `${p.first_name} ${p.last_name}`.trim() : null;

/**
 * Derecho de acceso (ENG-86, Ley 25.326 art. 14): **todo lo que MediConnect
 * guarda de una persona**, en un archivo que se puede leer y llevar a otro lado.
 *
 * ## Qué entra y qué no
 *
 * Entran los datos **de quien pide**: su cuenta, su ficha, sus turnos y pagos,
 * su historia clínica completa (es suya, Ley 26.529 art. 14), sus documentos,
 * su MediPass y quién lo abrió, sus conversaciones, sus reseñas, sus avisos y
 * sus constancias de consentimiento. También **quién leyó su historia clínica**:
 * el registro de accesos es un dato sobre ella, y saberlo es parte del derecho.
 *
 * No entran los datos **de terceros** que no son sobre quien pide: un
 * profesional recibe sus turnos sin la identidad de los pacientes, y de las
 * historias clínicas que firmó solo la cantidad. Esas son de los pacientes, y
 * cada uno las pide por su lado.
 *
 * Los archivos de los documentos no van adentro, solo sus datos y su SHA-256:
 * se descargan desde la pantalla, con su URL firmada, y el hash permite
 * comprobar que el archivo es el mismo.
 */
@Injectable()
export class DataExportService {
  constructor(private readonly prisma: PrismaService) {}

  async export(userId: string, now: Date = new Date()) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: {
        email: true,
        role: true,
        created_at: true,
        deleted_at: true,
        email_reminders: true,
      },
    });
    if (!profile || profile.deleted_at) {
      throw new NotFoundException('No encontramos tu cuenta.');
    }

    const [comunes, porRol] = await Promise.all([
      this.common(userId),
      profile.role === 'PACIENTE'
        ? this.patient(userId)
        : profile.role === 'PROFESIONAL'
          ? this.professional(userId)
          : Promise.resolve({}),
    ]);

    return {
      formato: DATA_EXPORT_FORMAT,
      generadoEl: now.toISOString(),
      leyAplicable:
        'Ley 25.326 de Protección de los Datos Personales, art. 14 (derecho de acceso)',
      cuenta: {
        email: profile.email,
        rol: profile.role,
        creadaEl: iso(profile.created_at),
        recordatoriosPorEmail: profile.email_reminders,
      },
      ...porRol,
      ...comunes,
    };
  }

  /** Lo que tiene cualquier usuario, sea del rol que sea. */
  private async common(userId: string) {
    const [acceptances, notifications] = await Promise.all([
      this.prisma.legalAcceptance.findMany({
        where: { profile_id: userId },
        orderBy: { accepted_at: 'asc' },
        select: { version: true, accepted_at: true, source: true },
      }),
      this.prisma.notification.findMany({
        where: { user_id: userId, channel: 'IN_APP' },
        orderBy: { created_at: 'desc' },
        select: { type: true, payload: true, created_at: true, read_at: true },
      }),
    ]);

    return {
      aceptacionesLegales: acceptances.map((a) => ({
        version: a.version,
        aceptadaEl: iso(a.accepted_at),
        origen: a.source,
      })),
      avisos: notifications.map((n) => ({
        tipo: n.type,
        contenido: n.payload,
        creadoEl: iso(n.created_at),
        leidoEl: iso(n.read_at),
      })),
    };
  }

  private async patient(userId: string) {
    const [
      patient,
      appointments,
      entries,
      documents,
      sessions,
      reviews,
      conversations,
      reads,
      card,
    ] = await Promise.all([
      this.prisma.patient.findUnique({ where: { profile_id: userId } }),
      this.prisma.appointment.findMany({
        where: { patient_id: userId },
        orderBy: { scheduled_at: 'desc' },
        select: {
          id: true,
          scheduled_at: true,
          duration_minutes: true,
          status: true,
          price: true,
          cancellation_reason: true,
          cancelled_at: true,
          rescheduled_at: true,
          professional: { select: { first_name: true, last_name: true } },
          payment: {
            select: {
              amount: true,
              currency: true,
              method: true,
              status: true,
              confirmed_at: true,
              refunds: {
                select: {
                  amount: true,
                  status: true,
                  reason: true,
                  created_at: true,
                  processed_at: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.clinicalRecordEntry.findMany({
        where: { patient_id: userId },
        orderBy: { sequence_number: 'asc' },
        select: {
          id: true,
          sequence_number: true,
          entry_type: true,
          fhir_resource_type: true,
          content: true,
          corrects_entry_id: true,
          content_hash: true,
          previous_hash: true,
          created_at: true,
          professional: {
            select: { first_name: true, last_name: true, license_number: true },
          },
        },
      }),
      this.prisma.patientDocument.findMany({
        where: { patient_id: userId },
        orderBy: { uploaded_at: 'desc' },
        select: {
          type: true,
          title: true,
          document_date: true,
          source_institution: true,
          mime_type: true,
          size_bytes: true,
          sha256: true,
          uploaded_at: true,
          withdrawn_at: true,
        },
      }),
      this.prisma.mediPassSession.findMany({
        where: { patient_id: userId },
        orderBy: { started_at: 'desc' },
        select: {
          consultant_name: true,
          consultant_license: true,
          emergency_card_id: true,
          started_at: true,
          expires_at: true,
          revoked_at: true,
        },
      }),
      this.prisma.review.findMany({
        where: { patient_id: userId },
        orderBy: { created_at: 'desc' },
        select: {
          rating: true,
          comment: true,
          status: true,
          moderation_reason: true,
          created_at: true,
          professional: { select: { first_name: true, last_name: true } },
        },
      }),
      this.conversations({ patient_id: userId }, userId, 'professional'),
      this.prisma.auditLog.findMany({
        where: {
          action: 'CLINICAL_RECORD_READ',
          resource_type: 'clinical_record_entries',
          resource_id: userId,
          NOT: { actor_id: userId },
          metadata: { path: ['role'], equals: 'PROFESIONAL' },
        },
        orderBy: { created_at: 'desc' },
        select: { actor_id: true, created_at: true },
      }),
      this.prisma.mediPassEmergencyCard.findFirst({
        where: { patient_id: userId, revoked_at: null },
        select: { created_at: true },
      }),
    ]);

    // Quién leyó la HC: los ids del log, con nombre y matrícula del profesional.
    const lectores = await this.prisma.professional.findMany({
      where: {
        profile_id: {
          in: [
            ...new Set(
              reads.map((r) => r.actor_id).filter((id): id is string => !!id),
            ),
          ],
        },
      },
      select: {
        profile_id: true,
        first_name: true,
        last_name: true,
        license_number: true,
      },
    });
    const lector = new Map(lectores.map((p) => [p.profile_id, p]));

    return {
      paciente: patient && {
        nombre: patient.first_name,
        apellido: patient.last_name,
        fechaDeNacimiento: fecha(patient.birth_date),
        dni: patient.dni,
        telefono: patient.phone,
        domicilio: patient.address,
        sexo: patient.sex,
      },
      datosDeEmergencia: patient && {
        grupoSanguineo: patient.blood_type,
        alergias: patient.allergies,
        medicacion: patient.medications,
        condiciones: patient.conditions,
        contactoDeEmergencia: patient.emergency_contact,
        queVeUnConsultante: patient.medipass_scope ?? 'todo',
      },
      turnos: appointments.map((a) => ({
        id: a.id,
        fecha: iso(a.scheduled_at),
        duracionMinutos: a.duration_minutes,
        estado: a.status,
        precio: dinero(a.price),
        profesional: nombre(a.professional),
        canceladoEl: iso(a.cancelled_at),
        motivoDeCancelacion: a.cancellation_reason,
        reprogramadoEl: iso(a.rescheduled_at),
        pago: a.payment && {
          monto: dinero(a.payment.amount),
          moneda: a.payment.currency,
          medio: a.payment.method,
          estado: a.payment.status,
          confirmadoEl: iso(a.payment.confirmed_at),
          reembolsos: a.payment.refunds.map((r) => ({
            monto: dinero(r.amount),
            estado: r.status,
            motivo: r.reason,
            pedidoEl: iso(r.created_at),
            procesadoEl: iso(r.processed_at),
          })),
        },
      })),
      historiaClinica: entries.map((e) => ({
        id: e.id,
        numero: e.sequence_number.toString(),
        tipo: e.entry_type,
        recursoFhir: e.fhir_resource_type,
        contenido: e.content,
        corrigeA: e.corrects_entry_id,
        fecha: iso(e.created_at),
        profesional: nombre(e.professional),
        matricula: e.professional?.license_number ?? null,
        // La cadena de hash: con esto se puede verificar que nada se alteró.
        hash: e.content_hash,
        hashAnterior: e.previous_hash,
      })),
      quienLeyoMiHistoriaClinica: reads.map((r) => {
        const p = r.actor_id ? lector.get(r.actor_id) : undefined;
        return {
          profesional: p ? nombre(p) : null,
          matricula: p?.license_number ?? null,
          el: iso(r.created_at),
        };
      }),
      documentosAportados: documents.map((d) => ({
        tipo: d.type,
        titulo: d.title,
        fechaDelDocumento: fecha(d.document_date),
        institucion: d.source_institution,
        formato: d.mime_type,
        bytes: d.size_bytes,
        sha256: d.sha256,
        subidoEl: iso(d.uploaded_at),
        retiradoEl: iso(d.withdrawn_at),
      })),
      mediPass: {
        tarjetaDeEmergenciaActivaDesde: iso(card?.created_at),
        accesos: sessions.map((s) => ({
          consultante: s.consultant_name,
          matriculaDeclarada: s.consultant_license,
          entroCon: s.emergency_card_id ? 'TARJETA' : 'CODIGO',
          inicio: iso(s.started_at),
          vence: iso(s.expires_at),
          cortadoEl: iso(s.revoked_at),
        })),
      },
      resenasEscritas: reviews.map((r) => ({
        profesional: nombre(r.professional),
        calificacion: r.rating,
        comentario: r.comment,
        estado: r.status,
        motivoDeRechazo: r.moderation_reason,
        escritaEl: iso(r.created_at),
      })),
      conversaciones: conversations,
    };
  }

  private async professional(userId: string) {
    const [professional, appointments, reviews, conversations, entries] =
      await Promise.all([
        this.prisma.professional.findUnique({
          where: { profile_id: userId },
          select: {
            first_name: true,
            last_name: true,
            license_number: true,
            bio: true,
            photo_url: true,
            consultation_price: true,
            currency: true,
            status: true,
            created_at: true,
            specialties: { select: { specialty: { select: { name: true } } } },
            education: true,
            schedule_rules: {
              select: {
                weekday: true,
                start_time: true,
                end_time: true,
                slot_duration_minutes: true,
              },
            },
            schedule_blocks: {
              select: {
                block_date: true,
                start_time: true,
                end_time: true,
                reason: true,
              },
            },
            cancellation_policy: {
              select: {
                hours_full_refund: true,
                hours_partial_refund: true,
                partial_refund_percent: true,
              },
            },
          },
        }),
        // Sin la identidad del paciente: es un dato de un tercero.
        this.prisma.appointment.findMany({
          where: { professional_id: userId },
          orderBy: { scheduled_at: 'desc' },
          select: {
            scheduled_at: true,
            duration_minutes: true,
            status: true,
            price: true,
            cancelled_at: true,
          },
        }),
        this.prisma.review.findMany({
          where: { professional_id: userId },
          orderBy: { created_at: 'desc' },
          select: {
            rating: true,
            comment: true,
            status: true,
            created_at: true,
            response: { select: { content: true, created_at: true } },
          },
        }),
        this.conversations({ professional_id: userId }, userId, 'patient'),
        this.prisma.clinicalRecordEntry.count({
          where: { professional_id: userId },
        }),
      ]);

    const hora = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : null);

    return {
      profesional: professional && {
        nombre: professional.first_name,
        apellido: professional.last_name,
        matricula: professional.license_number,
        biografia: professional.bio,
        foto: professional.photo_url,
        precioDeLaConsulta: dinero(professional.consultation_price),
        moneda: professional.currency,
        estado: professional.status,
        registradoEl: iso(professional.created_at),
        especialidades: professional.specialties.map((s) => s.specialty.name),
        formacion: professional.education,
      },
      agenda: professional && {
        horarios: professional.schedule_rules.map((r) => ({
          diaDeLaSemana: r.weekday,
          desde: hora(r.start_time),
          hasta: hora(r.end_time),
          duracionDelTurnoMinutos: r.slot_duration_minutes,
        })),
        bloqueos: professional.schedule_blocks.map((b) => ({
          fecha: fecha(b.block_date),
          desde: hora(b.start_time),
          hasta: hora(b.end_time),
          motivo: b.reason,
        })),
        politicaDeCancelacion: professional.cancellation_policy && {
          horasDevolucionTotal:
            professional.cancellation_policy.hours_full_refund,
          horasDevolucionParcial:
            professional.cancellation_policy.hours_partial_refund,
          porcentajeDevolucionParcial:
            professional.cancellation_policy.partial_refund_percent,
        },
      },
      turnos: appointments.map((a) => ({
        fecha: iso(a.scheduled_at),
        duracionMinutos: a.duration_minutes,
        estado: a.status,
        precio: dinero(a.price),
        canceladoEl: iso(a.cancelled_at),
      })),
      resenasRecibidas: reviews.map((r) => ({
        calificacion: r.rating,
        comentario: r.comment,
        estado: r.status,
        escritaEl: iso(r.created_at),
        miRespuesta: r.response?.content ?? null,
        respondidaEl: iso(r.response?.created_at),
      })),
      entradasDeHistoriaClinicaFirmadas: {
        cantidad: entries,
        nota: 'El contenido es de cada paciente y no va en este archivo: cada paciente lo pide por su lado.',
      },
      conversaciones: conversations,
    };
  }

  /** Las conversaciones de quien pide, con lo que se escribió en las dos puntas. */
  private async conversations(
    where: { patient_id: string } | { professional_id: string },
    userId: string,
    contraparte: 'patient' | 'professional',
  ) {
    const rows = await this.prisma.conversation.findMany({
      where,
      orderBy: { created_at: 'asc' },
      select: {
        created_at: true,
        patient: { select: { first_name: true, last_name: true } },
        professional: { select: { first_name: true, last_name: true } },
        messages: {
          orderBy: { created_at: 'asc' },
          select: {
            sender_id: true,
            content: true,
            attachment_mime: true,
            attachment_size: true,
            created_at: true,
            read_at: true,
          },
        },
      },
    });
    return rows.map((c) => ({
      con: nombre(c[contraparte]),
      iniciadaEl: iso(c.created_at),
      mensajes: c.messages.map((m) => ({
        de: m.sender_id === userId ? 'yo' : 'la otra persona',
        texto: m.content,
        // El tipo y el tamaño, no la ruta en Storage: la ruta no le sirve a
        // nadie fuera del sistema. El archivo se abre desde el chat.
        adjunto: m.attachment_mime
          ? { tipo: m.attachment_mime, bytes: m.attachment_size }
          : null,
        enviadoEl: iso(m.created_at),
        leidoEl: iso(m.read_at),
      })),
    }));
  }
}
