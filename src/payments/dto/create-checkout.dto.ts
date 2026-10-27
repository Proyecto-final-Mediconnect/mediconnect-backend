import { IsIn, IsOptional } from 'class-validator';

/** Desde dónde se paga: define adónde vuelve el navegador al terminar. */
export const CHECKOUT_ORIGINS = ['web', 'app'] as const;
export type CheckoutOrigin = (typeof CHECKOUT_ORIGINS)[number];

/**
 * Cuerpo de `POST /appointments/:id/payment` (ENG-172). Opcional entero: la web
 * lo manda vacío, como antes, y vuelve a la web.
 */
export class CreateCheckoutDto {
  @IsOptional()
  @IsIn(CHECKOUT_ORIGINS, { message: "El origen tiene que ser 'web' o 'app'." })
  origen?: CheckoutOrigin;
}
