import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Si la aceptación de los textos legales se **exige** o solo se **registra**
 * (ENG-140).
 *
 * Existe por un problema de despliegue, no de producto. El backend y la web son
 * dos servicios distintos en Render, con deploys independientes disparados por
 * el mismo push a `main`. Si el backend exigiera la aceptación desde el momento
 * en que se mergea, entre su deploy y el de la web habría una ventana en la que:
 *
 * - el registro responde 400, porque la web vieja no manda
 *   `acceptedLegalVersion` y el DTO lo exige; y
 * - **todo usuario existente** recibe 403 en cualquier ruta autenticada, con una
 *   web que todavía no tiene la pantalla para aceptar.
 *
 * Al revés rompe igual: una web nueva contra el backend viejo también falla el
 * registro, porque el `ValidationPipe` corre con `forbidNonWhitelisted` y
 * rechaza el campo de más. O sea que no hay orden de merge que lo evite.
 *
 * Con el flag apagado el backend guarda la aceptación de quien la mande y no
 * bloquea a nadie, así que se puede desplegar primero y solo. Se prende cuando
 * la web (ENG-140) y el build mobile con el pedido de aceptación (ENG-143) ya
 * están publicados. El procedimiento está en
 * `docs/security/legal-enforcement.md`.
 *
 * **Apagado por default a propósito:** un entorno nuevo, o un `.env` sin la
 * variable, arranca en el estado que no rompe nada.
 */
@Injectable()
export class LegalEnforcement {
  constructor(private readonly config: ConfigService) {}

  /**
   * `true` solo con `LEGAL_ENFORCEMENT=true`. Cualquier otro valor —ausente,
   * vacío, `1`, `yes`— es `false`: para una barrera que bloquea el acceso a la
   * aplicación entera, conviene que el único valor que la prende sea explícito.
   */
  isEnabled(): boolean {
    return this.config.get<string>('LEGAL_ENFORCEMENT') === 'true';
  }
}
