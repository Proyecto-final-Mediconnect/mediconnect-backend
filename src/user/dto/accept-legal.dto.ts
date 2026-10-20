import { Equals } from 'class-validator';
import { LEGAL_NOT_ACCEPTED_MESSAGE, LEGAL_VERSION } from '../../legal/legal';

/**
 * `POST /me/legal-acceptance` (ENG-140). Lleva la versión que el usuario leyó:
 * si no es la vigente, los textos cambiaron mientras tenía la pantalla abierta y
 * no se registra una aceptación de algo que no vio.
 */
export class AcceptLegalDto {
  @Equals(LEGAL_VERSION, { message: LEGAL_NOT_ACCEPTED_MESSAGE })
  version!: string;
}
