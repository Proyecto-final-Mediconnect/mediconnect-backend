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
