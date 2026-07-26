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
 *  supabase/migrations/*_professional_photos_bucket.sql. */
const PHOTO_BUCKET = 'professional-photos';

/** Tipos de imagen aceptados para la foto de perfil. La compresión ocurre en el
 *  cliente (web); acá solo validamos y almacenamos. */
const ALLOWED_PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2 MB (ya comprimida en el cliente)

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
  'consultation_price, currency, status, ' +
  'professional_specialties(specialty:specialties(id, name))';

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

    const { data, error } = await client
      .from('professionals')
      .select(PROFILE_SELECT)
      .eq('profile_id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'No pudimos cargar tu perfil. Probá de nuevo en unos minutos.',
      );
    }

    const row = data as unknown as ProfessionalRow | null;
    if (!row) {
      throw new NotFoundException('No se encontró tu perfil profesional.');
    }

    return this.toProfile(row);
  }

  async updateMyProfile(
    accessToken: string,
    userId: string,
    dto: UpdateProfessionalProfileDto,
  ): Promise<ProfessionalProfile> {
    const client = this.supabase.getClientForToken(accessToken);

    // Asegura que el usuario tenga perfil profesional antes de escribir (y da un
    // 404 claro si un paciente llamara este endpoint).
    await this.getMyProfile(accessToken, userId);

    if (dto.specialtyIds) {
      await this.assertSpecialtiesExist(dto.specialtyIds);
    }

    // 1) Campos escalares del perfil (solo los que vengan definidos).
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

    return this.getMyProfile(accessToken, userId);
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
    await this.getMyProfile(accessToken, userId);

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
    // Cache-busting: el nombre de archivo es fijo, así que agregamos un query
    // param con el timestamp para que el browser no muestre la foto vieja.
    const photoUrl = `${publicData.publicUrl}?v=${Date.now()}`;

    const { error: updateError } = await client
      .from('professionals')
      .update({ photo_url: photoUrl, updated_at: new Date().toISOString() })
      .eq('profile_id', userId);

    if (updateError) {
      throw new InternalServerErrorException(
        'Subimos la foto pero no pudimos guardarla en tu perfil. Probá de nuevo.',
      );
    }

    return this.getMyProfile(accessToken, userId);
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
    client: ReturnType<SupabaseService['getClientForToken']>,
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
      photoUrl: row.photo_url,
      consultationPrice:
        row.consultation_price === null ? null : Number(row.consultation_price),
      currency: row.currency,
      status: row.status,
      specialties,
    };
  }
}
