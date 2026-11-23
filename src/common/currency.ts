/**
 * La moneda de la plataforma: todos los precios están en pesos argentinos
 * (`professionals.currency` y `payments.currency` tienen `DEFAULT 'ARS'`).
 *
 * La informa `GET /config` (ENG-229), así la web y la app no la asumen. Cuando
 * haya profesionales en otra moneda, cada turno ya trae la suya (`currency`).
 */
export const PLATFORM_CURRENCY = 'ARS';
