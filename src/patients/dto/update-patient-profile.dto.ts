import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Normaliza un texto: recorta espacios y colapsa los internos. Se aplica antes
 *  de validar para que " Juan  Pérez " entre como "Juan Pérez". */
const normalize = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

/** Deja solo dígitos (para el DNI: acepta "12.345.678" y lo guarda "12345678"). */
const digitsOnly = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/\D/g, '') : value;

/**
 * Completar/editar el perfil de paciente (ENG-47). A diferencia del profesional
 * —cuya fila la crea el trigger al registrarse— el paciente NO tiene fila en
 * `patients` hasta completar el perfil. Por eso este endpoint es un upsert con
 * PUT: se envían los datos completos y `first_name`/`last_name` (NOT NULL) son
 * obligatorios. Todos los campos son requeridos: el formulario pide los cinco.
 */
export class UpdatePatientProfileDto {
  @Transform(normalize)
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @MaxLength(80, { message: 'El nombre no puede superar los 80 caracteres' })
  firstName!: string;

  @Transform(normalize)
  @IsString()
  @IsNotEmpty({ message: 'El apellido es obligatorio' })
  @MaxLength(80, { message: 'El apellido no puede superar los 80 caracteres' })
  lastName!: string;

  // Fecha de nacimiento en formato ISO (YYYY-MM-DD). El rango razonable (no
  // futura, mayoría/edad plausible) lo valida el service, que necesita comparar
  // contra "hoy".
  @IsDateString(
    { strict: true },
    { message: 'La fecha de nacimiento debe tener formato AAAA-MM-DD' },
  )
  birthDate!: string;

  // DNI argentino: 7 u 8 dígitos. Se aceptan puntos ("12.345.678") y se guardan
  // solo los dígitos. El @@unique de la tabla evita duplicados entre pacientes.
  @Transform(digitsOnly)
  @IsString()
  @Matches(/^\d{7,8}$/, {
    message: 'El DNI debe tener 7 u 8 dígitos (sin puntos ni letras)',
  })
  dni!: string;

  // Teléfono: dígitos, con prefijo/espacios/guiones opcionales. Formato laxo a
  // propósito (líneas fijas, celulares, con o sin +54) — validamos que sea un
  // teléfono plausible, no un formato canónico único.
  @Transform(normalize)
  @IsString()
  @MinLength(6, { message: 'El teléfono es demasiado corto' })
  @MaxLength(20, { message: 'El teléfono es demasiado largo' })
  @Matches(/^\+?[\d\s-]{6,20}$/, {
    message: 'El teléfono solo puede tener números, espacios, guiones y +',
  })
  phone!: string;
}
