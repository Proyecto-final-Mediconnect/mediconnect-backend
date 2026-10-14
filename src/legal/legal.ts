/**
 * Versión vigente de los textos legales (ENG-140): términos y condiciones,
 * política de privacidad y consentimiento para tratar datos de salud.
 *
 * Los textos viven en la web (`/legales`). **Cuando cambian, hay que subir esta
 * versión y la de la web a la vez**: con la versión nueva, `GET /me` informa
 * que el usuario no la aceptó y la web le pide que la acepte antes de seguir.
 *
 * Formato `AAAA-MM-DD`, la fecha de publicación de los textos.
 */
export const LEGAL_VERSION = '2026-10-13';

/**
 * Lo que responde el backend cuando falta la aceptación, o llega una versión
 * que no es la vigente (una pestaña abierta desde antes de que cambiaran los
 * textos). Mismo mensaje en los dos casos: en los dos, lo que hay que hacer es
 * leer y aceptar los textos de ahora.
 */
export const LEGAL_NOT_ACCEPTED_MESSAGE =
  'Para usar MediConnect tenés que aceptar los términos y condiciones, la política de privacidad y el consentimiento para el tratamiento de tus datos de salud.';
