import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { BOOKING_HORIZON_DAYS } from './../src/appointments/appointments.service';
import { MANUAL_CLOSE_HOURS_AFTER } from './../src/appointments/manual-close';
import { UNPAID_HOLD_MS } from './../src/appointments/unpaid-hold';
import { LEGAL_VERSION } from './../src/legal/legal';
import { CODE_TTL_MS, SESSION_TTL_MS } from './../src/medipass/medipass.config';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  MAX_FULL_REFUND_HOURS,
  MAX_POLICY_HOURS,
  MIN_PARTIAL_REFUND_PERCENT,
} from './../src/professionals/cancellation-policy';
import {
  JOIN_GRACE_MINUTES_AFTER,
  JOIN_OPENS_MINUTES_BEFORE,
} from './../src/video/consultation.config';

/**
 * ENG-229 — `GET /config`: las reglas que leen la web y la app, sin sesión y
 * con los mismos valores que aplica el backend.
 */
describe('GET /config (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('responde sin sesión, cacheable, con las constantes del backend', async () => {
    const res = await request(app.getHttpServer()).get('/config').expect(200);

    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toEqual({
      currency: 'ARS',
      legalVersion: LEGAL_VERSION,
      booking: {
        horizonDays: BOOKING_HORIZON_DAYS,
        paymentWindowMinutes: UNPAID_HOLD_MS / 60_000,
      },
      videoConsultation: {
        opensMinutesBefore: JOIN_OPENS_MINUTES_BEFORE,
        graceMinutesAfter: JOIN_GRACE_MINUTES_AFTER,
      },
      appointments: { manualCloseHoursAfter: MANUAL_CLOSE_HOURS_AFTER },
      medipass: {
        codeMinutes: CODE_TTL_MS / 60_000,
        sessionMinutes: SESSION_TTL_MS / 60_000,
      },
      cancellationPolicy: {
        maxHours: MAX_POLICY_HOURS,
        maxFullRefundHours: MAX_FULL_REFUND_HOURS,
        minPartialRefundPercent: MIN_PARTIAL_REFUND_PERCENT,
      },
    });
  });

  it('los minutos son enteros: un cliente los muestra tal cual', async () => {
    const res = await request(app.getHttpServer()).get('/config').expect(200);
    const body = res.body as {
      booking: { paymentWindowMinutes: number };
      medipass: { codeMinutes: number; sessionMinutes: number };
    };
    for (const value of [
      body.booking.paymentWindowMinutes,
      body.medipass.codeMinutes,
      body.medipass.sessionMinutes,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
