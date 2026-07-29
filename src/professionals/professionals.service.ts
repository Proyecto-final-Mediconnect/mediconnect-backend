import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateProfessionalProfileDto } from './dto/update-professional-profile.dto';

/** Bucket de Supabase Storage donde viven las fotos de perfil de profesionales.
 *  Su creación y políticas RLS se versionan en
 *  prisma/migrations/20260729000000_eng48_professional_profile_grants/. */
const PHOTO_BUCKET = 'professional-photos';

/** Tipos de imagen aceptados para la foto de perfil. La compresión ocurre en el
 *  cliente (web); acá solo validamos y almacenamos. */
const ALLOWED_PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];

/** Tope real de la foto de perfil (ya comprimida en el cliente). Lo valida este
 *  service para poder devolver un 400 con un mensaje claro; el tope duro
 *  anti-abuso, mucho más alto, lo pone el `FileInterceptor` del controller. */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2 MB

/** Extensión de archivo según el MIME type de la imagen subida. */
const PHOTO_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Especialidad del catálogo (id + nombre). */
export interface SpecialtyRow {
  id: string;
  name: string;
}

/** Forma cruda de la fila de `professionals` con sus especialidades anidadas. */
interface ProfessionalRow {
  profile_id: string;
  first_name: string;
  last_name: string;
  license_number: string;
  bio: string | null;
  photo_url: string | null;
  // PostgREST devuelve `numeric` como string; lo normalizamos a number al salir.
  consultation_price: string | number | null;
  currency: string;
  status: string;
  // Se usa para versionar la URL de la foto (ver `withPhotoVersion`).
  updated_at: string;
  professional_specialties: { specialty: SpecialtyRow | null }[] | null;
}

/** Perfil profesional expuesto por la API (camelCase, precio normalizado). */
export interface ProfessionalProfile {
  profileId: string;
  firstName: string;
  lastName: string;
  licenseNumber: string;
  bio: string | null;
  photoUrl: string | null;
  consultationPrice: number | null;
  currency: string;
  status: string;
  specialties: SpecialtyRow[];
}

const PROFILE_SELECT =
  'profile_id, first_name, last_name, license_number, bio, photo_url, ' +
  'consultation_price, currency, status, updated_at, ' +
  'professional_specialties(specialty:specialties(id, name))';

/** Cliente de Supabase scopeado al JWT del profesional (RLS evalúa `auth.uid()`
 *  como su `profiles.id`). Se crea UNO por request y se pasa a los helpers. */
type UserClient = ReturnType<SupabaseService['getClientForToken']>;

/** La escritura ya se hizo y lo que falló es la relectura del perfil. Decir "no
 *  pudimos guardar" acá sería mentira: el cambio está aplicado. */
const PROFILE_REREAD_ERROR =
  'Guardamos tus cambios, pero no pudimos volver a leer tu perfil. Recargá la página.';

/**
 * Agrega a la URL pública de la foto un `?v=` derivado de `updated_at`. La ruta en
 * Storage es fija por usuario (`<uid>/avatar.ext`), así que sin esto el browser
 * seguiría mostrando la foto anterior.
 *
 * Se hace al salir y NO se persiste (review de #19): lo que queda en
 * `professionals.photo_url` es la URL canónica, y la versión se deriva de un valor
 * estable de la fila en vez de un `Date.now()` distinto en cada lectura.
 */
function withPhotoVersion(photoUrl: string, updatedAt: string): string {
  const version = Date.parse(updatedAt);
  if (Number.isNaN(version)) return photoUrl;
  return `${photoUrl}${photoUrl.includes('?') ? '&' : '?'}v=${version}`;
}

@Injectable()
export class ProfessionalsService {
  constructor(private readonly supabase: SupabaseService) {}

  /** Catálogo curado de especialidades (público, para el selector del perfil
   *  y el filtro del catálogo — fuente única, ver ENG-48/ENG-89). */
  async listSpecialties(): Promise<SpecialtyRow[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('specialties')
      .select('id, name')
      .order('name');

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos cargar las especialidades. Probá de nuevo en unos minutos.',
      );
    }

    return (data as unknown as SpecialtyRow[] | null) ?? [];
  }

  /** Perfil del profesional autenticado. RLS garantiza que solo pueda leer el
   *  suyo (el cliente va scopeado a su JWT). */
  async getMyProfile(
    accessToken: string,
    userId: string,
  ): Promise<ProfessionalProfile> {
    const client = this.supabase.getClientForToken(accessToken);
    return this.readProfile(client, userId);
  }

  async updateMyProfile(
    accessToken: string,
    userId: string,
    dto: UpdateProfessionalProfileDto,
  ): Promise<ProfessionalProfile> {
    const client = this.supabase.getClientForToken(accessToken);

    // Asegura que el usuario tenga perfil profesional antes de escribir (y da un
    // 404 claro si un paciente llamara este endpoint). Sonda barata: no trae el
    // perfil completo, y si falla el mensaje habla de guardar, no de cargar.
    await this.assertProfileExists(
      client,
      userId,
      'No pudimos guardar tu perfil. Probá de nuevo en unos minutos.',
    );

    if (dto.specialtyIds) {
      await this.assertSpecialtiesExist(dto.specialtyIds);
    }

    // 1) Campos escalares del perfil (solo los que vengan definidos).
    //    Ojo con la diferencia entre `undefined` y `null`: omitir el campo es "no
    //    lo toques", mandarlo en null es "borralo" (ej. dejar de publicar precio).
    const patch: Record<string, string | number | null> = {};
    if (dto.bio !== undefined) patch.bio = dto.bio;
    if (dto.consultationPrice !== undefined) {
      patch.consultation_price = dto.consultationPrice;
    }

    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      const { error } = await client
        .from('professionals')
        .update(patch)
        .eq('profile_id', userId);

      if (error) {
        throw new InternalServerErrorException(
          'No pudimos guardar tu perfil. Probá de nuevo en unos minutos.',
        );
      }
    }

    // 2) Especialidades: reemplazo completo (borrar + insertar). Nota: sin
    //    transacción entre ambas llamadas — aceptable en el MVP; si el insert
    //    fallara, el profesional reintenta guardando de nuevo.
    if (dto.specialtyIds) {
      await this.replaceSpecialties(client, userId, dto.specialtyIds);
    }

    return this.readProfile(client, userId, PROFILE_REREAD_ERROR);
  }

  /** Sube la foto de perfil a Storage y guarda su URL pública en el perfil. */
  async uploadPhoto(
    accessToken: string,
    userId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
  ): Promise<ProfessionalProfile> {
    if (!ALLOWED_PHOTO_MIME.includes(file.mimetype)) {
      throw new BadRequestException('La foto debe ser JPG, PNG o WEBP.');
    }
    if (file.size > MAX_PHOTO_BYTES) {
      throw new BadRequestException('La foto no puede superar los 2 MB.');
    }

    const client = this.supabase.getClientForToken(accessToken);
    await this.assertProfileExists(
      client,
      userId,
      'No pudimos guardar tu foto de perfil. Probá de nuevo en unos minutos.',
    );

    const ext = PHOTO_EXT_BY_MIME[file.mimetype] ?? 'jpg';
    // Ruta fija por usuario (upsert) → una sola foto vigente, sin acumular
    // archivos huérfanos. El prefijo con userId habilita la política RLS de
    // Storage ("cada uno escribe solo en su carpeta").
    const path = `${userId}/avatar.${ext}`;

    const { error: uploadError } = await client.storage
      .from(PHOTO_BUCKET)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      throw new InternalServerErrorException(
        'No pudimos subir la foto. Probá de nuevo en unos minutos.',
      );
    }

    const { data: publicData } = client.storage
      .from(PHOTO_BUCKET)
      .getPublicUrl(path);

    // Se persiste la URL canónica, sin query params. El cache-busting lo agrega
    // `withPhotoVersion` al serializar, derivado de `updated_at`.
    const { error: updateError } = await client
      .from('professionals')
      .update({
        photo_url: publicData.publicUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('profile_id', userId);

    if (updateError) {
      throw new InternalServerErrorException(
        'Subimos la foto pero no pudimos guardarla en tu perfil. Probá de nuevo.',
      );
    }

    return this.readProfile(client, userId, PROFILE_REREAD_ERROR);
  }

  /** Lee el perfil del profesional con sus especialidades. `onReadError` permite
   *  distinguir "no pudimos cargar tu perfil" de la relectura posterior a una
   *  escritura que sí funcionó. */
  private async readProfile(
    client: UserClient,
    userId: string,
    onReadError = 'No pudimos cargar tu perfil. Probá de nuevo en unos minutos.',
  ): Promise<ProfessionalProfile> {
    const { data, error } = await client
      .from('professionals')
      .select(PROFILE_SELECT)
      .eq('profile_id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(onReadError);
    }

    const row = data as unknown as ProfessionalRow | null;
    if (!row) {
      throw new NotFoundException('No se encontró tu perfil profesional.');
    }

    return this.toProfile(row);
  }

  /** Confirma que el usuario tenga perfil profesional antes de escribir. Si la
   *  consulta falla, el mensaje tiene que hablar de la operación que el usuario
   *  pidió (guardar), no de una lectura que él nunca pidió. */
  private async assertProfileExists(
    client: UserClient,
    userId: string,
    onError: string,
  ): Promise<void> {
    const { data, error } = await client
      .from('professionals')
      .select('profile_id')
      .eq('profile_id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(onError);
    }
    if (!data) {
      throw new NotFoundException('No se encontró tu perfil profesional.');
    }
  }

  /** Valida que todos los IDs existan en el catálogo curado. */
  private async assertSpecialtiesExist(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const { data, error } = await this.supabase
      .getClient()
      .from('specialties')
      .select('id')
      .in('id', ids);

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos validar las especialidades. Probá de nuevo en unos minutos.',
      );
    }

    const found = (data as unknown as { id: string }[] | null) ?? [];
    if (found.length !== ids.length) {
      throw new BadRequestException(
        'Alguna especialidad no existe en el catálogo.',
      );
    }
  }

  private async replaceSpecialties(
    client: UserClient,
    userId: string,
    specialtyIds: string[],
  ): Promise<void> {
    const { error: deleteError } = await client
      .from('professional_specialties')
      .delete()
      .eq('professional_id', userId);

    if (deleteError) {
      throw new InternalServerErrorException(
        'No pudimos actualizar tus especialidades. Probá de nuevo en unos minutos.',
      );
    }

    if (specialtyIds.length === 0) return;

    const rows = specialtyIds.map((specialtyId) => ({
      professional_id: userId,
      specialty_id: specialtyId,
    }));

    const { error: insertError } = await client
      .from('professional_specialties')
      .insert(rows);

    if (insertError) {
      throw new InternalServerErrorException(
        'No pudimos actualizar tus especialidades. Probá de nuevo en unos minutos.',
      );
    }
  }

  private toProfile(row: ProfessionalRow): ProfessionalProfile {
    const specialties = (row.professional_specialties ?? [])
      .map((link) => link.specialty)
      .filter((s): s is SpecialtyRow => s !== null);

    return {
      profileId: row.profile_id,
      firstName: row.first_name,
      lastName: row.last_name,
      licenseNumber: row.license_number,
      bio: row.bio,
      photoUrl: row.photo_url
        ? withPhotoVersion(row.photo_url, row.updated_at)
        : null,
      consultationPrice:
        row.consultation_price === null ? null : Number(row.consultation_price),
      currency: row.currency,
      status: row.status,
      specialties,
    };
  }
}
