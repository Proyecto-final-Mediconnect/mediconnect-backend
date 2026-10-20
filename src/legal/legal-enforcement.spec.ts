import { ConfigService } from '@nestjs/config';
import { LegalEnforcement } from './legal-enforcement';

function enforcement(value: string | undefined): LegalEnforcement {
  const config = {
    get: jest.fn().mockReturnValue(value),
  } as unknown as ConfigService;
  return new LegalEnforcement(config);
}

describe('LegalEnforcement', () => {
  it('está apagado si la variable no está definida', () => {
    expect(enforcement(undefined).isEnabled()).toBe(false);
  });

  it('está prendido solo con el string "true"', () => {
    expect(enforcement('true').isEnabled()).toBe(true);
  });

  // Prender esto bloquea el acceso a toda la API para quien no aceptó, así que
  // un valor aproximado no alcanza: tiene que ser exactamente "true".
  it.each(['', 'false', '1', 'yes', 'TRUE', 'on'])(
    'está apagado con el valor %p',
    (value) => {
      expect(enforcement(value).isEnabled()).toBe(false);
    },
  );
});
