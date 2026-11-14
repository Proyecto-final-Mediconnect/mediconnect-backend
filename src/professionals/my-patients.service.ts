import { ForbiddenException, Injectable } from '@nestjs/common';
import { READABLE_APPOINTMENT_STATUSES } from '../clinical-records/clinical-records.service';
import {
  todayInArgentina,
  toLocalDateTime,
} from '../common/time/argentina-time';
import { PrismaService } from '../prisma/prisma.service';

/** Filas por página de la tabla. */
export const MY_PATIENTS_PAGE_SIZE = 20;

/** Estados de un turno que todavía puede pasar: cuentan como "próximo". */
const UPCOMING_STATUSES = ['CONFIRMADO', 'RESERVADO_SIN_PAGAR'] as const;

/** Un turno ubicado en el tiempo: el instante y cómo se lee en Argentina. */
export interface AppointmentMoment {
  /** ISO-8601, UTC. */
  at: string;
  /** `YYYY-MM-DD` en Argentina. */
  date: string;
  /** `HH:mm` en Argentina. */
  startTime: string;
}

/** Un paciente del profesional. Solo identidad y turnos: ningún dato clínico. */
export interface MyPatientRow {
  /** `patients.profile_id`: es lo que pide el link a la historia clínica. */
  patientId: string;
  firstName: string;
  lastName: string;
  /** El último turno COMPLETADO con este profesional. */
  lastConsultation: AppointmentMoment | null;
  /** El próximo turno CONFIRMADO o RESERVADO_SIN_PAGAR que todavía no pasó. */
  nextAppointment: AppointmentMoment | null;
  /** Cuántas consultas completó con este profesional. */
  consultations: number;
}

export interface MyPatientsQuery {
  /** Parte del nombre o del apellido, sin importar mayúsculas ni tildes. */
  q?: string;
  pagina?: number;
}

export interface MyPatientsView {
  rows: MyPatientRow[];
  pagina: number;
  hayMas: boolean;
  /** Pacientes que cumplen la búsqueda, en todas las páginas. */
  total: number;
}

/**
 * "Mis pacientes" del profesional (ENG-197).
 *
 * ## Quién es "mi paciente"
 *
 * Quien tiene al menos un turno con el profesional en un estado que le habilita
 * leer su historia clínica (`READABLE_APPOINTMENT_STATUSES`): la lista existe
 * para abrir esa historia, así que no tiene sentido mostrar a alguien cuya
 * historia el profesional no puede abrir. Por eso un turno cancelado, liberado
 * o al que el paciente no vino no alcanza para aparecer.
 *
 * ## Última consulta y próximo turno
 *
 * La última consulta es el último turno `COMPLETADO`: consulta es lo que ya se
 * hizo. El próximo es el primer turno `CONFIRMADO` o `RESERVADO_SIN_PAGAR` que
 * todavía no empezó. La cantidad cuenta solo las consultas completadas con este
 * profesional, no con otros.
 *
 * ## Orden
 *
 * Primero quien se atendió más recientemente. Los que todavía no completaron
 * ninguna consulta van al final, ordenados por su próximo turno: el que viene
 * antes, primero.
 *
 * ## Búsqueda
 *
 * Se filtra en memoria comparando sin mayúsculas ni tildes: "julian" encuentra
 * a "Julián". Cada palabra buscada tiene que estar en el nombre o el apellido,
 * así "sosa ju" también encuentra a "Julián Sosa". La cantidad de pacientes de
 * un profesional es chica: traer sus turnos y agrupar acá es más simple que un
 * `GROUP BY` con `unaccent`.
 */
@Injectable()
export class MyPatientsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    professionalId: string,
    query: MyPatientsQuery,
    now: Date = new Date(),
  ): Promise<MyPatientsView> {
    const rows = filterPatients(await this.load(professionalId, now), query.q);
    const pagina = query.pagina ?? 1;
    const desde = (pagina - 1) * MY_PATIENTS_PAGE_SIZE;

    return {
      rows: rows.slice(desde, desde + MY_PATIENTS_PAGE_SIZE),
      pagina,
      hayMas: rows.length > desde + MY_PATIENTS_PAGE_SIZE,
      total: rows.length,
    };
  }

  /** Las mismas filas que la tabla, todas, en CSV para Excel. */
  async exportCsv(
    professionalId: string,
    query: Pick<MyPatientsQuery, 'q'>,
    now: Date = new Date(),
  ): Promise<{ filename: string; csv: string }> {
    const rows = filterPatients(await this.load(professionalId, now), query.q);
    return {
      filename: `mis-pacientes-${todayInArgentina(now)}.csv`,
      csv: toCsv(rows),
    };
  }

  private async load(
    professionalId: string,
    now: Date,
  ): Promise<MyPatientRow[]> {
    const professional = await this.prisma.professional.findUnique({
      where: { profile_id: professionalId },
      select: { profile_id: true },
    });
    if (!professional) {
      throw new ForbiddenException('Solo los profesionales tienen pacientes.');
    }

    const appointments = await this.prisma.appointment.findMany({
      where: {
        professional_id: professionalId,
        status: { in: [...READABLE_APPOINTMENT_STATUSES] },
      },
      select: {
        patient_id: true,
        scheduled_at: true,
        status: true,
        patient: { select: { first_name: true, last_name: true } },
      },
    });

    const porPaciente = new Map<
      string,
      MyPatientRow & { last?: Date; next?: Date }
    >();
    for (const a of appointments) {
      let fila = porPaciente.get(a.patient_id);
      if (!fila) {
        fila = {
          patientId: a.patient_id,
          firstName: a.patient.first_name.trim(),
          lastName: a.patient.last_name.trim(),
          lastConsultation: null,
          nextAppointment: null,
          consultations: 0,
        };
        porPaciente.set(a.patient_id, fila);
      }
      if (a.status === 'COMPLETADO') {
        fila.consultations += 1;
        if (!fila.last || a.scheduled_at > fila.last)
          fila.last = a.scheduled_at;
      } else if (
        (UPCOMING_STATUSES as readonly string[]).includes(a.status) &&
        a.scheduled_at > now &&
        (!fila.next || a.scheduled_at < fila.next)
      ) {
        fila.next = a.scheduled_at;
      }
    }

    return [...porPaciente.values()]
      .sort(
        (a, b) =>
          compareDesc(a.last, b.last) ||
          compareAsc(a.next, b.next) ||
          fullName(a).localeCompare(fullName(b), 'es'),
      )
      .map(({ last, next, ...fila }) => ({
        ...fila,
        lastConsultation: last ? momentOf(last) : null,
        nextAppointment: next ? momentOf(next) : null,
      }));
  }
}

function momentOf(instant: Date): AppointmentMoment {
  return { at: instant.toISOString(), ...toLocalDateTime(instant) };
}

/** El más reciente primero; sin fecha, al final. */
function compareDesc(a?: Date, b?: Date): number {
  if (a && b) return b.getTime() - a.getTime();
  return a ? -1 : b ? 1 : 0;
}

/** El más cercano primero; sin fecha, al final. */
function compareAsc(a?: Date, b?: Date): number {
  if (a && b) return a.getTime() - b.getTime();
  return a ? -1 : b ? 1 : 0;
}

function fullName(row: Pick<MyPatientRow, 'firstName' | 'lastName'>): string {
  return `${row.firstName} ${row.lastName}`.trim();
}

/** Para comparar nombres sin que mayúsculas ni tildes los distingan. */
function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Cada palabra de `q` tiene que aparecer en el nombre o en el apellido. */
export function filterPatients(
  rows: MyPatientRow[],
  q?: string,
): MyPatientRow[] {
  const palabras = q ? normalizar(q).split(/\s+/).filter(Boolean) : [];
  if (palabras.length === 0) return rows;
  return rows.filter((r) => {
    const nombre = normalizar(fullName(r));
    return palabras.every((p) => nombre.includes(p));
  });
}

/**
 * CSV para el Excel en español: `;` como separador, CRLF, y BOM UTF-8 para que
 * abra bien los acentos. Las mismas columnas que la tabla, con las fechas en
 * Argentina.
 */
export function toCsv(rows: MyPatientRow[]): string {
  const celda = (valor: string) =>
    /[";\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
  const momento = (m: AppointmentMoment | null) =>
    m ? `${m.date} ${m.startTime}` : '';
  const encabezado = [
    'Paciente',
    'Última consulta',
    'Próximo turno',
    'Consultas',
  ];
  const lineas = rows.map((r) =>
    [
      fullName(r),
      momento(r.lastConsultation),
      momento(r.nextAppointment),
      String(r.consultations),
    ]
      .map(celda)
      .join(';'),
  );
  return '﻿' + [encabezado.join(';'), ...lineas].join('\r\n') + '\r\n';
}
