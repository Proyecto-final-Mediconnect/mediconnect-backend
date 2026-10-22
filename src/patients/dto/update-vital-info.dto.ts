import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Recorta un texto; lo que no es string pasa para que lo rechace el validador. */
const recortar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

/**
 * Grupos sanguíneos del sistema ABO con su factor Rh.
 *
 * `0` y no `O`: en Argentina el grupo cero se escribe con cero, y es lo que un
 * paciente va a tipear y lo que un médico espera leer.
 */
const GRUPO_SANGUINEO = /^(0|A|B|AB)[+-]$/;

/**
 * Cuántas entradas se aceptan por lista.
 *
 * No es un límite clínico —nadie tiene treinta alergias— sino de tamaño: la
 * columna es `jsonb` sin tope y esto se devuelve en la ficha de emergencia, que
 * tiene que seguir siendo legible de un vistazo en un celular.
 */
const MAX_ENTRADAS = 30;

/** Una alergia: a qué, y cuán grave. */
export class VitalAllergyDto {
  @Transform(recortar)
  @IsString()
  @MinLength(1, { message: 'Cada alergia tiene que decir a qué' })
  @MaxLength(120, { message: 'La alergia es demasiado larga' })
  que!: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(60, { message: 'La gravedad es demasiado larga' })
  gravedad?: string;
}

/** Una medicación crónica: la droga, la dosis y una nota. */
export class VitalMedicationDto {
  @Transform(recortar)
  @IsString()
  @MinLength(1, { message: 'Cada medicación tiene que decir la droga' })
  @MaxLength(120, { message: 'El nombre de la droga es demasiado largo' })
  droga!: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(60, { message: 'La dosis es demasiado larga' })
  dosis?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(200, { message: 'La nota es demasiado larga' })
  nota?: string;
}

/** Una condición preexistente, con su código de clasificación si se conoce. */
export class VitalConditionDto {
  @Transform(recortar)
  @IsString()
  @MinLength(1, { message: 'Cada condición tiene que tener un nombre' })
  @MaxLength(120, { message: 'El nombre de la condición es demasiado largo' })
  nombre!: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(30, { message: 'El código es demasiado largo' })
  codigo?: string;
}

/** A quién llamar en una urgencia. */
export class VitalContactDto {
  @Transform(recortar)
  @IsString()
  @MinLength(1, { message: 'El contacto de emergencia necesita un nombre' })
  @MaxLength(120, { message: 'El nombre es demasiado largo' })
  nombre!: string;

  @Transform(recortar)
  @IsString()
  @MinLength(6, { message: 'El teléfono del contacto es demasiado corto' })
  @MaxLength(20, { message: 'El teléfono del contacto es demasiado largo' })
  @Matches(/^\+?[\d\s-]{6,20}$/, {
    message: 'El teléfono solo puede tener números, espacios, guiones y +',
  })
  telefono!: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(40, { message: 'El vínculo es demasiado largo' })
  vinculo?: string;
}

/**
 * Los datos vitales del paciente para el MediPass (ENG-134; los consume
 * ENG-136).
 *
 * ## Es un PUT de reemplazo, y el formulario manda siempre todo
 *
 * Va a `PUT /patients/me/vital` y **reemplaza el bloque entero**: lo que no
 * viene queda en `null`. Es deliberado y es lo que hace que una alergia se pueda
 * borrar. Un `PATCH` que dejara los campos ausentes como estaban no tendría
 * forma de distinguir "no toqué las alergias" de "me quedé sin alergias", y en
 * una ficha de emergencia esa diferencia importa: una alergia fantasma es tan
 * mala como una que falta.
 *
 * Por eso el formulario de ENG-136 tiene que mandar el bloque completo en cada
 * guardado, igual que el perfil de ENG-47. `GET /patients/me` devuelve los seis
 * campos para poder precargarlo.
 *
 * ## Por qué un endpoint aparte y no `PUT /patients/me`
 *
 * El perfil de ENG-47 tiene sus cinco campos **obligatorios** porque la fila de
 * `patients` nace ahí. Sumarle seis opcionales mezclaría dos reglas distintas en
 * un mismo PUT: "estos cinco siempre" y "estos seis si vienen". Separados, cada
 * endpoint tiene una regla sola y el formulario del perfil no se toca.
 *
 * ## Los nombres
 *
 * Las claves del DTO van en inglés camelCase, como el resto de la API
 * (`bloodType`, `emergencyContact`). Las claves **de adentro** de las listas van
 * en español (`que`, `gravedad`, `droga`…) porque se guardan tal cual en el
 * `jsonb` y las lee `toVitalBlock`, cuyo contrato lo fijó la web. La costura es
 * fea pero es explícita, y mover cualquiera de los dos lados rompería algo que
 * ya está en producción.
 */
export class UpdateVitalInfoDto {
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(30, { message: 'El sexo es demasiado largo' })
  sex?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @Matches(GRUPO_SANGUINEO, {
    message: 'El grupo sanguíneo tiene que ser 0, A, B o AB con + o - (ej. 0+)',
  })
  bloodType?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ENTRADAS, {
    message: `No se pueden cargar más de ${MAX_ENTRADAS} alergias`,
  })
  @ValidateNested({ each: true })
  @Type(() => VitalAllergyDto)
  allergies?: VitalAllergyDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ENTRADAS, {
    message: `No se pueden cargar más de ${MAX_ENTRADAS} medicaciones`,
  })
  @ValidateNested({ each: true })
  @Type(() => VitalMedicationDto)
  medications?: VitalMedicationDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ENTRADAS, {
    message: `No se pueden cargar más de ${MAX_ENTRADAS} condiciones`,
  })
  @ValidateNested({ each: true })
  @Type(() => VitalConditionDto)
  conditions?: VitalConditionDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => VitalContactDto)
  emergencyContact?: VitalContactDto;
}
