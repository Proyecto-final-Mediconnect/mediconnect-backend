import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  CARD_TOKEN_LENGTH,
  CODE_ALPHABET,
  CODE_LENGTH,
} from '../medipass.config';

/** El código tal como tiene que llegar: `CODE_LENGTH` caracteres del alfabeto. */
// Armada con constantes del código, no con input de nadie (ENG-166).
// eslint-disable-next-line security/detect-non-literal-regexp
export const CODIGO_PATTERN = new RegExp(
  `^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`,
);

/** Token de la tarjeta de emergencia (ENG-176): base64url de `CARD_TOKEN_LENGTH`. */
// Armada con constantes del código, no con input de nadie (ENG-166).
// eslint-disable-next-line security/detect-non-literal-regexp
export const TARJETA_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${CARD_TOKEN_LENGTH}}$`,
);

/** Saca espacios y guiones: el código se dicta y se escribe "BCD2-3FGH". */
function normalizarCodigo(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/** Recorta un string de texto libre; deja pasar el resto para que lo rechace el validador. */
function recortar(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Abre un acceso de emergencia con el código del MediPass (HU-34, ENG-73).
 *
 * Es el cuerpo del **único endpoint público** del MediPass: lo manda un médico
 * de guardia que escaneó el QR y no tiene cuenta en la plataforma. Así que todo
 * lo que llega acá es de un desconocido y se valida como tal.
 *
 * La normalización se repite acá aunque la web ya la haga (`openEmergencySession`
 * en `medipassApi.ts` saca espacios y pasa a mayúsculas): el endpoint es público
 * y también lo va a llamar la app mobile, así que no se puede confiar en que el
 * cliente lo haya hecho.
 *
 * **La diferencia entre un 400 y un 404 acá es intencional y la web depende de
 * ella.** Un 400 es un problema de los datos de quien consulta —el nombre vacío,
 * la matrícula demasiado larga, el código mal formado— y la pantalla muestra el
 * mensaje tal cual, porque es algo que esa persona puede corregir. Cualquier otro
 * rechazo (el código no existe, venció, se revocó) sale como 404 con un mensaje
 * único, para no revelar qué códigos existieron. Si un código mal formado
 * contestara "código inválido", el médico le pediría otro código al paciente en
 * vez de corregir el tipeo.
 */
export class OpenEmergencySessionDto {
  /**
   * El código rotativo que muestra la pantalla del paciente. Obligatorio salvo
   * que venga `tarjeta`: se entra por uno de los dos, nunca por ambos (eso lo
   * rechaza `MediPassService.openSession` con 400).
   */
  @ValidateIf((o: OpenEmergencySessionDto) => o.tarjeta === undefined)
  @Transform(({ value }) => normalizarCodigo(value))
  @IsString({ message: 'El código es obligatorio' })
  @Length(CODE_LENGTH, CODE_LENGTH, {
    message: `El código tiene ${CODE_LENGTH} caracteres`,
  })
  @Matches(CODIGO_PATTERN, {
    message: 'El código tiene caracteres que no corresponden',
  })
  codigo?: string;

  /**
   * El token de la tarjeta de emergencia (ENG-176), el QR fijo que el paciente
   * lleva impreso. Llega en el fragmento de la URL (`#tarjeta=...`), que el
   * navegador no manda a ningún servidor ni deja en ningún log, y la web lo pasa
   * acá. No se normaliza: es base64url y distingue mayúsculas.
   *
   * Un token mal formado es un 400 por el mismo motivo que el código: es algo
   * que quien consulta puede revisar. Uno bien formado que no existe o se
   * desactivó es el mismo 404 genérico.
   */
  @ValidateIf((o: OpenEmergencySessionDto) => o.tarjeta !== undefined)
  @IsString({ message: 'La tarjeta no es válida' })
  @Matches(TARJETA_PATTERN, { message: 'La tarjeta no es válida' })
  tarjeta?: string;

  /**
   * Quién está mirando. **Obligatorio**: el historial de accesos (HU-38,
   * ENG-76) existe para que el paciente vea quién abrió su ficha, y una fila sin
   * nombre no le sirve de nada. Es declarado y no verificado, y así se muestra.
   */
  @Transform(({ value }) => recortar(value))
  @IsString({ message: 'El nombre es obligatorio' })
  @MinLength(2, { message: 'El nombre es obligatorio' })
  @MaxLength(120, { message: 'El nombre es demasiado largo' })
  nombre!: string;

  /**
   * Matrícula profesional, opcional.
   *
   * Opcional porque no todo el que necesita abrir una ficha en una urgencia la
   * tiene a mano, y porque hoy la validación de matrículas es un procedimiento
   * manual (ENG-109): exigirla daría una sensación de verificación que no
   * existe. Se guarda tal como la declara quien consulta.
   */
  @IsOptional()
  @Transform(({ value }) => recortar(value))
  @IsString({ message: 'La matrícula no es válida' })
  @MaxLength(30, { message: 'La matrícula es demasiado larga' })
  matricula?: string;
}
