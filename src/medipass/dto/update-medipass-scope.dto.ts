import { IsBoolean } from 'class-validator';

/**
 * `PUT /medipass/me/scope` (ENG-149): el scope entero, un booleano por bloque.
 * `PUT` y no `PATCH`: la pantalla manda siempre los cinco, y así no hay un
 * estado a medio escribir.
 */
export class UpdateMediPassScopeDto {
  @IsBoolean({ message: 'grupoSanguineo tiene que ser verdadero o falso' })
  grupoSanguineo!: boolean;

  @IsBoolean({ message: 'alergias tiene que ser verdadero o falso' })
  alergias!: boolean;

  @IsBoolean({ message: 'medicacion tiene que ser verdadero o falso' })
  medicacion!: boolean;

  @IsBoolean({ message: 'condiciones tiene que ser verdadero o falso' })
  condiciones!: boolean;

  @IsBoolean({ message: 'contacto tiene que ser verdadero o falso' })
  contacto!: boolean;
}
