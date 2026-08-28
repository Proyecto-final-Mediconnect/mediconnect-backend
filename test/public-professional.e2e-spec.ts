import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';

const ISSUER = 'https://project-ref.supabase.co/auth/v1';
const ID = '11111111-1111-4111-8111-111111111111';

/**
 * Perfil público de un profesional (ENG-50) a nivel HTTP con la app real. Es
 * público, así que no hay token: lo único mockeado es Prisma (la fila de
 * `professionals`) y Supabase (que el guard global de otros controllers exige
 * al bootstrapear el módulo, no en esta ruta).
 */
describe('GET /professionals/:id — perfil público (e2e)', () => {
  let app: INestApplication<App>;
  const findFirst = jest.fn();

  const validatedRow = {
    profile_id: ID,
    first_name: 'Ana',
    last_name: 'García',
    bio: 'Cardióloga con 10 años de experiencia.',
    photo_url: 'https://cdn/ana.png',
    consultation_price: '15000.00',
    currency: 'ARS',
    specialties: [{ specialty: { id: 's1', name: 'Cardiología' } }],
    education: [{ id: 'e1', institution: 'UBA', degree: 'Médica', year: 2015 }],
    // Campos internos que la fila real trae y NO deben salir en la respuesta.
    license_number: 'MP-12345',
    status: 'VALIDADO',
    mercadopago_account_id: 'acct_123',
  };

  beforeEach(async () => {
    findFirst.mockReset();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: () => ({ auth: {} }),
        getClientForToken: () => ({ auth: {} }),
        getJWKS: () => ({}),
        getIssuer: () => ISSUER,
      })
      .overrideProvider(PrismaService)
      .useValue({ professional: { findFirst } })
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
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

  it('es público (sin token) y devuelve el perfil completo', async () => {
    findFirst.mockResolvedValue(validatedRow);

    await request(app.getHttpServer())
      .get(`/professionals/${ID}`)
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({
          id: ID,
          firstName: 'Ana',
          lastName: 'García',
          photoUrl: 'https://cdn/ana.png',
          bio: 'Cardióloga con 10 años de experiencia.',
          specialties: [{ id: 's1', name: 'Cardiología' }],
          education: [
            { id: 'e1', institution: 'UBA', degree: 'Médica', year: 2015 },
          ],
          price: 15000,
          currency: 'ARS',
        });
      });
  });

  it('no expone campos sensibles ni internos', async () => {
    findFirst.mockResolvedValue(validatedRow);

    await request(app.getHttpServer())
      .get(`/professionals/${ID}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.licenseNumber).toBeUndefined();
        expect(res.body.license_number).toBeUndefined();
        expect(res.body.status).toBeUndefined();
        expect(res.body.mercadopago_account_id).toBeUndefined();
      });
  });

  it('solo consulta profesionales VALIDADO', async () => {
    findFirst.mockResolvedValue(validatedRow);

    await request(app.getHttpServer()).get(`/professionals/${ID}`).expect(200);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { profile_id: ID, status: 'VALIDADO' },
      }),
    );
  });

  it('404 si el profesional no existe o no está validado', async () => {
    findFirst.mockResolvedValue(null);

    await request(app.getHttpServer()).get(`/professionals/${ID}`).expect(404);
  });

  it('400 si el id no es un UUID', async () => {
    await request(app.getHttpServer())
      .get('/professionals/no-es-uuid')
      .expect(400);
  });

  it('no se traga la ruta protegida: GET /professionals/me sigue pidiendo token (401)', async () => {
    await request(app.getHttpServer()).get('/professionals/me').expect(401);
  });
});
