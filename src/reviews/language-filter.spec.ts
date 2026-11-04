import {
  findInappropriate,
  isInappropriate,
  normalize,
} from './language-filter';

/** Filtro automático de lenguaje inapropiado (ENG-107). */
describe('language-filter', () => {
  it('normaliza mayúsculas, acentos, reemplazos de letras y letras estiradas', () => {
    expect(normalize('PELOTUDÓ')).toBe('pelotudo');
    expect(normalize('b0lud0')).toBe('boludo');
    expect(normalize('f0rr@')).toBe('forra');
    expect(normalize('boluuudooo!!')).toBe('boludo');
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
  ])('detecta "%s"', (texto) => {
    expect(isInappropriate(texto)).toBe(true);
  });

  it.each([
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
});
