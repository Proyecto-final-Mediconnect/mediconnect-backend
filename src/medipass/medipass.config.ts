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
 * Reintentos de la generación del código ante una colisión (ENG-170).
 *
 * Desde ENG-170 `medipass_codes.code` es único, así que sortear un código que ya
 * existe devuelve `P2002` en lugar de insertar un duplicado. Reintentar es lo
 * correcto: el código es aleatorio y el siguiente sorteo es independiente.
 *
 * Tres alcanza de sobra. Con 28^8 combinaciones, la probabilidad de que tres
 * sorteos consecutivos colisionen es despreciable incluso con millones de filas
 * acumuladas; si igual pasara, es mejor un 500 que un bucle.
 */
export const CODE_MAX_ATTEMPTS = 3;

/**
 * Techo **global** del canje, en intentos por minuto para toda la instancia
 * (ENG-170, hallazgo 2 de ENG-105).
 *
 * El límite de 10/min del canje es **por IP**, y el ataque que importa no viene
 * de una IP. Un atacante no quiere la ficha de alguien en particular: quiere
 * *una*, de cualquiera, así que su probabilidad por intento es `N/28^8` con `N`
 * = códigos vigentes. Desde una IP eso son décadas; con una botnet de 10.000 IPs
 * son 100.000 intentos por minuto y el 50 % de probabilidad de sacar una ficha
 * al azar en **1,8 días**.
 *
 * 120/min lleva ese número a ~4,2 años y sigue estando muy por encima del uso
 * real: el canje legítimo es un médico de guardia escaneando un QR, no tráfico
 * de volumen.
 *
 * **El tradeoff asumido:** un techo global es por definición un vector de
 * denegación de servicio sobre la propia función, porque alguien puede quemarlo
 * a propósito. Se acepta porque el número solo lo alcanza un abuso grosero y
 * porque `GET /medipass/sessions/:id` **no** entra en este límite: las sesiones
 * ya abiertas siguen funcionando, así que un médico en medio de una consulta no
 * se queda sin la ficha. Lo único que se bloquea es abrir accesos nuevos.
 */
export const CANJE_GLOBAL_LIMIT = 120;

/** Nombre del throttler del techo global. Lo registra `AppModule`. */
export const CANJE_GLOBAL_THROTTLER = 'medipassCanje';

/**
 * Clave fija del contador global.
 *
 * `ThrottlerGuard` cuenta por lo que devuelve `getTracker`, que normalmente es
 * la IP. Devolver una constante para este throttler es lo que convierte el
 * límite en global: todas las requests caen en el mismo contador.
 */
export const CANJE_GLOBAL_TRACKER = 'medipass-canje-global';

/**
 * Lo que se le contesta a quien manda un código que no sirve.
 *
 * **Un solo mensaje para "no existe", "venció" y "se revocó".** Distinguirlos le
 * diría a quien prueba códigos cuáles existieron alguna vez, que es justo lo que
 * no tiene que poder averiguar. La web ya lo trata así: cualquier 4xx que no sea
 * 400 de validación se muestra como "Código inválido o vencido".
 */
export const CODIGO_INVALIDO = 'Código inválido o vencido.';
