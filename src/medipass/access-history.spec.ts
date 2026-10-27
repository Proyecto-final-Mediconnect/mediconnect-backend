import { accessStatus, resourceLabel } from './access-history';

/** ENG-76 — cómo se le cuenta al paciente cada acceso. */
describe('access-history', () => {
  describe('resourceLabel', () => {
    it('nombra lo que escribe el backend y lo que siembra la demo', () => {
      expect(resourceLabel('medipass.vital')).toMatch(/^Información vital/);
      expect(resourceLabel('alergias')).toBe('Alergias');
      expect(resourceLabel('medicacion_activa')).toBe('Medicación activa');
      expect(resourceLabel('diagnosticos')).toBe('Diagnósticos');
    });

    it('un recurso desconocido o vacío no se esconde', () => {
      expect(resourceLabel('estudios')).toBe('Otra información del MediPass');
      expect(resourceLabel(null)).toBe('Información del MediPass');
    });
  });

  describe('accessStatus', () => {
    const NOW = new Date('2026-10-21T15:00:00.000Z');
    const later = new Date(NOW.getTime() + 60_000);
    const before = new Date(NOW.getTime() - 60_000);

    it('activo mientras no venció', () => {
      expect(accessStatus({ expires_at: later, revoked_at: null }, NOW)).toBe(
        'ACTIVO',
      );
    });

    it('vencido al llegar a su hora', () => {
      expect(accessStatus({ expires_at: NOW, revoked_at: null }, NOW)).toBe(
        'VENCIDO',
      );
    });

    it('revocado gana sobre vencido', () => {
      expect(
        accessStatus({ expires_at: before, revoked_at: before }, NOW),
      ).toBe('REVOCADO');
    });
  });
});
