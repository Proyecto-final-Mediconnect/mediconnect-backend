/**
 * Constantes del MediPass (EP-05; ENG-72, ENG-73, ENG-103, ENG-104).
 *
 * Separadas del service por el mismo motivo que `daily.config.ts` y
 * `mercadopago.config.ts`: son las decisiones de diseño del dominio y se leen
 * sin tener que entrar a la lógica.
 */

/**
 * Alfabeto del código rotativo: 28 caracteres, **sin vocales y sin caracteres
 * ambiguos**.
 *
 * Sin vocales para que el azar no arme una palabra ofensiva en el QR de un
 * paciente. Sin `0`/`O`, `1`/`I`/`L` ni `U`/`V` porque el código se dicta por
 * teléfono en una urgencia, y confundir un cero con una O es exactamente el
 * error que no se puede permitir ahí.
 *
 * Es el mismo alfabeto que ya usa `prisma/seed-demo.ts`: si cambia, los códigos
 * sembrados dejan de parecerse a los reales.
 */
export const CODE_ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXZ';

/** Largo del código. Con `CODE_ALPHABET` da 28^8 ≈ 3,8 × 10^11 combinaciones. */
export const CODE_LENGTH = 8;

/**
 * Cuánto vale un código antes de rotar (ENG-72: cada 5 minutos).
 *
 * La ventana corta es la defensa real contra adivinarlo: con 28^8 combinaciones
 * y 10 intentos por minuto por IP, probar el 0,001 % del espacio llevaría más de
 * setenta mil años, y a los cinco minutos el código que se estaba buscando ya no
 * existe.
 */
export const CODE_TTL_MS = 5 * 60_000;

/**
 * Cuánto dura el acceso de quien canjeó el código (HU-37, ENG-104: 30 minutos).
 *
 * El vencimiento se calcula **al leer** y no se confía en que un job lo
 * materialice a tiempo, igual que la liberación de turnos impagos de ENG-101:
 * ninguna lectura devuelve datos de una sesión vencida aunque nadie la haya
 * marcado todavía.
 */
export const SESSION_TTL_MS = 30 * 60_000;

/**
 * Lo que se le contesta a quien manda un código que no sirve.
 *
 * **Un solo mensaje para "no existe", "venció" y "se revocó".** Distinguirlos le
 * diría a quien prueba códigos cuáles existieron alguna vez, que es justo lo que
 * no tiene que poder averiguar. La web ya lo trata así: cualquier 4xx que no sea
 * 400 de validación se muestra como "Código inválido o vencido".
 */
export const CODIGO_INVALIDO = 'Código inválido o vencido.';
