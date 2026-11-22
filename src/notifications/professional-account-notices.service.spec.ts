import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { EmailService } from './email.service';
import { ProfessionalAccountNoticesService } from './professional-account-notices.service';

const PRO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** ENG-192 — el mail al profesional con la decisión sobre su matrícula. */
describe('ProfessionalAccountNoticesService · licenseDecided', () => {
  let email: { isConfigured: jest.Mock; send: jest.Mock };
  let findUnique: jest.Mock;
  let service: ProfessionalAccountNoticesService;

  beforeEach(() => {
    email = {
      isConfigured: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue('msg-1'),
    };
    findUnique = jest.fn().mockResolvedValue({
      first_name: 'Ana',
      profile: { email: 'ana@test.com' },
    });
    const config = {
      get: (key: string) =>
        key === 'WEB_ORIGIN' ? 'https://web.test' : undefined,
    } as unknown as ConfigService;
    service = new ProfessionalAccountNoticesService(
      { professional: { findUnique } } as unknown as PrismaService,
      email as unknown as EmailService,
      config,
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('al validar, le dice que ya aparece en el catálogo, con el link a su panel', async () => {
    await service.licenseDecided(PRO, 'VALIDADO', null);

    const [mensaje] = email.send.mock.calls[0] as [
      { to: string; subject: string; text: string; idempotencyKey: string },
    ];
    expect(mensaje.to).toBe('ana@test.com');
    expect(mensaje.subject).toBe('Tu matrícula fue validada');
    expect(mensaje.text).toContain('Hola, Ana:');
    expect(mensaje.text).toContain('ya aparecés en el catálogo');
    expect(mensaje.text).toContain('https://web.test/profesional');
    expect(mensaje.idempotencyKey).toBe(`license:${PRO}:VALIDADO`);
  });

  it('al rechazar, le dice el motivo', async () => {
    await service.licenseDecided(PRO, 'RECHAZADO', 'No figura en REFEPS.');

    const [mensaje] = email.send.mock.calls[0] as [
      { subject: string; text: string },
    ];
    expect(mensaje.subject).toBe('No pudimos validar tu matrícula');
    expect(mensaje.text).toContain('Motivo: No figura en REFEPS.');
  });

  it('al suspender le dice el motivo y qué pasó con sus turnos (ENG-241)', async () => {
    const now = new Date('2026-11-22T12:00:00.000Z');
    await service.suspended(
      PRO,
      'Denuncia verificada.',
      { refunded: 2, cancelled: 1 },
      now,
    );

    const [mensaje] = email.send.mock.calls[0] as [
      { subject: string; text: string; idempotencyKey: string },
    ];
    expect(mensaje.subject).toBe('Suspendimos tu cuenta de MediConnect');
    expect(mensaje.text).toContain('Motivo: Denuncia verificada.');
    expect(mensaje.text).toContain('Cancelamos tus 3 turnos pendientes');
    expect(mensaje.idempotencyKey).toBe(
      `suspended:${PRO}:${now.toISOString()}`,
    );
  });

  it('al reactivar lo invita a revisar su agenda', async () => {
    await service.reactivated(PRO, new Date('2026-11-22T12:00:00.000Z'));

    const [mensaje] = email.send.mock.calls[0] as [
      { subject: string; text: string },
    ];
    expect(mensaje.subject).toBe('Reactivamos tu cuenta de MediConnect');
    expect(mensaje.text).toContain('https://web.test/profesional/agenda');
  });

  it('sin mail configurado no hace nada', async () => {
    email.isConfigured.mockReturnValue(false);

    await service.licenseDecided(PRO, 'VALIDADO', null);

    expect(findUnique).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('si el envío falla no tira: la decisión ya quedó escrita', async () => {
    email.send.mockRejectedValue(new Error('Resend caído'));

    await expect(
      service.licenseDecided(PRO, 'VALIDADO', null),
    ).resolves.toBeUndefined();
  });
});
