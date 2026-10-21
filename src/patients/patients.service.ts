import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type {
  VitalAllergy,
  VitalCondition,
  VitalContact,
  VitalMedication,
} from '../medipass/vital-block';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdatePatientProfileDto } from './dto/update-patient-profile.dto';
import { UpdateVitalInfoDto } from './dto/update-vital-info.dto';

/** Edad máxima plausible; acota fechas de nacimiento absurdas (typos de siglo). */
const MAX_AGE_YEARS = 120;

/** Código de Postgres para violación de UNIQUE (dni duplicado). */
const PG_UNIQUE_VIOLATION = '23505';

/** Columnas del perfil de paciente que expone/gestiona este módulo.
 *  Los seis campos vitales (ENG-134) entran acá para que el formulario de
 *  ENG-136 pueda precargarse con una sola llamada. */
const PROFILE_SELECT =
  'profile_id, first_name, last_name, birth_date, dni, phone, sex, blood_type, allergies, medications, conditions, emergency_contact';

/** Forma cruda de la fila de `patients` tal como la devuelve PostgREST. */
interface PatientRow {
  profile_id: string;
  first_name: string;
  last_name: string;
  birth_date: string | null;
  dni: string | null;
  phone: string | null;
  // `jsonb`: PostgREST ya los devuelve parseados, pero la columna acepta
  // cualquier JSON válido, así que el tipo no promete la forma. Se devuelven tal
  // como están guardados; el que verifica la forma al leerlos para la ficha de
  // emergencia es `toVitalBlock`.
  sex: string | null;
  blood_type: string | null;
  allergies: unknown;
  medications: unknown;
  conditions: unknown;
  emergency_contact: unknown;
}

/**
 * Perfil de paciente expuesto por la API (camelCase). `completed` indica si el
 * paciente ya cargó sus datos: la fila en `patients` no existe hasta que
 * completa el perfil (a diferencia del profesional, que la recibe en el alta),
 * así que el front usa este flag para saber si es la primera carga o una edición.
 */
export interface PatientProfile {
  profileId: string;
  firstName: string | null;
  lastName: string | null;
  birthDate: string | null;
  dni: string | null;
  phone: string | null;
  completed: boolean;
  /** Datos vitales del MediPass (ENG-134). `null` es lo normal: son opcionales
   *  y el paciente puede no haberlos cargado nunca. */
  sex: string | null;
  bloodType: string | null;
  allergies: VitalAllergy[] | null;
  medications: VitalMedication[] | null;
  conditions: VitalCondition[] | null;
  emergencyContact: VitalContact | null;
}

@Injectable()
export class PatientsService {
  constructor(private readonly supabase: SupabaseService) {}

  /** Perfil del paciente autenticado. RLS garantiza que solo lea el suyo (el
   *  cliente va scopeado a su JWT). Si todavía no lo completó, devuelve un perfil
   *  vacío con `completed: false` en vez de 404: "sin completar" es un estado
   *  válido y esperado, no un error. */
  async getMyProfile(
    accessToken: string,
    userId: string,
  ): Promise<PatientProfile> {
    const client = this.supabase.getClientForToken(accessToken);

    const { data, error } = await client
      .from('patients')
      .select(PROFILE_SELECT)
      .eq('profile_id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos cargar tu perfil. Probá de nuevo en unos minutos.',
      );
    }

    const row = data as unknown as PatientRow | null;
    return row ? this.toProfile(row) : this.emptyProfile(userId);
  }

  /** Crea (primera carga) o actualiza el perfil de paciente. Upsert: la fila
   *  nace acá, porque el alta no la crea. RLS (`patients_insert_own` /
   *  `patients_update_own`) asegura que solo pueda tocar la fila cuyo
   *  `profile_id` es su propio `auth.uid()`. */
  async updateMyProfile(
    accessToken: string,
    userId: string,
    dto: UpdatePatientProfileDto,
  ): Promise<PatientProfile> {
    this.assertValidBirthDate(dto.birthDate);

    const client = this.supabase.getClientForToken(accessToken);

    const { error } = await client.from('patients').upsert(
      {
        profile_id: userId,
        first_name: dto.firstName,
        last_name: dto.lastName,
        birth_date: dto.birthDate,
        dni: dto.dni,
        phone: dto.phone,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'profile_id' },
    );

    if (error) {
      // El DNI es UNIQUE: si ya lo usa otro paciente, avisamos claro (409) sin
      // exponer de quién es (no filtramos datos de terceros).
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('Ese DNI ya está registrado.');
      }
      throw new InternalServerErrorException(
        'No pudimos guardar tu perfil. Probá de nuevo en unos minutos.',
      );
    }

    return this.getMyProfile(accessToken, userId);
  }

  /**
   * Reemplaza los datos vitales del paciente (ENG-134, consumido por ENG-136).
   *
   * **Reemplazo y no merge:** lo que no viene en el DTO queda en `null`. Es lo
   * que permite borrar una alergia, y evita la ambigüedad de un PATCH, que no
   * podría distinguir "no toqué las alergias" de "ya no tengo alergias". En una
   * ficha de emergencia una alergia fantasma es tan peligrosa como una que
   * falta, así que el formulario manda el bloque completo cada vez.
   *
   * **No crea la fila.** `first_name` y `last_name` son NOT NULL y nacen con el
   * perfil (ENG-47): un paciente que no lo completó todavía no tiene fila, y
   * cargar datos clínicos sin nombre no tendría a quién atribuirlos. Sale como
   * 409 con un mensaje que dice qué hacer, igual que `MediPassService`.
   *
   * RLS (`patients_update_own`) respalda en la base que solo pueda tocar su
   * propia fila; el `.eq('profile_id', userId)` es la misma condición del lado
   * de la aplicación.
   */
  async updateMyVitalInfo(
    accessToken: string,
    userId: string,
    dto: UpdateVitalInfoDto,
  ): Promise<PatientProfile> {
    const client = this.supabase.getClientForToken(accessToken);

    const { data, error } = await client
      .from('patients')
      .update({
        sex: dto.sex ?? null,
        blood_type: dto.bloodType ?? null,
        allergies: dto.allergies ?? null,
        medications: dto.medications ?? null,
        conditions: dto.conditions ?? null,
        emergency_contact: dto.emergencyContact ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('profile_id', userId)
      .select('profile_id');

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos guardar tus datos vitales. Probá de nuevo en unos minutos.',
      );
    }

    // Sin filas afectadas: el perfil no existe todavía. No se distingue de un
    // bloqueo de RLS, y está bien que no se distinga: en los dos casos lo único
    // que el paciente puede hacer es completar su perfil.
    if (!data || data.length === 0) {
      throw new ConflictException(
        'Completá tu perfil antes de cargar tus datos vitales.',
      );
    }

    return this.getMyProfile(accessToken, userId);
  }

  /** Valida que la fecha de nacimiento no sea futura ni absurdamente antigua.
   *  El formato (AAAA-MM-DD) ya lo garantizó el DTO. */
  private assertValidBirthDate(birthDate: string): void {
    const date = new Date(`${birthDate}T00:00:00Z`);
    const today = new Date();

    if (date.getTime() > today.getTime()) {
      throw new BadRequestException(
        'La fecha de nacimiento no puede ser futura.',
      );
    }

    const oldest = new Date(today);
    oldest.setUTCFullYear(oldest.getUTCFullYear() - MAX_AGE_YEARS);
    if (date.getTime() < oldest.getTime()) {
      throw new BadRequestException(
        'Revisá la fecha de nacimiento: la edad no es válida.',
      );
    }
  }

  private toProfile(row: PatientRow): PatientProfile {
    return {
      profileId: row.profile_id,
      firstName: row.first_name,
      lastName: row.last_name,
      birthDate: row.birth_date,
      dni: row.dni,
      phone: row.phone,
      completed: true,
      sex: row.sex,
      bloodType: row.blood_type,
      // Se devuelven tal cual se guardaron: es lo que el formulario mandó y es
      // lo que tiene que volver a precargar. El saneado es cosa de la lectura
      // del MediPass, no de la edición del propio paciente.
      allergies: (row.allergies as VitalAllergy[] | null) ?? null,
      medications: (row.medications as VitalMedication[] | null) ?? null,
      conditions: (row.conditions as VitalCondition[] | null) ?? null,
      emergencyContact: (row.emergency_contact as VitalContact | null) ?? null,
    };
  }

  private emptyProfile(userId: string): PatientProfile {
    return {
      profileId: userId,
      firstName: null,
      lastName: null,
      birthDate: null,
      dni: null,
      phone: null,
      completed: false,
      sex: null,
      bloodType: null,
      allergies: null,
      medications: null,
      conditions: null,
      emergencyContact: null,
    };
  }
}
