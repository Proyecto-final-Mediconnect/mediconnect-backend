import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdatePatientProfileDto } from './dto/update-patient-profile.dto';

/** Edad máxima plausible; acota fechas de nacimiento absurdas (typos de siglo). */
const MAX_AGE_YEARS = 120;

/** Código de Postgres para violación de UNIQUE (dni duplicado). */
const PG_UNIQUE_VIOLATION = '23505';

/** Columnas del perfil de paciente que expone/gestiona este módulo. */
const PROFILE_SELECT =
  'profile_id, first_name, last_name, birth_date, dni, phone';

/** Forma cruda de la fila de `patients` tal como la devuelve PostgREST. */
interface PatientRow {
  profile_id: string;
  first_name: string;
  last_name: string;
  birth_date: string | null;
  dni: string | null;
  phone: string | null;
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
    };
  }
}
