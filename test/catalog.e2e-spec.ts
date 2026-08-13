import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { CatalogService } from './../src/catalog/catalog.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { SupabaseService } from './../src/supabase/supabase.service';

/**
 * ENG-49 — stack HTTP del catálogo público: routing, ValidationPipe sobre el
 * query string y ausencia de guard de autenticación. La lógica de la query
 * vive en catalog.service.spec.ts (unit) y catalog.integration.spec.ts (BD
 * real); acá Prisma está mockeado.
 */
describe('Catálogo público (e2e)', () => {
  let app: INestApplication<App>;
  const listProfessionals = jest.fn();

  const emptyPage = {
    data: [],
    meta: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false },
  };

  beforeEach(async () => {
    listProfessionals.mockReset().mockResolvedValue(emptyPage);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Sin BD ni Supabase: el e2e cubre el borde HTTP, no la persistencia.
      .overrideProvider(CatalogService)
      .useValue({ listProfessionals })
      // El PrismaModule global conectaría a la base real en onModuleInit.
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(SupabaseService)
      .useValue({
        getClient: () => ({ auth: {} }),
        getJWKS: () => undefined,
        getIssuer: () => 'https://project-ref.supabase.co/auth/v1',
      })
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

  describe('GET /catalog/professionals', () => {
    it('200 sin enviar cookie de sesión (la búsqueda es pública)', () => {
      return request(app.getHttpServer())
        .get('/catalog/professionals')
        .expect(200)
        .expect((res) => {
          expect(res.body).toEqual(emptyPage);
        });
    });

    it('nunca responde 401 aunque la cookie de sesión sea basura', () => {
      return request(app.getHttpServer())
        .get('/catalog/professionals')
        .set('Cookie', ['sb-access-token=token-invalido'])
        .expect(200);
    });

    it('aplica page=1 y limit=20 cuando no vienen en el query', async () => {
      await request(app.getHttpServer())
        .get('/catalog/professionals')
        .expect(200);

      expect(listProfessionals).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 20 }),
      );
    });

    it('pasa los filtros al service ya tipados', async () => {
      const specialtyId = '33333333-3333-4333-8333-333333333333';

      await request(app.getHttpServer())
        .get('/catalog/professionals')
        .query({ page: 2, limit: 5, specialtyId, minPrice: 100, maxPrice: 900 })
        .expect(200);

      expect(listProfessionals).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          limit: 5,
          specialtyId,
          minPrice: 100,
          maxPrice: 900,
        }),
      );
    });

    it.each([
      ['page en 0', { page: 0 }],
      ['limit por encima del techo', { limit: 51 }],
      ['specialtyId que no es UUID', { specialtyId: 'cardiologia' }],
      ['precio negativo', { minPrice: -5 }],
      ['rango invertido', { minPrice: 900, maxPrice: 100 }],
    ])('400 con %s', (_caso, params) => {
      return request(app.getHttpServer())
        .get('/catalog/professionals')
        .query(params)
        .expect(400);
    });

    it('400 ante un query param desconocido (whitelist)', () => {
      return request(app.getHttpServer())
        .get('/catalog/professionals')
        .query({ status: 'PENDIENTE_VALIDACION_MATRICULA' })
        .expect(400);
    });

    it('devuelve la página tal como la arma el service', async () => {
      const page = {
        data: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            firstName: 'Ana',
            lastName: 'Álvarez',
            photoUrl: null,
            primarySpecialty: { id: 'spec-1', name: 'Cardiología' },
            specialties: [{ id: 'spec-1', name: 'Cardiología' }],
            price: 12000.5,
            currency: 'ARS',
          },
        ],
        meta: {
          page: 1,
          limit: 20,
          total: 1,
          totalPages: 1,
          hasNextPage: false,
        },
      };
      listProfessionals.mockResolvedValue(page);

      await request(app.getHttpServer())
        .get('/catalog/professionals')
        .expect(200)
        .expect((res) => {
          expect(res.body).toEqual(page);
        });
    });
  });
});
