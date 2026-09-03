// ENG-61 — Métricas del spike de MercadoPago Checkout.
//
// Mide las tres latencias que decidían si esta integración entra o no en el
// Release 2, y verifica el criterio 2 del spike (webhook firmado y verificado)
// sin depender de que MercadoPago nos notifique durante la corrida:
//
//   1. Crear una preferencia de Checkout Pro (`POST /checkout/preferences`).
//   2. Consultar el estado de un pago (`GET /v1/payments/:id`), que es lo que
//      ENG-64 hace en CADA webhook: si esto es lento, el webhook es lento.
//   3. Verificar la firma HMAC de una notificación, que corre en el mismo
//      camino y hay que saber si pesa algo frente a la llamada de red.
//
// Ejecutar:
//   pnpm run metrics:mercadopago
//
// Sin credenciales (CI, local recién clonado) mide solo la parte offline —la
// firma— y reporta el resto como no medido, en vez de fallar. Con un token
// `TEST-` mide las tres. NUNCA corre con `APP_USR-`: crear preferencias
// productivas desde un script de métricas es plata real.

import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  buildManifest,
  verifyWebhookSignature,
} from '../src/payments/mercadopago-signature';
import { MercadoPagoService } from '../src/payments/mercadopago.service';

const ITERATIONS = Number(process.env.METRICS_ITERATIONS ?? 20);
/** La firma es barata: con 20 muestras el ruido del reloj domina. */
const SIGNATURE_ITERATIONS = Number(
  process.env.METRICS_SIGNATURE_ITERATIONS ?? 10_000,
);

const env = process.env;
const accessToken = env.MERCADOPAGO_ACCESS_TOKEN;
const webhookSecret = env.MERCADOPAGO_WEBHOOK_SECRET ?? 'secreto-de-medicion';

const config = {
  get: (key: string) => env[key],
  getOrThrow: (key: string) => {
    const value = env[key];
    if (value === undefined) throw new Error(`falta ${key}`);
    return value;
  },
} as unknown as ConfigService;

const mercadopago = new MercadoPagoService(config);

function percentile(sorted: number[], p: number): number {
  // Nearest-rank, igual que en las métricas del catálogo (ENG-49).
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

function report(label: string, samples: number[], unit = 'ms'): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((t, s) => t + s, 0) / samples.length;
  console.log(
    `  ${label.padEnd(38)} n=${String(samples.length).padStart(5)}  ` +
      `media=${mean.toFixed(3)}${unit}  ` +
      `p50=${percentile(sorted, 50).toFixed(3)}${unit}  ` +
      `p95=${percentile(sorted, 95).toFixed(3)}${unit}  ` +
      `max=${sorted[sorted.length - 1].toFixed(3)}${unit}`,
  );
}

/** Cronometra una promesa y devuelve el tiempo en ms. */
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
}

/**
 * Costo de verificar una firma. Corre siempre: no necesita credenciales y es la
 * única parte del camino del webhook que es nuestra, así que si algún día el
 * endpoint se pone lento, este número dice si el problema es propio o de
 * MercadoPago.
 */
function measureSignature(): void {
  const ts = String(Math.floor(Date.now() / 1000));
  const dataId = '1234567890';
  const requestId = 'req-metrics';
  const v1 = createHmac('sha256', webhookSecret)
    .update(buildManifest(dataId, requestId, ts))
    .digest('hex');

  const input = {
    signatureHeader: `ts=${ts},v1=${v1}`,
    requestId,
    dataId,
    secret: webhookSecret,
  };

  // Una pasada de calentamiento: el JIT de la primera llamada mide otra cosa.
  for (let i = 0; i < 1000; i++) verifyWebhookSignature(input);

  const samples: number[] = [];
  for (let i = 0; i < SIGNATURE_ITERATIONS; i++) {
    const start = performance.now();
    const result = verifyWebhookSignature(input);
    samples.push(performance.now() - start);
    if (!result.valid) throw new Error('la firma de referencia no validó');
  }

  console.log('\nVerificación de firma (offline, sin red):');
  report('verifyWebhookSignature', samples);
}

/** Latencias contra la API de MercadoPago. Solo con credenciales de prueba. */
async function measureApi(): Promise<void> {
  const notificationUrl =
    env.MERCADOPAGO_NOTIFICATION_URL ?? 'https://example.org/webhooks';

  console.log(`\nAPI de MercadoPago (sandbox, ${ITERATIONS} iteraciones):`);

  const preferenceSamples: number[] = [];
  let lastPreferenceId = '';

  for (let i = 0; i < ITERATIONS; i++) {
    const reference = `spike-eng61-metrics-${Date.now()}-${i}`;
    const [preference, ms] = await timed(() =>
      mercadopago.createPreference({
        externalReference: reference,
        notificationUrl,
        item: {
          title: 'Medición ENG-61',
          quantity: 1,
          unitPrice: 100,
          currencyId: 'ARS',
        },
        backUrls: {
          success: 'http://localhost:5173/spike/mercadopago?resultado=ok',
          failure: 'http://localhost:5173/spike/mercadopago?resultado=error',
          pending:
            'http://localhost:5173/spike/mercadopago?resultado=pendiente',
        },
        idempotencyKey: reference,
      }),
    );
    preferenceSamples.push(ms);
    lastPreferenceId = preference.id;
  }

  report('POST /checkout/preferences', preferenceSamples);
  console.log(`  (última preferencia: ${lastPreferenceId})`);

  // El GET del pago es lo que corre en cada webhook de ENG-64. Se necesita un
  // payment_id real: sale de pagar una preferencia a mano en el sandbox y
  // pasarlo por env. Sin él, esta parte queda sin medir y se dice.
  const paymentId = env.METRICS_PAYMENT_ID;
  if (!paymentId) {
    console.log(
      '\n  GET /v1/payments/:id — NO MEDIDO.\n' +
        '  Necesita un pago real del sandbox. Pagá una preferencia con una tarjeta\n' +
        '  de prueba y volvé a correr con METRICS_PAYMENT_ID=<id>.',
    );
    return;
  }

  const paymentSamples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const [, ms] = await timed(() => mercadopago.getPayment(paymentId));
    paymentSamples.push(ms);
  }
  report('GET /v1/payments/:id', paymentSamples);
}

async function main(): Promise<void> {
  console.log('\n=== ENG-61 — Métricas del spike de MercadoPago ===');

  measureSignature();

  if (!accessToken) {
    console.log(
      '\nAPI de MercadoPago — NO MEDIDA: falta MERCADOPAGO_ACCESS_TOKEN.\n' +
        'Es lo esperado en CI y en un clon recién hecho. Para medirla hace falta\n' +
        'una cuenta de prueba de MercadoPago (ver el informe del spike).',
    );
    return;
  }

  // Sandbox y producción comparten host: sin este corte, un APP_USR- en el
  // entorno haría que este script cree preferencias reales en bucle.
  if (!mercadopago.isSandbox()) {
    throw new Error(
      'MERCADOPAGO_ACCESS_TOKEN no es de prueba (falta el prefijo TEST-). ' +
        'Este script no corre contra credenciales productivas.',
    );
  }

  await measureApi();
}

main()
  .then(() => console.log('\nListo.\n'))
  .catch((e: unknown) => {
    console.error('❌ Métricas fallaron:', e);
    process.exitCode = 1;
  });
