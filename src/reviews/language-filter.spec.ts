import {
  findInappropriate,
  containsContactInfo,
  isInappropriate,
  normalize,
} from './language-filter';

/** Filtro automático de lenguaje inapropiado (ENG-107). */
describe('language-filter', () => {
  it('normaliza mayúsculas, acentos, reemplazos de letras y letras estiradas', () => {
    expect(normalize('PELOTUDÓ')).toBe('pelotudo');
    expect(normalize('b0lud0')).toBe('boludo');
    expect(normalize('f0rr@')).toBe('forra');
    expect(normalize('boluuudooo!!')).toBe('boluudoo');
    expect(normalize('p.e.l.o.t.u.d.o')).toBe('pelotudo');
    expect(normalize('h-d-p')).toBe('hdp');
  });

  it.each([
    'Es un pelotudo',
    'PELOTUDO total',
    'Un b0lud0 bárbaro',
    'qué forro',
    'una m1erda de atención',
    'boluuudo',
    'sos un h.d.p',
    'el hijo de puta no vino',
    'andate a la mierda',
    'p.e.l.o.t.u.d.o',
    'qué forrro',
    'sos un p e l o t u d o',
    'pelo\u200Btudo',
    'ｐｅｌｏｔｕｄｏ',
    'pelоtudo',
    'la concha de tu madre',
  ])('detecta "%s"', (texto) => {
    expect(isInappropriate(texto)).toBe(true);
  });

  it.each([
    'Atiende en Concha y Toro, la doctora Concha Ortiz es genial.',
    'Llegó al orto del camino, me dijo que soy un chanta pero fue amable.',
    'Me atendió muy bien, súper claro con las indicaciones.',
    'Llegó tarde y fue maleducado. No lo recomiendo.',
    'El turno se había retrasado 20 minutos.',
    'Lo vi por la computadora y se escuchaba perfecto.',
    'Hubo una disputa con la obra social, pero lo resolvió.',
    'Excelente profesional, 10 de 10.',
    'Me mandó a hacer un análisis de sangre y una ecografía.',
    'Tengo una consulta pendiente por el tema del carro de la clínica.',
    '',
  ])('deja pasar "%s"', (texto) => {
    expect(isInappropriate(texto)).toBe(false);
  });

  it('devuelve lo que encontró, sin repetir', () => {
    expect(findInappropriate('boludo, BOLUDO y forro').sort()).toEqual([
      'boludo',
      'forro',
    ]);
  });

  describe('containsContactInfo', () => {
    it.each([
      'https://x.com',
      'www.clinica.com',
      'clinica.com.ar',
      'a@b.com',
      '11 5555-1234',
      '+54 9 11 5555 1234',
      'w\u200Bww.clinica.com',
    ])('detecta "%s"', (t) => expect(containsContactInfo(t)).toBe(true));

    it.each([
      'Gracias por la devolución.',
      'Lo esperamos el 12.11.2026 a las 10.30. Un saludo, Dr. Pérez.',
      'Tomar 2 comprimidos cada 8 horas.',
    ])('no detecta "%s"', (t) => expect(containsContactInfo(t)).toBe(false));
  });
});
