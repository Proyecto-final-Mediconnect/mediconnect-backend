import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Cuerpo de `POST /payments/spike/preferences`. Todo opcional: el spike tiene
 *  que poder ejecutarse con un POST vacío y sin pensar. */
export class CreateSpikePreferenceDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  /**
   * Monto en pesos. Acotado a propósito: aunque el spike solo corre con
   * credenciales de prueba, un tope evita que un copy-paste de este endpoint a
   * producción genere una preferencia por un millón.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  amount?: number;
}
