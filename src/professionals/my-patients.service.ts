import { ForbiddenException, Injectable } from '@nestjs/common';
import { READABLE_APPOINTMENT_STATUSES } from '../clinical-records/clinical-records.service';
import {
  todayInArgentina,
  toLocalDateTime,
} from '../common/time/argentina-time';
import { buildXlsx, excelDate } from '../common/excel/excel';
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
  /** Edad en años cumplidos, en Argentina. `null` si no cargó la fecha de nacimiento. */
  age: number | null;
  /** La primera consulta COMPLETADA con este profesional: "paciente desde". */
  firstConsultation: AppointmentMoment | null;
  /** El último turno COMPLETADO con este profesional. */
  lastConsultation: AppointmentMoment | null;
  /** El próximo turno CONFIRMADO o RESERVADO_SIN_PAGAR que todavía no pasó. */
  nextAppointment: AppointmentMoment | null;
  /** Cuántas consultas completó con este profesional. */
  consultations: number;
}

/** Columna por la que se ordena la tabla. */
export type MyPatientsOrder =
  | 'ULTIMA_CONSULTA'
  | 'PROXIMO_TURNO'
  | 'CONSULTAS'
  | 'PACIENTE_DESDE'
  | 'NOMBRE';

/** Si tiene o no un turno por delante. */
export type NextFilter = 'CON_PROXIMO' | 'SIN_PROXIMO';

/**
 * Cuándo fue la última consulta. `MAS_DE_6M` sirve para encontrar a quien hace
 * tiempo no viene; `NUNCA`, a quien reservó pero todavía no se atendió.
 */
export type LastFilter = '30D' | '90D' | 'MAS_DE_6M' | 'NUNCA';

export interface MyPatientsQuery {
  /** Parte del nombre o del apellido, sin importar mayúsculas ni tildes. */
  q?: string;
  pagina?: number;
  orden?: MyPatientsOrder;
  dir?: 'asc' | 'desc';
  proximo?: NextFilter;
  ultima?: LastFilter;
}

/** Sentido por defecto de cada columna: lo que primero interesa ver. */
export const DEFAULT_DIR: Record<MyPatientsOrder, 'asc' | 'desc'> = {
  ULTIMA_CONSULTA: 'desc',
  PROXIMO_TURNO: 'asc',
  CONSULTAS: 'desc',
  PACIENTE_DESDE: 'asc',
  NOMBRE: 'asc',
};

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
 * ## Ordenar y filtrar
 *
 * Cualquier columna de fechas o cantidades ordena en los dos sentidos; las
 * fechas vacías (nunca vino, sin próximo turno) van siempre al final, sea cual
 * sea el sentido, para que no tapen a los que sí tienen dato. Los filtros por
 * próximo turno y por antigüedad de la última consulta se suman a la búsqueda,
 * y la exportación a Excel respeta todo: baja lo que se ve, ordenado igual.
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
    const rows = applyQuery(await this.load(professionalId, now), query, now);
    const pagina = query.pagina ?? 1;
    const desde = (pagina - 1) * MY_PATIENTS_PAGE_SIZE;

    return {
      rows: rows.slice(desde, desde + MY_PATIENTS_PAGE_SIZE),
      pagina,
      hayMas: rows.length > desde + MY_PATIENTS_PAGE_SIZE,
      total: rows.length,
    };
  }

  /** Las mismas filas que la tabla (filtros y orden incluidos), en Excel. */
  async exportXlsx(
    professionalId: string,
    query: Omit<MyPatientsQuery, 'pagina'>,
    now: Date = new Date(),
  ): Promise<{ filename: string; xlsx: Buffer }> {
    const rows = applyQuery(await this.load(professionalId, now), query, now);
    const pro = await this.prisma.professional.findUnique({
      where: { profile_id: professionalId },
      select: { first_name: true, last_name: true },
    });
    return {
      filename: `mis-pacientes-${todayInArgentina(now)}.xlsx`,
      xlsx: await toXlsx(rows, {
        profesional: pro ? `${pro.first_name} ${pro.last_name}`.trim() : '',
        filtros: describeQuery(query),
        now,
      }),
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
        patient: {
          select: { first_name: true, last_name: true, birth_date: true },
        },
      },
    });

    const porPaciente = new Map<
      string,
      MyPatientRow & { first?: Date; last?: Date; next?: Date }
    >();
    const hoy = todayInArgentina(now);
    for (const a of appointments) {
      let fila = porPaciente.get(a.patient_id);
      if (!fila) {
        fila = {
          patientId: a.patient_id,
          firstName: a.patient.first_name.trim(),
          lastName: a.patient.last_name.trim(),
          age: ageOn(a.patient.birth_date, hoy),
          firstConsultation: null,
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
        if (!fila.first || a.scheduled_at < fila.first)
          fila.first = a.scheduled_at;
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
      .map(({ first, last, next, ...fila }) => ({
        ...fila,
        firstConsultation: first ? momentOf(first) : null,
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

/** Años cumplidos a `hoy` (`YYYY-MM-DD`, Argentina). */
export function ageOn(birth: Date | null, hoy: string): number | null {
  if (!birth) return null;
  const nac = birth.toISOString().slice(0, 10);
  const [y, m, d] = hoy.split('-').map(Number);
  const [ny, nm, nd] = nac.split('-').map(Number);
  return y - ny - (m < nm || (m === nm && d < nd) ? 1 : 0);
}

const DIAS = 86_400_000;

/** Búsqueda, filtros y orden, en ese orden. */
export function applyQuery(
  rows: MyPatientRow[],
  query: Omit<MyPatientsQuery, 'pagina'>,
  now: Date = new Date(),
): MyPatientRow[] {
  const desde = (dias: number) => now.getTime() - dias * DIAS;
  const filtradas = filterPatients(rows, query.q).filter((r) => {
    if (query.proximo === 'CON_PROXIMO' && !r.nextAppointment) return false;
    if (query.proximo === 'SIN_PROXIMO' && r.nextAppointment) return false;
    const ultima = r.lastConsultation
      ? Date.parse(r.lastConsultation.at)
      : null;
    switch (query.ultima) {
      case '30D':
        return ultima !== null && ultima >= desde(30);
      case '90D':
        return ultima !== null && ultima >= desde(90);
      case 'MAS_DE_6M':
        return ultima !== null && ultima < desde(182);
      case 'NUNCA':
        return ultima === null;
      default:
        return true;
    }
  });
  if (!query.orden) return filtradas;
  return sortPatients(filtradas, query.orden, query.dir);
}

export function sortPatients(
  rows: MyPatientRow[],
  orden: MyPatientsOrder,
  dir: 'asc' | 'desc' = DEFAULT_DIR[orden],
): MyPatientRow[] {
  const signo = dir === 'asc' ? 1 : -1;
  const fecha = (m: AppointmentMoment | null) => (m ? Date.parse(m.at) : null);
  const clave = (r: MyPatientRow): number | string | null => {
    switch (orden) {
      case 'ULTIMA_CONSULTA':
        return fecha(r.lastConsultation);
      case 'PROXIMO_TURNO':
        return fecha(r.nextAppointment);
      case 'PACIENTE_DESDE':
        return fecha(r.firstConsultation);
      case 'CONSULTAS':
        return r.consultations;
      case 'NOMBRE':
        return normalizar(`${r.lastName} ${r.firstName}`);
    }
  };
  return [...rows].sort((a, b) => {
    const ka = clave(a);
    const kb = clave(b);
    // Sin dato, siempre al final: no importa el sentido.
    if (ka === null || kb === null) {
      if (ka === kb) return fullName(a).localeCompare(fullName(b), 'es');
      return ka === null ? 1 : -1;
    }
    const cmp =
      typeof ka === 'string'
        ? ka.localeCompare(kb as string, 'es')
        : ka - (kb as number);
    return cmp * signo || fullName(a).localeCompare(fullName(b), 'es');
  });
}

const ETIQUETAS_ORDEN: Record<MyPatientsOrder, string> = {
  ULTIMA_CONSULTA: 'última consulta',
  PROXIMO_TURNO: 'próximo turno',
  CONSULTAS: 'consultas',
  PACIENTE_DESDE: 'paciente desde',
  NOMBRE: 'apellido',
};

/** Los filtros aplicados, en palabras, para el encabezado del Excel. */
export function describeQuery(query: Omit<MyPatientsQuery, 'pagina'>): string {
  const partes: string[] = [];
  if (query.q?.trim()) partes.push(`búsqueda «${query.q.trim()}»`);
  if (query.proximo === 'CON_PROXIMO') partes.push('con próximo turno');
  if (query.proximo === 'SIN_PROXIMO') partes.push('sin próximo turno');
  const ultima: Record<LastFilter, string> = {
    '30D': 'última consulta en los últimos 30 días',
    '90D': 'última consulta en los últimos 3 meses',
    MAS_DE_6M: 'última consulta hace más de 6 meses',
    NUNCA: 'todavía sin consultas',
  };
  if (query.ultima) partes.push(ultima[query.ultima]);
  const orden = query.orden ?? 'ULTIMA_CONSULTA';
  const dir = query.dir ?? DEFAULT_DIR[orden];
  partes.push(
    `ordenado por ${ETIQUETAS_ORDEN[orden]} (${dir === 'asc' ? 'ascendente' : 'descendente'})`,
  );
  return partes.join(' · ');
}

/**
 * La tabla en Excel: las mismas columnas que la pantalla, con las fechas como
 * fechas de verdad (se ordenan y filtran en Excel) y en hora de Argentina.
 */
export function toXlsx(
  rows: MyPatientRow[],
  meta: { profesional: string; filtros: string; now: Date },
): Promise<Buffer> {
  const fecha = (m: AppointmentMoment | null) =>
    m ? excelDate(m.date, m.startTime) : null;
  const { date, startTime } = toLocalDateTime(meta.now);
  const [y, mo, d] = date.split('-');
  return buildXlsx({
    sheet: 'Mis pacientes',
    title: 'Mis pacientes',
    details: [
      [meta.profesional, `Generado el ${d}/${mo}/${y} a las ${startTime}`]
        .filter(Boolean)
        .join(' · '),
      `${rows.length} ${rows.length === 1 ? 'paciente' : 'pacientes'} · ${meta.filtros}`,
    ],
    columns: [
      { header: 'Paciente', width: 28, value: (r) => fullName(r) },
      { header: 'Edad', width: 8, format: 'entero', value: (r) => r.age },
      {
        header: 'Paciente desde',
        width: 18,
        format: 'fecha',
        value: (r) => fecha(r.firstConsultation),
      },
      {
        header: 'Última consulta',
        width: 20,
        format: 'fechaHora',
        value: (r) => fecha(r.lastConsultation),
      },
      {
        header: 'Próximo turno',
        width: 20,
        format: 'fechaHora',
        value: (r) => fecha(r.nextAppointment),
      },
      {
        header: 'Consultas',
        width: 12,
        format: 'entero',
        value: (r) => r.consultations,
      },
    ],
    rows,
  });
}
