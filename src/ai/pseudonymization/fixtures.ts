import type { KnownIdentities, RecognizedEntity } from './pseudonymizer';

/**
 * Consultas FICTICIAS para probar la seudonimización. Ninguna persona, documento,
 * teléfono ni dirección es real.
 *
 * Cada caso dice qué tiene que desaparecer (`mustHide`), qué dato clínico no se
 * puede tapar (`mustKeep`) y qué entidades encontraría un modelo ideal
 * (`entities`), que es lo que usa el reconocedor de mentira de los tests. La
 * evaluación con el modelo real (`ai-pipeline/`) usa los mismos casos y mide
 * cuántos `mustHide` se le escapan.
 */
export interface PseudonymizationCase {
  name: string;
  known: KnownIdentities;
  transcript: string;
  mustHide: string[];
  mustKeep: string[];
  entities: RecognizedEntity[];
}

const LUCIA: KnownIdentities = {
  patient: {
    firstName: 'Lucía',
    lastName: 'Fernández',
    dni: '30123456',
    email: 'lucia.fernandez@example.com',
    phone: '+54 9 351 555-0199',
    address: 'Avenida Colón 1234',
  },
  professional: {
    firstName: 'Martín',
    lastName: 'Gómez',
    email: 'martin.gomez@example.com',
    licenseNumber: 'MP 45123',
  },
};

const ROSA: KnownIdentities = {
  patient: {
    firstName: 'Rosa',
    lastName: 'Paz',
    dni: '5.432.109',
    phone: '11 4567-8901',
  },
  professional: { firstName: 'María José', lastName: 'Quiroga' },
};

const RELLENO =
  'Paciente: me duele un poco la espalda cuando me levanto a la mañana, sobre todo después de caminar. ';

export const PSEUDONYMIZATION_CASES: PseudonymizationCase[] = [
  {
    name: 'control con familiares, obra social y fecha de nacimiento (spike ENG-239)',
    known: LUCIA,
    transcript: `Doctor Gómez: Buenas tardes Lucía, ¿cómo anduvo la semana?
Paciente: Bien doctor, aunque me siguen los dolores de cabeza. Le recuerdo que mi DNI es 30.123.456 y mi celular el 351 555-0199, por si me tiene que llamar.
Doctor Gómez: Perfecto. ¿Seguís con el enalapril de 10 mg cada 12 horas?
Paciente: Sí, todos los días. Ah, no soy alérgica a la penicilina, eso lo había dicho mal la vez pasada.
Doctor Gómez: Bien que lo aclares. ¿Antecedentes en la familia?
Paciente: Mi hermana Laura tuvo un ACV a los 50 y mi papá, Roberto, es diabético. Yo vivo en Tandil desde marzo, me mudé de Avenida Colón 1234.
Doctor Gómez: Te mando la receta a lucia.fernandez@example.com. Mi colega, la doctora Sofía Ibarra del Hospital Italiano, te puede ver por la presión.
Paciente: Gracias. Mi obra social es OSDE, afiliado 61 234567 8, y nací el 14/02/1983.
Doctor Gómez: Listo. Ibuprofeno 400 mg solo si duele, y control en 30 días.`,
    mustHide: [
      'Lucía',
      'Gómez',
      '30.123.456',
      '351 555-0199',
      'lucia.fernandez@example.com',
      'Avenida Colón 1234',
      'Laura',
      'Roberto',
      'Tandil',
      'Sofía Ibarra',
      'Hospital Italiano',
      'OSDE',
      '61 234567 8',
      '14/02/1983',
    ],
    mustKeep: [
      'enalapril de 10 mg cada 12 horas',
      'no soy alérgica a la penicilina',
      'ACV a los 50',
      'diabético',
      'Ibuprofeno 400 mg',
      'control en 30 días',
      'dolores de cabeza',
    ],
    entities: [
      { kind: 'PERSONA', text: 'Laura' },
      { kind: 'PERSONA', text: 'Roberto' },
      { kind: 'LUGAR', text: 'Tandil' },
      { kind: 'PERSONA', text: 'Sofía Ibarra' },
      { kind: 'ORGANIZACION', text: 'Hospital Italiano' },
      { kind: 'ORGANIZACION', text: 'OSDE' },
    ],
  },
  {
    name: 'transcripción sin tildes, con el nombre al revés y el teléfono sin característica',
    known: LUCIA,
    transcript: `Dr. Gomez: Hola Lucia, contame.
Paciente: Fernandez Lucia, vengo por el control. Si me necesita, el numero es 555-0199 o el fijo 0351 4223344.
Dr. Gomez: Bien. La presion dio 120/80 y la frecuencia 72. Seguimos con losartan 50 mg.
Paciente: Mi vecina Carmen me dijo que en el Sanatorio Allende hacen el holter mas rapido.
Dr. Gomez: Lo pedimos ahi. Te escribo a LUCIA.FERNANDEZ@EXAMPLE.COM con la orden. Mi matricula es la 45123.`,
    mustHide: [
      'Gomez',
      'Lucia',
      'Fernandez',
      '555-0199',
      '0351 4223344',
      'Carmen',
      'Sanatorio Allende',
      'LUCIA.FERNANDEZ@EXAMPLE.COM',
      '45123',
    ],
    mustKeep: ['120/80', 'frecuencia 72', 'losartan 50 mg', 'holter'],
    entities: [
      { kind: 'PERSONA', text: 'Carmen' },
      { kind: 'ORGANIZACION', text: 'Sanatorio Allende' },
    ],
  },
  {
    name: 'consulta larga con nombres al principio y al final',
    known: LUCIA,
    transcript: `Mi hermana Laura me acompañó hoy. ${RELLENO.repeat(120)}Al final vino mi primo Esteban desde Bariloche para quedarse unos días.`,
    mustHide: ['Laura', 'Esteban', 'Bariloche'],
    mustKeep: ['me duele un poco la espalda'],
    entities: [
      { kind: 'PERSONA', text: 'Laura' },
      { kind: 'PERSONA', text: 'Esteban' },
      { kind: 'LUGAR', text: 'Bariloche' },
    ],
  },
  {
    name: 'CUIL, web, dirección no cargada y fecha de nacimiento dicha en palabras',
    known: ROSA,
    transcript: `Doctora Quiroga: Buen día, Rosa. ¿Trajo los estudios?
Paciente: Sí, doctora. Los subí a www.laboratorio-ejemplo.com.ar con mi CUIL 27-05432109-3. Ahora vivo en calle San Martín 450, en Rosario, con mi hijo Tomás.
Doctora Quiroga: El hemograma está bien: 250.000 plaquetas y hemoglobina 13,5. La glucemia, 98.
Paciente: Nací el 3 de agosto de 1950, por si lo necesita para la orden. Mi DNI es 5.432.109.
Doctora Quiroga: Perfecto. Siga con metformina 850 mg con el almuerzo y la cena. Vuelva el 3 de marzo.`,
    mustHide: [
      'Quiroga',
      'Rosa',
      'www.laboratorio-ejemplo.com.ar',
      '27-05432109-3',
      'calle San Martín 450',
      'Rosario',
      'Tomás',
      '3 de agosto de 1950',
      '5.432.109',
    ],
    mustKeep: [
      '250.000 plaquetas',
      'hemoglobina 13,5',
      'glucemia, 98',
      'metformina 850 mg',
      'Vuelva el 3 de marzo',
    ],
    entities: [
      { kind: 'LUGAR', text: 'Rosario' },
      { kind: 'PERSONA', text: 'Tomás' },
    ],
  },
  {
    name: 'nombres que son palabras comunes y enfermedades con nombre propio',
    known: ROSA,
    transcript: `Doctora María José Quiroga: Señora Paz, ¿cómo está?
Paciente: En paz, doctora, pero preocupada. Mi marido tiene Parkinson y a mi mamá le diagnosticaron Alzheimer. Una rosa de mi jardín me pinchó y se me infectó el dedo.
Doctora María José Quiroga: Veamos el dedo. Tomamos cefalexina 500 mg cada 6 horas por 7 días. Si sigue, me llama al consultorio.
Paciente: Gracias, María José. Mi teléfono sigue siendo el 11 4567-8901.`,
    mustHide: ['Quiroga', 'María José', 'Paz,', '11 4567-8901'],
    mustKeep: [
      'En paz',
      'Parkinson',
      'Alzheimer',
      'Una rosa de mi jardín',
      'cefalexina 500 mg cada 6 horas por 7 días',
    ],
    entities: [],
  },
];
