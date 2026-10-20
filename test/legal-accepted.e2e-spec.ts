import {
  Controller,
  Get,
  INestApplication,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { JwtAuthGuard } from './../src/auth/guards/jwt-auth.guard';
import { LEGAL_VERSION } from './../src/legal/legal';
import { LegalEnforcement } from './../src/legal/legal-enforcement';
import { SkipLegal } from './../src/legal/skip-legal.decorator';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const SUB = 'user-id-123';

/**
 * Rutas de prueba montadas sobre el AppModule real: aíslan el guard de la
 * lógica de cualquier módulo, con el mismo pipeline que una ruta de verdad.
 */
@Controller('__legal-probe')
@UseGuards(JwtAuthGuard)
class LegalProbeController {
  @Get()
  guarded() {
    return { ok: true };
  }

  @Get('skip')
  @SkipLegal()
  skipped() {
    return { ok: true };
  }
}

describe('Aceptación legal exigida en el backend (e2e, ENG-140)', () => {
  let app: INestApplication<App>;
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;
  const acceptanceFindUnique = jest.fn();
  const profileFindUnique = jest.fn();

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    acceptanceFindUnique.mockReset();
    profileFindUnique.mockReset();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [LegalProbeController],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: () => ({ auth: {} }),
        getJWKS: () => publicKey,
        getIssuer: () => ISSUER,
      })
      .overrideProvider(PrismaService)
      .useValue({
        profile: { findUnique: profileFindUnique },
        legalAcceptance: { findUnique: acceptanceFindUnique },
      })
      // Barrera prendida: es el estado que prueban los casos de este describe.
      // El apagado, que es con el que se despliega, tiene su propio describe al
      // final del archivo.
      .overrideProvider(LegalEnforcement)
      .useValue({ isEnabled: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  function signToken(): Promise<string> {
    return new SignJWT({ email: 'paciente@test.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('403 LEGAL_NOT_ACCEPTED sin aceptación de la versión vigente', async () => {
    acceptanceFindUnique.mockResolvedValue(null);
    const token = await signToken();

    await request(app.getHttpServer())
      .get('/__legal-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
      .expect((res) => {
        expect(res.body.code).toBe('LEGAL_NOT_ACCEPTED');
        expect(res.body.legalVersion).toBe(LEGAL_VERSION);
      });

    expect(acceptanceFindUnique).toHaveBeenCalledWith({
      where: {
        profile_id_version: { profile_id: SUB, version: LEGAL_VERSION },
      },
      select: { id: true },
    });
  });

  it('200 con la aceptación de la versión vigente', async () => {
    acceptanceFindUnique.mockResolvedValue({ id: 'acc-1' });
    const token = await signToken();

    return request(app.getHttpServer())
      .get('/__legal-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, { ok: true });
  });

  it('401 antes que 403: sin token no consulta la aceptación', async () => {
    await request(app.getHttpServer()).get('/__legal-probe').expect(401);
    expect(acceptanceFindUnique).not.toHaveBeenCalled();
  });

  it('200 sin aceptación en una ruta con @SkipLegal()', async () => {
    acceptanceFindUnique.mockResolvedValue(null);
    const token = await signToken();

    await request(app.getHttpServer())
      .get('/__legal-probe/skip')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, { ok: true });
    expect(acceptanceFindUnique).not.toHaveBeenCalled();
  });

  it('una ruta real con datos de salud también corta con 403', async () => {
    acceptanceFindUnique.mockResolvedValue(null);
    const token = await signToken();

    return request(app.getHttpServer())
      .get('/appointments/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
      .expect((res) => expect(res.body.code).toBe('LEGAL_NOT_ACCEPTED'));
  });

  it('GET /me responde sin aceptación: es lo que le dice a la web que la pida', async () => {
    acceptanceFindUnique.mockResolvedValue(null);
    profileFindUnique.mockResolvedValue({
      id: SUB,
      email: 'paciente@test.com',
      role: 'PACIENTE',
      patient: { first_name: 'Ana', last_name: 'García' },
      professional: null,
      legal_acceptances: [],
    });
    const token = await signToken();

    return request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res) => expect(res.body.legalAccepted).toBe(false));
  });

  it('las rutas públicas no exigen sesión ni aceptación', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    expect(acceptanceFindUnique).not.toHaveBeenCalled();
  });
});

/**
 * El estado con el que este backend se despliega: la aceptación se registra
 * pero no se exige, para poder entrar a producción antes que la web y que el
 * build mobile. Ver `src/legal/legal-enforcement.ts`.
 */
describe('Aceptación legal registrada pero NO exigida (e2e, ENG-140)', () => {
  let app: INestApplication<App>;
  let publicKey: CryptoKey;
  let privateKey: CryptoKey;
  const acceptanceFindUnique = jest.fn();
  const profileFindUnique = jest.fn();

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('ES256'));
  });

  beforeEach(async () => {
    acceptanceFindUnique.mockReset();
    profileFindUnique.mockReset();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [LegalProbeController],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: () => ({ auth: {} }),
        getJWKS: () => publicKey,
        getIssuer: () => ISSUER,
      })
      .overrideProvider(PrismaService)
      .useValue({
        profile: { findUnique: profileFindUnique },
        legalAcceptance: { findUnique: acceptanceFindUnique },
      })
      .overrideProvider(LegalEnforcement)
      .useValue({ isEnabled: () => false })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  function signToken(): Promise<string> {
    return new SignJWT({ email: 'paciente@test.com', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(SUB)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('200 sin aceptación: es lo que evita bloquear a los usuarios existentes', async () => {
    acceptanceFindUnique.mockResolvedValue(null);
    const token = await signToken();

    await request(app.getHttpServer())
      .get('/__legal-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // Ni siquiera consulta: con la barrera apagada no gasta una query por request.
    expect(acceptanceFindUnique).not.toHaveBeenCalled();
  });

  it('401 sin token: apagar la barrera no afecta la autenticación', async () => {
    await request(app.getHttpServer()).get('/__legal-probe').expect(401);
  });
});
