import { renderAppointmentEmail } from './appointment-emails';

/** ENG-68 — contenido de los emails de turno. */

// Martes 20/10/2026 a las 10:00 de Argentina (13:00 UTC).
const DATA = {
  patientFirstName: 'Juan',
  professionalName: 'Ana Gómez',
  scheduledAt: new Date('2026-10-20T13:00:00.000Z'),
  durationMinutes: 30,
  myAppointmentsUrl: 'https://app.test/mis-turnos',
};

describe('renderAppointmentEmail', () => {
  it('la confirmación dice fecha y hora en Argentina, no en UTC', () => {
    const email = renderAppointmentEmail('TURNO_RESERVADO', DATA);

    expect(email.subject).toBe('Tu turno con Ana Gómez está confirmado');
    expect(email.text).toContain('martes, 20 de octubre a las 10:00');
    expect(email.text).not.toContain('13:00');
    expect(email.html).toContain('href="https://app.test/mis-turnos"');
  });

  it.each([
    ['RECORDATORIO_24H', 'Recordatorio: tu turno con Ana Gómez es mañana'],
    ['RECORDATORIO_1H', 'Tu turno con Ana Gómez empieza en una hora'],
  ] as const)('%s tiene su asunto', (kind, subject) => {
    expect(renderAppointmentEmail(kind, DATA).subject).toBe(subject);
  });

  it('escapa en el HTML los nombres que cargan los usuarios', () => {
    // Un profesional con HTML en el apellido no puede inyectar un link en el
    // mail de cada paciente.
    const email = renderAppointmentEmail('TURNO_RESERVADO', {
      ...DATA,
      patientFirstName: '<b>Juan</b>',
      professionalName: 'Ana <a href="https://phishing.test">Gómez</a>',
    });

    expect(email.html).not.toContain('<a href="https://phishing.test">');
    expect(email.html).not.toContain('<b>Juan</b>');
    expect(email.html).toContain(
      '&lt;a href=&quot;https://phishing.test&quot;&gt;',
    );
  });

  it('sin URL de la web el mail sale igual, sin el link', () => {
    const email = renderAppointmentEmail('RECORDATORIO_24H', {
      ...DATA,
      myAppointmentsUrl: null,
    });

    expect(email.html).not.toContain('<a ');
    expect(email.text).not.toContain('Mis turnos:');
  });
});
