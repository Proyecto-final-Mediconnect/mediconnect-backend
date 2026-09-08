/**
 * Seed de DEMO — datos de exhibición para mostrar la app en vivo.
 *
 * No confundir con `seed.ts`: aquel es el seed base compartido (el catálogo de
 * especialidades) y corre en CI y en el deploy. Este NO corre solo en ningún
 * lado: se ejecuta a mano, antes de una demo, y contra la base de desarrollo.
 *
 *   DEMO_SEED_PASSWORD='...' pnpm run db:seed:demo
 *
 * ---------------------------------------------------------------------------
 * Por qué existe
 * ---------------------------------------------------------------------------
 * La base compartida tiene lo que fue quedando de probar cada ticket: tres
 * profesionales de los cuales uno solo tenía agenda, un paciente con ficha de
 * seis, turnos con fecha fija que hoy ya son pasado, y veinte tablas vacías.
 * Alcanza para desarrollar y no alcanza para mostrar: un catálogo con médicos
 * sin bio y sin horarios disponibles se ve roto aunque el código esté bien.
 *
 * ---------------------------------------------------------------------------
 * Tres decisiones que explican casi todo el archivo
 * ---------------------------------------------------------------------------
 * 1. **Todo es relativo a `now()`.** Ningún turno tiene fecha escrita a mano.
 *    Un seed con fechas fijas sirve el día que se escribe y es basura la semana
 *    siguiente — que es exactamente el estado del que venimos. Se corre diez
 *    minutos antes de la demo y los datos quedan frescos, sea el día que sea.
 *
 * 2. **La agenda cubre los siete días.** El profesional que había solo atendía
 *    lunes a jueves, así que una demo un viernes mostraba "no hay turnos
 *    disponibles" y parecía un bug. Publicar los siete días no es realista para
 *    un médico de verdad, y acá no importa: lo que se demuestra es que el
 *    cálculo de disponibilidad anda, no la vida laboral de nadie.
 *
 * 3. **La historia clínica se sella con el código de producción.** Las entradas
 *    no se insertan a mano: pasan por `appendEntry` de `common/hash-chain`, el
 *    mismo que usa el service. Escribir hashes inventados dejaría la cadena
 *    rota y el job de integridad (ENG-85) reportaría CONTENT_TAMPERED sobre
 *    datos de demo, que es una falsa alarma cara: la próxima vez que salte de
 *    verdad nadie le va a creer.
 *
 * ---------------------------------------------------------------------------
 * Qué se ve en la app y qué no
 * ---------------------------------------------------------------------------
 * Se siembran todas las tablas del modelo, pero conviene saber qué muestra cada
 * cosa, porque no todas tienen endpoint todavía:
 *
 * - **Se ve en la app**: profiles, patients, professionals, specialties,
 *   professional_specialties, schedule_rules, schedule_blocks, appointments.
 * - **Se ve cuando mergeen los PRs de HC** (#44 y #46): clinical_record_entries,
 *   consultations. Hoy el front usa datos mockeados para esa pantalla.
 * - **Todavía no tiene endpoint**: payments, refunds, reviews, review_responses,
 *   conversations, messages, notifications, medipass_*, audit_logs,
 *   consultation_summaries. Se llenan igual para que el modelo de datos se vea
 *   completo y coherente si se abre Supabase durante la defensa, pero NINGUNA
 *   de estas filas aparece hoy en la pantalla: lo que se muestra ahí es front
 *   sobre datos hardcodeados.
 *
 * Es idempotente: se puede correr las veces que haga falta.
 *
 * ---------------------------------------------------------------------------
 * Contraseña de las cuentas de demo
 * ---------------------------------------------------------------------------
 * Sale de `DEMO_SEED_PASSWORD` y NO tiene default. Sprint 0 §3.4.11 dice que
 * las contraseñas van por el password manager compartido, así que ni siquiera
 * una de juguete se versiona acá: si se escribiera en este archivo quedaría en
 * el repo para siempre.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '../generated/prisma/client';
import {
  appendEntry,
  GENESIS_HASH,
} from '../src/common/hash-chain/hash-chain';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Guardarraíles
// ---------------------------------------------------------------------------

/**
 * Dominio de las cuentas que este script se permite crear y, sobre todo,
 * cuya contraseña se permite resetear.
 *
 * El límite importa: la base es compartida con el resto del equipo y hay
 * cuentas de Gmail que son de personas reales. Pisarle la contraseña a una
 * sería dejar a alguien afuera de su propia cuenta el día antes de la entrega.
 * `.test` es un TLD reservado (RFC 2606) que no puede existir de verdad, así
 * que nada que termine ahí es de nadie.
 */
const DEMO_DOMAIN = '@mediconnect.test';

const esCuentaDeDemo = (email: string) => email.endsWith(DEMO_DOMAIN);

// ---------------------------------------------------------------------------
// Definición de los datos
// ---------------------------------------------------------------------------

/** Franjas que se publican todos los días. Mañana y tarde, con el corte del
 *  mediodía: una franja continua de 08 a 22 no se parece a ninguna agenda real
 *  y en pantalla se ve como una lista interminable de horarios iguales. */
const FRANJAS = [
  { startTime: '08:00', endTime: '13:00' },
  { startTime: '14:00', endTime: '20:00' },
] as const;

const DURACION_TURNO = 30;

interface ProfesionalDemo {
  email: string;
  firstName: string;
  lastName: string;
  licenseNumber: string;
  price: number;
  bio: string;
  specialties: string[];
  education: { institution: string; degree: string; year: number }[];
}

/**
 * Los seis del catálogo.
 *
 * Los precios están repartidos entre 9.500 y 42.000 a propósito: el filtro por
 * rango de precio no se puede mostrar si todos salen parecido. Las
 * especialidades tampoco son una por cabeza: hay dos clínicos y dos que
 * comparten pediatría, porque un filtro que siempre devuelve un solo resultado
 * no demuestra que filtre.
 */
const PROFESIONALES: ProfesionalDemo[] = [
  {
    email: `pro.demo${DEMO_DOMAIN}`,
    firstName: 'Ana',
    lastName: 'García',
    licenseNumber: 'MP-12345',
    price: 18000,
    bio: 'Clínica médica con orientación en enfermedades crónicas. Atiendo controles, seguimiento de hipertensión y diabetes, y consultas de segunda opinión. Doce años de ejercicio, los últimos cuatro con consultorio virtual.',
    specialties: ['Clínica Médica', 'Endocrinología'],
    education: [
      { institution: 'Universidad Nacional de Córdoba', degree: 'Medicina', year: 2012 },
      { institution: 'Hospital Nacional de Clínicas', degree: 'Residencia en Clínica Médica', year: 2016 },
    ],
  },
  {
    email: `pro.eng48${DEMO_DOMAIN}`,
    firstName: 'Lucía',
    lastName: 'Fernández',
    licenseNumber: 'MP-28401',
    price: 9500,
    bio: 'Pediatra. Controles de crecimiento, vacunación y consultas de urgencia leve. Trabajo con familias que viven lejos de un centro de salud, que es donde la consulta remota realmente cambia algo.',
    specialties: ['Pediatría'],
    education: [
      { institution: 'Universidad Nacional de Córdoba', degree: 'Medicina', year: 2015 },
      { institution: 'Hospital de Niños de Córdoba', degree: 'Residencia en Pediatría', year: 2019 },
    ],
  },
  {
    email: `pro.cardio${DEMO_DOMAIN}`,
    firstName: 'Martín',
    lastName: 'Olivares',
    licenseNumber: 'MP-33871',
    price: 42000,
    bio: 'Cardiólogo. Interpretación de estudios, ajuste de medicación antihipertensiva y seguimiento post-evento. Pido siempre los estudios previos antes de la consulta para no gastar la videollamada leyendo papeles.',
    specialties: ['Cardiología', 'Clínica Médica'],
    education: [
      { institution: 'Universidad de Buenos Aires', degree: 'Medicina', year: 2008 },
      { institution: 'Instituto Cardiovascular de Buenos Aires', degree: 'Especialista en Cardiología', year: 2013 },
    ],
  },
  {
    email: `pro.derma${DEMO_DOMAIN}`,
    firstName: 'Carolina',
    lastName: 'Ruiz',
    licenseNumber: 'MP-20114',
    price: 24000,
    bio: 'Dermatología general y estética. La consulta virtual funciona muy bien para lesiones visibles: pido fotos con buena luz antes del turno y llegamos con medio diagnóstico hecho.',
    specialties: ['Dermatología'],
    education: [
      { institution: 'Universidad Nacional de Rosario', degree: 'Medicina', year: 2011 },
    ],
  },
  {
    email: `pro.psico${DEMO_DOMAIN}`,
    firstName: 'Diego',
    lastName: 'Ferreyra',
    licenseNumber: 'MP-45902',
    price: 16000,
    bio: 'Psicólogo clínico, orientación cognitivo-conductual. Trabajo ansiedad, estrés laboral y acompañamiento en procesos de duelo. Sesiones de 50 minutos, siempre en el mismo horario semanal.',
    specialties: ['Psicología'],
    education: [
      { institution: 'Universidad Nacional de Córdoba', degree: 'Licenciatura en Psicología', year: 2014 },
    ],
  },
  {
    // Cuenta de prueba que ya venía en la base y aparecía en el catálogo como
    // "Profesional aa", sin foto y con agenda de lunes a jueves. No se borra
    // —es un Gmail que alguien del equipo usa para entrar— pero sí se completa,
    // porque un catálogo con un profesional a medio cargar se ve roto. Al no
    // terminar en .test, su contraseña queda intacta (ver DEMO_DOMAIN).
    email: 'pruebaprofesional@gmail.com',
    firstName: 'Valentina',
    lastName: 'Roldán',
    licenseNumber: 'MP-26232',
    price: 35000,
    bio: 'Traumatóloga. Consultas por dolor articular, lesiones deportivas y seguimiento post-quirúrgico. En la consulta virtual reviso estudios y defino si hace falta ver al paciente en persona, que muchas veces no.',
    specialties: ['Traumatología', 'Kinesiología'],
    education: [
      { institution: 'Universidad Nacional de Córdoba', degree: 'Medicina', year: 2010 },
      { institution: 'Sanatorio Allende', degree: 'Residencia en Traumatología', year: 2015 },
    ],
  },
  {
    email: `pro.nutri${DEMO_DOMAIN}`,
    firstName: 'Sofía',
    lastName: 'Medina',
    licenseNumber: 'MP-51203',
    price: 13500,
    bio: 'Licenciada en nutrición. Planes alimentarios para patologías metabólicas y celiaquía. No trabajo con dietas de descarga ni con balanzas semanales.',
    specialties: ['Nutrición', 'Pediatría'],
    education: [
      { institution: 'Universidad ISALUD', degree: 'Licenciatura en Nutrición', year: 2017 },
    ],
  },
];

interface PacienteDemo {
  email: string;
  firstName: string;
  lastName: string;
  dni: string;
  birthDate: string;
  phone: string;
  address: string;
}

const PACIENTES: PacienteDemo[] = [
  {
    email: `paciente.demo${DEMO_DOMAIN}`,
    firstName: 'Julián',
    lastName: 'Sosa',
    dni: '38104772',
    birthDate: '1994-03-18',
    phone: '+54 351 234-5678',
    address: 'Av. Colón 1250, Córdoba',
  },
  {
    email: `paciente.dos${DEMO_DOMAIN}`,
    firstName: 'Marina',
    lastName: 'Quiroga',
    dni: '41552390',
    birthDate: '1999-11-02',
    phone: '+54 351 876-5432',
    address: 'Bv. San Juan 480, Córdoba',
  },
  {
    // La cuenta de la tesis. Se le completa la ficha para que sirva para entrar
    // en la demo sin toparse con "completá tu perfil"; la contraseña no se toca.
    email: 'mediconnecttesis@gmail.com',
    firstName: 'Camila',
    lastName: 'Aguirre',
    dni: '39887201',
    birthDate: '1996-09-12',
    phone: '+54 351 302-7744',
    address: 'Obispo Trejo 340, Córdoba',
  },
  {
    email: `paciente.tres${DEMO_DOMAIN}`,
    firstName: 'Ernesto',
    lastName: 'Bianchi',
    dni: '12873455',
    birthDate: '1958-06-24',
    phone: '+54 351 445-1190',
    address: 'Rivera Indarte 720, Córdoba',
  },
];

/** El moderador no se crea: el trigger `handle_new_user` solo sabe hacer
 *  PACIENTE y PROFESIONAL, y otro trigger prohíbe cambiar el rol después. Si la
 *  cuenta ya existe se usa; si no, las reseñas quedan sin moderar, que es un
 *  estado legítimo del modelo. */
const EMAIL_MODERADOR = `mod.demo${DEMO_DOMAIN}`;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/**
 * Id estable derivado de una clave de texto.
 *
 * Existe por una razón concreta: `clinical_record_entries` es append-only y la
 * base lo hace cumplir con un trigger (Ley 26.529 art. 15 — un DELETE ahí
 * responde 42501). O sea que la HC sembrada NO se puede borrar y volver a
 * escribir en la corrida siguiente, y las entradas apuntan a `consultations`,
 * que a su vez cuelgan de `appointments`.
 *
 * Con ids al azar, la segunda corrida tendría que borrar esas consultas para
 * recrearlas y la FK de la HC lo impediría. Con ids derivados de una clave
 * ("turno:envivo") la fila es siempre la misma y se hace UPSERT: los datos se
 * refrescan, los ids no se mueven y lo que ya está escrito en la cadena sigue
 * apuntando a algo que existe.
 *
 * No es un UUID v5 formal —no hay namespace ni el versionado del RFC— y no hace
 * falta: lo único que se le pide es ser estable, único dentro del seed y tener
 * forma de UUID.
 */
function idDemo(clave: string): string {
  const h = createHash('sha256').update(`mediconnect-demo:${clave}`).digest('hex');

  // Tiene que ser un UUID **v4** válido, no solo algo con forma de UUID: los
  // controllers validan los path params con `ParseUUIDPipe` en versión 4, así
  // que un id con el nibble de versión equivocado hace que
  // `POST /appointments/:id/video` responda 400 antes de mirar la base.
  // Se forzan los dos campos que define el RFC 4122: versión (4) y variante
  // (10xx → uno de 8/9/a/b). El resto de los bits sale del hash, así que el id
  // sigue siendo determinístico.
  const version = `4${h.slice(13, 16)}`;
  const variante = `${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}`;

  return [h.slice(0, 8), h.slice(8, 12), version, variante, h.slice(20, 32)].join('-');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}.`);
  return value;
}

/** `HH:MM` → `Date` en el epoch, que es como Prisma mapea una columna `time`.
 *  La fecha es irrelevante y se descarta; solo viaja la hora. */
const horaSql = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

const enMinutos = (desde: Date, minutos: number) =>
  new Date(desde.getTime() + minutos * 60_000);

const enDias = (desde: Date, dias: number) => enMinutos(desde, dias * 24 * 60);

/** Redondea hacia arriba a la próxima media hora, para que los turnos sembrados
 *  caigan sobre un borde de slot y el cálculo de disponibilidad los descuente
 *  como corresponde en vez de mostrar el horario como libre. */
function proximaMediaHora(desde: Date): Date {
  const d = new Date(desde);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30);
  return d;
}

/** `Date` → `YYYY-MM-DD` en hora argentina, que es el huso en el que razona
 *  toda la agenda (`common/time/argentina-time.ts`). */
const fechaAr = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);

const horaAr = (d: Date) =>
  d.toLocaleTimeString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    minute: '2-digit',
  });

// ---------------------------------------------------------------------------
// Cuentas (Supabase Auth)
// ---------------------------------------------------------------------------

let _admin: ReturnType<typeof createClient> | null = null;

function admin() {
  _admin ??= createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return _admin;
}

/** Índice email → id, armado de una sola pasada.
 *
 *  La Admin API no expone búsqueda por email, así que la alternativa sería
 *  paginar la lista entera una vez por cuenta. Con nueve cuentas son nueve
 *  barridos de la misma tabla. */
async function indiceDeCuentas(): Promise<Map<string, string>> {
  const indice = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin().auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw new Error(`No se pudo listar cuentas: ${error.message}`);
    for (const u of data.users) if (u.email) indice.set(u.email, u.id);
    if (data.users.length < 200) break;
  }
  return indice;
}

/**
 * Devuelve el id de la cuenta, creándola si no existe.
 *
 * `email_confirm: true` porque en una demo nadie va a ir a buscar un mail de
 * verificación, y sin confirmar el login rebota.
 *
 * El `user_metadata` no es decorativo: el trigger `handle_new_user` lee de ahí
 * el rol y, si es PROFESIONAL, crea también la fila de `professionals` con
 * nombre, apellido y matrícula.
 */
async function cuenta(
  indice: Map<string, string>,
  email: string,
  password: string,
  metadata: Record<string, string>,
): Promise<string> {
  const existente = indice.get(email);

  if (existente) {
    // Solo se repone la contraseña de las cuentas de juguete. Ver DEMO_DOMAIN:
    // pisarle la clave a un Gmail del equipo sería dejar a alguien afuera.
    if (esCuentaDeDemo(email)) {
      const { error } = await admin().auth.admin.updateUserById(existente, {
        password,
        user_metadata: metadata,
      });
      if (error) throw new Error(`No se pudo actualizar ${email}: ${error.message}`);
    }
    return existente;
  }

  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: metadata,
  });
  if (error) throw new Error(`No se pudo crear ${email}: ${error.message}`);
  indice.set(email, data.user.id);
  return data.user.id;
}

// ---------------------------------------------------------------------------
// Limpieza
// ---------------------------------------------------------------------------

/**
 * Borra lo que SÍ se puede borrar de corridas anteriores.
 *
 * El alcance es siempre "las cuentas de demo": los turnos, reseñas y mensajes
 * del resto del equipo quedan donde están. La base es compartida y esto se
 * corre sin avisar.
 *
 * Lo que NO se borra, y por qué:
 *
 * - `clinical_record_entries` es append-only y la base lo hace cumplir. Un
 *   DELETE ahí devuelve 42501. La HC se siembra una sola vez y las corridas
 *   siguientes la dejan como está (ver `sembrarCadena`).
 * - `appointments`, `consultations`, `payments`, `reviews` y compañía tampoco:
 *   tienen id determinístico y se hace UPSERT. Borrarlas rompería las FKs de la
 *   HC, que es justamente lo que no se puede reescribir.
 *
 * Queda para borrar lo que no tiene dependientes protegidos: agenda, mensajes,
 * notificaciones, MediPass y auditoría.
 */
async function limpiar(
  pacientes: string[],
  profesionales: string[],
  idsEsperados: string[],
): Promise<Map<string, string>> {
  const sesiones = await prisma.mediPassSession.findMany({
    where: { patient_id: { in: pacientes } },
    select: { id: true },
  });

  await prisma.mediPassAccessLog.deleteMany({
    where: { session_id: { in: sesiones.map((x) => x.id) } },
  });
  await prisma.mediPassSession.deleteMany({ where: { patient_id: { in: pacientes } } });
  await prisma.mediPassCode.deleteMany({ where: { patient_id: { in: pacientes } } });

  const conversaciones = await prisma.conversation.findMany({
    where: { patient_id: { in: pacientes } },
    select: { id: true },
  });
  await prisma.message.deleteMany({
    where: { conversation_id: { in: conversaciones.map((c) => c.id) } },
  });

  await prisma.notification.deleteMany({
    where: { user_id: { in: [...pacientes, ...profesionales] } },
  });
  await prisma.auditLog.deleteMany({
    where: { actor_id: { in: [...pacientes, ...profesionales] } },
  });

  await prisma.scheduleBlock.deleteMany({ where: { professional_id: { in: profesionales } } });
  await prisma.scheduleRule.deleteMany({ where: { professional_id: { in: profesionales } } });
  await prisma.professionalSpecialty.deleteMany({
    where: { professional_id: { in: profesionales } },
  });
  await prisma.professionalEducation.deleteMany({
    where: { professional_id: { in: profesionales } },
  });

  // --- Turnos de corridas viejas ------------------------------------------
  //
  // Antes de que los ids fueran determinísticos, cada corrida creaba turnos
  // nuevos con id al azar. Esos sobrantes chocan contra el UNIQUE
  // (professional_id, scheduled_at) de la corrida siguiente, así que hay que
  // sacarlos del medio.
  //
  // Pero no todos se pueden borrar: los que tienen una consulta con entradas de
  // historia clínica están clavados por la FK, y la HC no se puede borrar. A
  // esos se los ADOPTA — se los reutiliza en lugar de crear uno nuevo — y se
  // devuelven indexados por "paciente|profesional", que es lo que los
  // identifica dentro del seed.
  const viejos = await prisma.appointment.findMany({
    where: {
      id: { notIn: idsEsperados },
      OR: [
        { patient_id: { in: pacientes } },
        { professional_id: { in: profesionales } },
      ],
    },
    select: {
      id: true,
      patient_id: true,
      professional_id: true,
      consultation: { select: { id: true, clinical_record_entries: { select: { id: true }, take: 1 } } },
    },
  });

  const adoptados = new Map<string, string>();
  const borrables: string[] = [];
  const consultasBorrables: string[] = [];

  for (const t of viejos) {
    if ((t.consultation?.clinical_record_entries.length ?? 0) > 0) {
      adoptados.set(`${t.patient_id}|${t.professional_id}`, t.id);
      continue;
    }
    borrables.push(t.id);
    if (t.consultation) consultasBorrables.push(t.consultation.id);
  }

  const pagos = await prisma.payment.findMany({
    where: { appointment_id: { in: borrables } },
    select: { id: true },
  });
  const pagoIds = pagos.map((x) => x.id);

  await prisma.reviewResponse.deleteMany({
    where: { review: { appointment_id: { in: borrables } } },
  });
  await prisma.review.deleteMany({ where: { appointment_id: { in: borrables } } });
  await prisma.refund.deleteMany({ where: { payment_id: { in: pagoIds } } });
  await prisma.paymentWebhookEvent.deleteMany({ where: { payment_id: { in: pagoIds } } });
  await prisma.payment.deleteMany({ where: { appointment_id: { in: borrables } } });
  await prisma.consultationSummary.deleteMany({
    where: { consultation_id: { in: consultasBorrables } },
  });
  await prisma.videoSession.deleteMany({
    where: { consultation_id: { in: consultasBorrables } },
  });
  await prisma.consultation.deleteMany({ where: { id: { in: consultasBorrables } } });
  await prisma.appointment.deleteMany({ where: { id: { in: borrables } } });

  return adoptados;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const password = requireEnv('DEMO_SEED_PASSWORD');
  const ahora = new Date();

  if ((await prisma.specialty.count()) === 0) {
    throw new Error(
      'El catálogo de especialidades está vacío. Corré `pnpm run db:seed` primero.',
    );
  }

  console.log('→ Cuentas…');
  const indice = await indiceDeCuentas();

  const idsProfesionales: string[] = [];
  for (const p of PROFESIONALES) {
    idsProfesionales.push(
      await cuenta(indice, p.email, password, {
        role: 'PROFESIONAL',
        first_name: p.firstName,
        last_name: p.lastName,
        license_number: p.licenseNumber,
      }),
    );
  }

  const idsPacientes: string[] = [];
  for (const p of PACIENTES) {
    idsPacientes.push(
      await cuenta(indice, p.email, password, {
        role: 'PACIENTE',
        first_name: p.firstName,
        last_name: p.lastName,
      }),
    );
  }

  const idModerador = indice.get(EMAIL_MODERADOR) ?? null;

  console.log('→ Limpiando corridas anteriores…');
  // Las claves de los turnos, en un solo lugar: la limpieza necesita saber
  // cuáles son "los de esta corrida" para distinguirlos de los sobrantes.
  const CLAVES_TURNO = [
    'envivo', 'impago', 'futuro', 'pasado1', 'pasado2', 'pasado3',
    'otro1', 'otro2', 'otro3', 'otro4', 'cancelado',
  ] as const;
  const adoptados = await limpiar(
    idsPacientes,
    idsProfesionales,
    CLAVES_TURNO.map((k) => idDemo(`turno:${k}`)),
  );

  // --- Profesionales -------------------------------------------------------
  console.log('→ Profesionales, especialidades, títulos y agenda…');

  for (const [i, p] of PROFESIONALES.entries()) {
    const id = idsProfesionales[i];

    // El trigger ya creó la fila con nombre y matrícula; falta todo lo que hace
    // que el perfil se vea completo en el catálogo.
    await prisma.professional.update({
      where: { profile_id: id },
      data: {
        first_name: p.firstName,
        last_name: p.lastName,
        license_number: p.licenseNumber,
        bio: p.bio,
        consultation_price: p.price,
        currency: 'ARS',
        // Sin VALIDADO no aparece en el catálogo: `GET /catalog/professionals`
        // filtra por status. En producción esto lo decide un moderador.
        status: 'VALIDADO',
      },
    });

    for (const nombre of p.specialties) {
      const esp = await prisma.specialty.findUnique({ where: { name: nombre } });
      if (!esp) throw new Error(`No existe la especialidad "${nombre}".`);
      await prisma.professionalSpecialty.create({
        data: { professional_id: id, specialty_id: esp.id },
      });
    }

    await prisma.professionalEducation.createMany({
      data: p.education.map((e) => ({
        id: randomUUID(),
        professional_id: id,
        institution: e.institution,
        degree: e.degree,
        year: e.year,
      })),
    });

    // Política de cancelación: los valores son los de ENG-67, que todavía está
    // sin refinar. Se siembran para que la tabla no quede vacía, pero el número
    // real lo decide ese ticket — no hay que citarlo como si estuviera cerrado.
    await prisma.cancellationPolicy.upsert({
      where: { professional_id: id },
      update: { hours_full_refund: 24, hours_partial_refund: 6, partial_refund_percent: 50 },
      create: {
        professional_id: id,
        hours_full_refund: 24,
        hours_partial_refund: 6,
        partial_refund_percent: 50,
      },
    });

    // Agenda: los siete días, mañana y tarde.
    await prisma.scheduleRule.createMany({
      data: Array.from({ length: 7 }, (_, weekday) =>
        FRANJAS.map((f) => ({
          id: randomUUID(),
          professional_id: id,
          weekday,
          start_time: horaSql(f.startTime),
          end_time: horaSql(f.endTime),
          slot_duration_minutes: DURACION_TURNO,
        })),
      ).flat(),
    });
  }

  // Un bloqueo de agenda, para que la pantalla de "Mi agenda" tenga algo que
  // mostrar además de la grilla: el cardiólogo no atiende la tarde de dentro de
  // tres días. Uno solo alcanza para explicar la funcionalidad.
  await prisma.scheduleBlock.create({
    data: {
      id: randomUUID(),
      professional_id: idsProfesionales[2],
      block_date: new Date(`${fechaAr(enDias(ahora, 3))}T00:00:00.000Z`),
      start_time: horaSql('14:00'),
      end_time: horaSql('20:00'),
      reason: 'Ateneo del servicio',
    },
  });

  // --- Pacientes -----------------------------------------------------------
  console.log('→ Pacientes…');

  for (const [i, p] of PACIENTES.entries()) {
    const id = idsPacientes[i];
    const ficha = {
      first_name: p.firstName,
      last_name: p.lastName,
      birth_date: new Date(p.birthDate),
      dni: p.dni,
      phone: p.phone,
      address: p.address,
    };
    // El trigger NO crea la fila de `patients` (a diferencia de profesionales):
    // la ficha la completa el paciente desde la app. Sin ella, reservar responde
    // 409 y el panel muestra "completá tu perfil" — correcto, pero no es lo que
    // se quiere mostrar en una demo.
    await prisma.patient.upsert({
      where: { profile_id: id },
      update: ficha,
      create: { profile_id: id, ...ficha },
    });
  }

  // --- Turnos --------------------------------------------------------------
  console.log('→ Turnos…');

  const [julian, marina, ernesto] = idsPacientes;
  const [ana, lucia, martin, carolina, diego] = idsProfesionales;

  const enCurso = enMinutos(ahora, 4);
  const masTarde = proximaMediaHora(enMinutos(ahora, 180));
  const enTresDias = proximaMediaHora(enDias(ahora, 3));
  const enCincoDias = proximaMediaHora(enDias(ahora, 5));
  const haceUnaSemana = proximaMediaHora(enDias(ahora, -7));
  const haceDiezDias = proximaMediaHora(enDias(ahora, -10));
  const anteayer = proximaMediaHora(enDias(ahora, -2));

  /** Id del turno completado de ese par paciente–profesional.
   *
   *  Si una corrida vieja dejó uno con historia clínica colgando, se reutiliza
   *  ese: la HC es append-only y sus entradas apuntan a su consulta, así que
   *  crear uno nuevo dejaría la historia huérfana de un turno visible. */
  const turnoPasado = (paciente: string, profesional: string, clave: string) =>
    adoptados.get(`${paciente}|${profesional}`) ?? idDemo(`turno:${clave}`);

  const T = {
    // El de la videoconsulta. Empieza en cuatro minutos, o sea que ya está
    // dentro de la ventana de ingreso (se abre 10 minutos antes) y el botón
    // "Entrar a la sala" está vivo desde que se abre la pantalla. Es el único
    // turno cuyo horario no cae sobre un borde de slot, a propósito: redondear
    // significaría esperar hasta media hora frente al proyector.
    envivo: { id: idDemo('turno:envivo'), patient_id: julian, professional_id: ana, scheduled_at: enCurso, status: 'CONFIRMADO' as const, price: 18000 },
    // Sin pagar: es el que se usa para mostrar el checkout.
    impago: { id: idDemo('turno:impago'), patient_id: julian, professional_id: martin, scheduled_at: masTarde, status: 'RESERVADO_SIN_PAGAR' as const, price: 42000 },
    futuro: { id: idDemo('turno:futuro'), patient_id: julian, professional_id: diego, scheduled_at: enCincoDias, status: 'CONFIRMADO' as const, price: 16000 },
    // Historial: sin turnos pasados, "Mis turnos" no tiene qué mostrar en
    // anteriores y la agenda del profesional arranca vacía.
    pasado1: { id: turnoPasado(julian, ana, 'pasado1'), patient_id: julian, professional_id: ana, scheduled_at: haceUnaSemana, status: 'COMPLETADO' as const, price: 18000 },
    pasado2: { id: turnoPasado(julian, martin, 'pasado2'), patient_id: julian, professional_id: martin, scheduled_at: haceDiezDias, status: 'COMPLETADO' as const, price: 42000 },
    pasado3: { id: turnoPasado(marina, ana, 'pasado3'), patient_id: marina, professional_id: ana, scheduled_at: anteayer, status: 'COMPLETADO' as const, price: 18000 },
    // Un segundo y un tercer paciente el mismo día, para que la agenda del
    // profesional no se vea como una lista de un solo elemento.
    otro1: { id: idDemo('turno:otro1'), patient_id: marina, professional_id: ana, scheduled_at: enMinutos(masTarde, 60), status: 'CONFIRMADO' as const, price: 18000 },
    otro2: { id: idDemo('turno:otro2'), patient_id: ernesto, professional_id: ana, scheduled_at: enMinutos(masTarde, 120), status: 'CONFIRMADO' as const, price: 18000 },
    otro3: { id: idDemo('turno:otro3'), patient_id: marina, professional_id: lucia, scheduled_at: enTresDias, status: 'CONFIRMADO' as const, price: 9500 },
    otro4: { id: idDemo('turno:otro4'), patient_id: ernesto, professional_id: carolina, scheduled_at: enMinutos(enCincoDias, 90), status: 'CONFIRMADO' as const, price: 24000 },
    // Uno cancelado: el estado existe en el modelo y en la UI, y una lista donde
    // todo salió bien no muestra qué pasa cuando no.
    cancelado: { id: idDemo('turno:cancelado'), patient_id: ernesto, professional_id: diego, scheduled_at: enDias(ahora, -4), status: 'CANCELADO' as const, price: 16000, cancellation_reason: 'El paciente reprogramó por un viaje.', cancelled_at: enDias(ahora, -6) },
  };

  const turnos = Object.values(T);
  // Upsert y no createMany: los ids son estables, así que la segunda corrida
  // actualiza las mismas filas en vez de intentar borrarlas — que es lo que la
  // FK de la historia clínica no permitiría.
  for (const t of turnos) {
    const fila = { ...t, duration_minutes: DURACION_TURNO };
    await prisma.appointment.upsert({
      where: { id: t.id },
      update: fila,
      create: fila,
    });
  }

  // --- Consultas y video ---------------------------------------------------
  console.log('→ Consultas, sesiones de video y resúmenes…');

  const completados = [T.pasado1, T.pasado2, T.pasado3];
  const consultaDe = new Map<string, string>();

  for (const t of completados) {
    // Se busca por `appointment_id`, que es la clave natural (UNIQUE), y NO por
    // el id: corridas viejas de este mismo script dejaron consultas con id al
    // azar, y la historia clínica —que no se puede borrar— apunta a ellas. Lo
    // que manda es la fila que ya existe; su id se lee de vuelta.
    const consulta = await prisma.consultation.upsert({
      where: { appointment_id: t.id },
      update: {
        started_at: t.scheduled_at,
        ended_at: enMinutos(t.scheduled_at, 27),
      },
      create: {
        id: idDemo(`consulta:${t.id}`),
        appointment_id: t.id,
        started_at: t.scheduled_at,
        ended_at: enMinutos(t.scheduled_at, 27),
        professional_notes: 'Consulta sin incidencias. Paciente colaborador, buena conexión.',
      },
    });
    const idConsulta = consulta.id;
    consultaDe.set(t.id, idConsulta);

    await prisma.videoSession.upsert({
      where: { consultation_id: idConsulta },
      update: {},
      create: {
        id: idDemo(`video:${t.id}`),
        consultation_id: idConsulta,
        // Nombre con el prefijo real (`consultation.config.ts`), pero la sala ya
        // no existe en Daily: expiró con el turno, que es justamente lo que
        // `eject_at_room_exp` garantiza.
        daily_room_name: `consulta-${t.id.slice(0, 8)}`,
        daily_room_url: `https://mediconnecttesis.daily.co/consulta-${t.id.slice(0, 8)}`,
        status: 'FINALIZADA',
        started_at: t.scheduled_at,
        ended_at: enMinutos(t.scheduled_at, 27),
      },
    });
  }

  // Un resumen de IA pendiente de validar y otro ya validado: son los dos
  // estados que la pantalla de cierre de la videoconsulta sabe mostrar.
  // `transcription_text` va corto a propósito — una transcripción real de 27
  // minutos son miles de líneas y no aporta nada tenerlas acá.
  await prisma.consultationSummary.upsert({
    where: { consultation_id: consultaDe.get(T.pasado1.id)! },
    update: {},
    create: {
      id: idDemo('resumen:pasado1'),
      consultation_id: consultaDe.get(T.pasado1.id)!,
      transcription_text:
        '[00:00] Profesional: Buenos días Julián, ¿cómo viene la presión?\n' +
        '[00:14] Paciente: Bien, la vengo tomando a la mañana. Ayer me dio catorce ocho.\n' +
        '[00:31] Profesional: Bien. ¿Seguís con el enalapril de diez?\n' +
        '[00:38] Paciente: Sí, uno por día.',
      summary_content: {
        motivo: 'Control de hipertensión arterial.',
        evolucion: 'Registros domiciliarios en torno a 140/80. Buena adherencia al tratamiento.',
        plan: 'Continuar enalapril 10 mg/día. Control en 30 días con registro de presión.',
      },
      status: 'VALIDADO',
      validated_by: ana,
      generated_at: enMinutos(T.pasado1.scheduled_at, 30),
      validated_at: enMinutos(T.pasado1.scheduled_at, 45),
    },
  });

  await prisma.consultationSummary.upsert({
    where: { consultation_id: consultaDe.get(T.pasado3.id)! },
    update: {},
    create: {
      id: idDemo('resumen:pasado3'),
      consultation_id: consultaDe.get(T.pasado3.id)!,
      transcription_text:
        '[00:00] Profesional: Hola Marina. Contame qué te trae.\n' +
        '[00:09] Paciente: Vengo con dolor de garganta hace tres días y algo de fiebre.',
      summary_content: {
        motivo: 'Odinofagia y registros febriles de tres días de evolución.',
        evolucion: 'Sin dificultad respiratoria. Buen estado general.',
        plan: 'Tratamiento sintomático. Consultar si persiste la fiebre más de 48 horas.',
      },
      status: 'PENDIENTE_VALIDACION',
      generated_at: enMinutos(T.pasado3.scheduled_at, 30),
    },
  });

  // --- Historia clínica ----------------------------------------------------
  console.log('→ Historia clínica (cadena de hash sellada con el código real)…');

  /**
   * Siembra la cadena de un paciente.
   *
   * Cada entrada se sella con `appendEntry`, el mismo que usa el service: el
   * hash sale del contenido más el hash anterior, la secuencia arranca en 1 y es
   * contigua. Así la cadena verifica igual que si la hubiera escrito la app, y
   * el job de integridad no la marca.
   *
   * `created_at` se genera acá y NO en la base: entra a la preimagen del hash y
   * tiene que ser exactamente el mismo valor que se guarda (ver la nota de
   * precisión en el modelo).
   */
  async function sembrarCadena(
    patientId: string,
    entradas: {
      professionalId: string;
      entryType: 'CONSULTA' | 'DIAGNOSTICO' | 'PRESCRIPCION' | 'ESTUDIO' | 'CORRECCION';
      fhirResourceType: string;
      content: unknown;
      consultationId?: string | null;
      createdAt: Date;
      /** Índice (base 1) de la entrada que esta corrige. */
      corrige?: number;
    }[],
  ) {
    // Si el paciente ya tiene cadena, se deja como está. `clinical_record_entries`
    // es append-only y la base lo hace cumplir (Ley 26.529 art. 15): un DELETE
    // devuelve 42501. Reescribirla no es una opción, y agregarle las mismas
    // entradas otra vez duplicaría la historia en cada corrida. Se devuelve la
    // cabeza real para que la foto de integridad quede alineada.
    const yaEscritas = await prisma.clinicalRecordEntry.findMany({
      where: { patient_id: patientId },
      orderBy: { sequence_number: 'asc' },
      select: { id: true, content_hash: true },
    });

    if (yaEscritas.length > 0) {
      return {
        ids: yaEscritas.map((e) => e.id),
        cabeza: yaEscritas[yaEscritas.length - 1].content_hash,
        largo: yaEscritas.length,
        reutilizada: true,
      };
    }

    let previo = GENESIS_HASH;
    const ids: string[] = [];

    for (const [i, e] of entradas.entries()) {
      const id = randomUUID();
      const sellada = appendEntry(
        {
          patientId,
          professionalId: e.professionalId,
          sequenceNumber: i + 1,
          entryType: e.entryType,
          fhirResourceType: e.fhirResourceType,
          content: e.content,
          consultationId: e.consultationId ?? null,
          correctsEntryId: e.corrige ? ids[e.corrige - 1] : null,
          createdAt: e.createdAt,
        },
        previo,
      );

      await prisma.clinicalRecordEntry.create({
        data: {
          id,
          patient_id: patientId,
          professional_id: e.professionalId,
          consultation_id: e.consultationId ?? null,
          corrects_entry_id: e.corrige ? ids[e.corrige - 1] : null,
          entry_type: e.entryType,
          fhir_resource_type: e.fhirResourceType,
          content: e.content as object,
          sequence_number: BigInt(i + 1),
          content_hash: sellada.contentHash,
          previous_hash: sellada.previousHash,
          created_at: e.createdAt,
        },
      });

      ids.push(id);
      previo = sellada.contentHash;
    }
    return { ids, cabeza: previo, largo: entradas.length, reutilizada: false };
  }

  const cadenaJulian = await sembrarCadena(julian, [
    {
      professionalId: ana,
      entryType: 'CONSULTA',
      fhirResourceType: 'Encounter',
      consultationId: consultaDe.get(T.pasado1.id),
      createdAt: enMinutos(T.pasado1.scheduled_at, 28),
      content: {
        motivo: 'Control de hipertensión arterial.',
        evolucion: 'Registros domiciliarios en torno a 140/80 mmHg. Refiere buena adherencia.',
        diagnostico: 'Hipertensión arterial esencial, en tratamiento.',
        plan: 'Continuar enalapril 10 mg/día. Control en 30 días con registro de presión.',
      },
    },
    {
      professionalId: ana,
      entryType: 'DIAGNOSTICO',
      fhirResourceType: 'Condition',
      consultationId: consultaDe.get(T.pasado1.id),
      createdAt: enMinutos(T.pasado1.scheduled_at, 29),
      content: { codigo: 'I10', sistema: 'ICD-10', descripcion: 'Hipertensión esencial (primaria)', estado: 'activo' },
    },
    {
      professionalId: ana,
      entryType: 'PRESCRIPCION',
      fhirResourceType: 'MedicationRequest',
      consultationId: consultaDe.get(T.pasado1.id),
      createdAt: enMinutos(T.pasado1.scheduled_at, 30),
      content: { medicamento: 'Enalapril', dosis: '10 mg', frecuencia: 'cada 24 horas', duracion: '30 días' },
    },
    {
      professionalId: martin,
      entryType: 'ESTUDIO',
      fhirResourceType: 'DiagnosticReport',
      consultationId: consultaDe.get(T.pasado2.id),
      createdAt: enMinutos(T.pasado2.scheduled_at, 25),
      content: { estudio: 'Electrocardiograma de reposo', hallazgos: 'Ritmo sinusal. Sin signos de isquemia aguda.', conclusion: 'ECG dentro de parámetros normales.' },
    },
    {
      // Una corrección: ENG-100. La entrada corregida NO se toca — queda en la
      // cadena y esta la referencia. Es lo que hace auditable la historia y vale
      // la pena mostrarlo.
      professionalId: martin,
      entryType: 'CORRECCION',
      fhirResourceType: 'DiagnosticReport',
      consultationId: consultaDe.get(T.pasado2.id),
      createdAt: enMinutos(T.pasado2.scheduled_at, 90),
      corrige: 4,
      content: { motivo_correccion: 'Se cargó el estudio en el paciente correcto pero con la fecha de realización equivocada.', estudio: 'Electrocardiograma de reposo', fecha_real: fechaAr(enDias(ahora, -12)), conclusion: 'ECG dentro de parámetros normales.' },
    },
  ]);

  const cadenaMarina = await sembrarCadena(marina, [
    {
      professionalId: ana,
      entryType: 'CONSULTA',
      fhirResourceType: 'Encounter',
      consultationId: consultaDe.get(T.pasado3.id),
      createdAt: enMinutos(T.pasado3.scheduled_at, 26),
      content: { motivo: 'Odinofagia y fiebre de tres días.', evolucion: 'Buen estado general, sin dificultad respiratoria.', diagnostico: 'Faringitis aguda probablemente viral.', plan: 'Tratamiento sintomático. Reconsultar si la fiebre persiste más de 48 h.' },
    },
  ]);

  // La foto de la cabeza de cadena: es contra esto que el job semanal compara
  // para detectar entradas borradas. Se siembra ya alineada con lo que acabamos
  // de escribir, así la primera corrida después de la demo no reporta nada.
  for (const [patientId, cadena] of [
    [julian, cadenaJulian],
    [marina, cadenaMarina],
  ] as const) {
    const foto = { head_hash: cadena.cabeza, sequence_number: BigInt(cadena.largo) };
    await prisma.chainHeadSnapshot.upsert({
      where: { patient_id: patientId },
      update: foto,
      create: { patient_id: patientId, ...foto },
    });
  }

  // --- Pagos ---------------------------------------------------------------
  console.log('→ Pagos y reembolsos…');

  const pagados = [T.envivo, T.futuro, T.pasado1, T.pasado2, T.pasado3, T.otro1, T.otro2, T.otro3, T.otro4];
  const pagoDe = new Map<string, string>();

  for (const t of pagados) {
    const pago = await prisma.payment.upsert({
      where: { appointment_id: t.id },
      update: {},
      create: {
        id: idDemo(`pago:${t.id}`),
        appointment_id: t.id,
        // Ids con forma de MercadoPago pero inventados: no hay integración
        // todavía (ENG-63/64), así que no corresponden a ningún pago real.
        mercadopago_preference_id: `demo-pref-${t.id.slice(0, 8)}`,
        mercadopago_payment_id: `demo-pay-${t.id.slice(0, 8)}`,
        amount: t.price,
        currency: 'ARS',
        method: 'account_money',
        status: 'APROBADO',
        confirmed_at: enMinutos(t.scheduled_at, -60),
      },
    });
    pagoDe.set(t.id, pago.id);
  }

  // El turno cancelado tenía pago, y ese pago se reembolsó. Es el único camino
  // que recorre payments → refunds, y sin él la tabla de reembolsos queda vacía.
  const pagoCancelado = (await prisma.payment.upsert({
    where: { appointment_id: T.cancelado.id },
    update: {},
    create: {
      id: idDemo(`pago:${T.cancelado.id}`),
      appointment_id: T.cancelado.id,
      mercadopago_preference_id: `demo-pref-${T.cancelado.id.slice(0, 8)}`,
      mercadopago_payment_id: `demo-pay-${T.cancelado.id.slice(0, 8)}`,
      amount: T.cancelado.price,
      currency: 'ARS',
      method: 'credit_card',
      status: 'REEMBOLSADO',
      confirmed_at: enDias(ahora, -8),
    },
  })).id;
  await prisma.refund.upsert({
    where: { id: idDemo('reembolso:cancelado') },
    update: {},
    create: {
      id: idDemo('reembolso:cancelado'),
      payment_id: pagoCancelado,
      amount: T.cancelado.price,
      status: 'PROCESADO',
      reason: 'Cancelación con más de 24 horas de anticipación.',
      processed_at: enDias(ahora, -5),
    },
  });

  await prisma.paymentWebhookEvent.upsert({
    where: { id: idDemo('webhook:pasado1') },
    update: {},
    create: {
      id: idDemo('webhook:pasado1'),
      payment_id: pagoDe.get(T.pasado1.id)!,
      // La tabla existe para poder ignorar reintentos de MercadoPago sin
      // procesar dos veces el mismo pago. Una fila alcanza para explicarla.
      mercadopago_payment_id: `demo-pay-${T.pasado1.id.slice(0, 8)}`,
      raw_payload: {
        action: 'payment.updated',
        type: 'payment',
        data: { id: `demo-pay-${T.pasado1.id.slice(0, 8)}` },
      },
      processed: true,
      received_at: enMinutos(T.pasado1.scheduled_at, -60),
      processed_at: enMinutos(T.pasado1.scheduled_at, -59),
    },
  });

  // --- Reseñas -------------------------------------------------------------
  console.log('→ Reseñas…');

  const reviewAprobada = (await prisma.review.upsert({
    where: { appointment_id: T.pasado1.id },
    update: {},
    create: {
      id: idDemo('resena:pasado1'),
      patient_id: julian,
      professional_id: ana,
      appointment_id: T.pasado1.id,
      rating: 5,
      comment: 'Muy clara para explicar. Me mandó el resumen escrito después de la consulta y no me quedó ninguna duda de cómo tomar la medicación.',
      status: 'APROBADA',
      moderator_id: idModerador,
      moderated_at: idModerador ? enDias(ahora, -5) : null,
    },
  })).id;

  await prisma.reviewResponse.upsert({
    where: { review_id: reviewAprobada },
    update: {},
    create: {
      id: idDemo('respuesta:pasado1'),
      review_id: reviewAprobada,
      professional_id: ana,
      content: 'Gracias Julián. Nos vemos en el control del mes que viene.',
    },
  });

  await prisma.review.upsert({
    where: { appointment_id: T.pasado3.id },
    update: {},
    create: {
      id: idDemo('resena:pasado3'),
      patient_id: marina,
      professional_id: ana,
      appointment_id: T.pasado3.id,
      rating: 4,
      comment: 'Buena atención, aunque la consulta arrancó unos minutos tarde.',
      // Pendiente a propósito: es lo que la pantalla de moderación tiene que
      // tener para mostrar algo cuando se construya (ENG-81).
      status: 'PENDIENTE_MODERACION',
    },
  });

  await prisma.review.upsert({
    where: { appointment_id: T.pasado2.id },
    update: {},
    create: {
      id: idDemo('resena:pasado2'),
      patient_id: julian,
      professional_id: martin,
      appointment_id: T.pasado2.id,
      rating: 5,
      comment: 'Revisó los estudios que le mandé antes del turno, así que aprovechamos toda la consulta.',
      status: 'APROBADA',
      moderator_id: idModerador,
      moderated_at: idModerador ? enDias(ahora, -8) : null,
    },
  });

  // --- Chat ----------------------------------------------------------------
  console.log('→ Conversaciones y mensajes…');

  const conversacion = (await prisma.conversation.upsert({
    where: { patient_id_professional_id: { patient_id: julian, professional_id: ana } },
    update: {},
    create: {
      id: idDemo('conversacion:julian-ana'),
      patient_id: julian,
      professional_id: ana,
    },
  })).id;

  await prisma.message.createMany({
    data: [
      { id: randomUUID(), conversation_id: conversacion, sender_id: julian, content: 'Hola doctora, una consulta: ¿el enalapril lo tomo antes o después de desayunar?', created_at: enDias(ahora, -6), read_at: enDias(ahora, -6) },
      { id: randomUUID(), conversation_id: conversacion, sender_id: ana, content: 'Hola Julián. Podés tomarlo con el desayuno, no hay problema. Lo importante es que sea siempre a la misma hora.', created_at: enMinutos(enDias(ahora, -6), 45), read_at: enMinutos(enDias(ahora, -6), 60) },
      { id: randomUUID(), conversation_id: conversacion, sender_id: julian, content: 'Perfecto, gracias.', created_at: enMinutos(enDias(ahora, -6), 70), read_at: enMinutos(enDias(ahora, -6), 90) },
      // Sin leer: el badge de no leídos necesita algo que contar.
      { id: randomUUID(), conversation_id: conversacion, sender_id: ana, content: 'Acordate de traer los registros de presión al control.', created_at: enDias(ahora, -1) },
    ],
  });

  // --- Notificaciones ------------------------------------------------------
  console.log('→ Notificaciones…');

  await prisma.notification.createMany({
    data: [
      { id: randomUUID(), user_id: julian, type: 'RECORDATORIO_1H', channel: 'IN_APP', payload: { appointmentId: T.envivo.id, professional: 'Ana García' }, sent_at: enMinutos(ahora, -56) },
      { id: randomUUID(), user_id: julian, type: 'TURNO_RESERVADO', channel: 'EMAIL', payload: { appointmentId: T.impago.id, professional: 'Martín Olivares' }, sent_at: enDias(ahora, -1), read_at: enDias(ahora, -1) },
      { id: randomUUID(), user_id: julian, type: 'NUEVO_MENSAJE', channel: 'PUSH', payload: { conversationId: conversacion, from: 'Ana García' }, sent_at: enDias(ahora, -1) },
      { id: randomUUID(), user_id: julian, type: 'PAGO_CONFIRMADO', channel: 'IN_APP', payload: { appointmentId: T.futuro.id, amount: 16000 }, sent_at: enDias(ahora, -2), read_at: enDias(ahora, -2) },
      { id: randomUUID(), user_id: ana, type: 'RECORDATORIO_24H', channel: 'IN_APP', payload: { appointmentId: T.otro1.id, patient: 'Marina Quiroga' }, sent_at: enDias(ahora, -1) },
      { id: randomUUID(), user_id: marina, type: 'RESENA_MODERADA', channel: 'IN_APP', payload: { professional: 'Ana García', status: 'PENDIENTE_MODERACION' }, sent_at: enDias(ahora, -2) },
    ],
  });

  // --- MediPass ------------------------------------------------------------
  console.log('→ MediPass…');

  /** El código rotativo de ENG-72. Ocho caracteres, sin vocales ni caracteres
   *  ambiguos: se dicta por teléfono en una urgencia y confundir 0 con O o 1 con
   *  I es exactamente el error que no se puede permitir ahí. */
  const generarCodigo = () => {
    const alfabeto = '23456789BCDFGHJKLMNPQRSTVWXZ';
    return Array.from({ length: 8 }, () => alfabeto[Math.floor(Math.random() * alfabeto.length)]).join('');
  };

  // Vigente: es el que muestra la pantalla de MediPass del paciente.
  const codigoVigente = randomUUID();
  await prisma.mediPassCode.create({
    data: { id: codigoVigente, patient_id: julian, code: generarCodigo(), expires_at: enMinutos(ahora, 5) },
  });

  // Ya usado, con la sesión que abrió: es el que da contenido al historial de
  // accesos, que es la mitad del valor de MediPass — el paciente ve quién miró.
  const codigoUsado = randomUUID();
  await prisma.mediPassCode.create({
    data: { id: codigoUsado, patient_id: julian, code: generarCodigo(), expires_at: enDias(ahora, -3), used_at: enDias(ahora, -3), created_at: enDias(ahora, -3) },
  });

  const sesionCerrada = randomUUID();
  await prisma.mediPassSession.create({
    data: {
      id: sesionCerrada,
      patient_id: julian,
      medipass_code_id: codigoUsado,
      consultant_profile_id: martin,
      consultant_name: 'Martín Olivares',
      consultant_license: 'MP-33871',
      started_at: enDias(ahora, -3),
      expires_at: enMinutos(enDias(ahora, -3), 30),
    },
  });

  await prisma.mediPassAccessLog.createMany({
    data: [
      { id: randomUUID(), session_id: sesionCerrada, patient_id: julian, resource_accessed: 'alergias', accessed_at: enMinutos(enDias(ahora, -3), 1) },
      { id: randomUUID(), session_id: sesionCerrada, patient_id: julian, resource_accessed: 'medicacion_activa', accessed_at: enMinutos(enDias(ahora, -3), 2) },
      { id: randomUUID(), session_id: sesionCerrada, patient_id: julian, resource_accessed: 'diagnosticos', accessed_at: enMinutos(enDias(ahora, -3), 4) },
    ],
  });

  // Una sesión revocada por el paciente: el corte de acceso es una funcionalidad
  // del ticket y sin una fila así no se puede mostrar.
  const codigoRevocado = randomUUID();
  await prisma.mediPassCode.create({
    data: { id: codigoRevocado, patient_id: marina, code: generarCodigo(), expires_at: enDias(ahora, -9), used_at: enDias(ahora, -9), created_at: enDias(ahora, -9) },
  });
  await prisma.mediPassSession.create({
    data: {
      id: randomUUID(),
      patient_id: marina,
      medipass_code_id: codigoRevocado,
      consultant_name: 'Guardia — Hospital Privado',
      consultant_license: 'MP-99120',
      started_at: enDias(ahora, -9),
      expires_at: enMinutos(enDias(ahora, -9), 30),
      revoked_at: enMinutos(enDias(ahora, -9), 12),
      revoked_by: marina,
    },
  });

  // --- Auditoría -----------------------------------------------------------
  console.log('→ Auditoría…');

  await prisma.auditLog.createMany({
    data: [
      { id: randomUUID(), actor_id: martin, action: 'CLINICAL_RECORD_VIEWED', resource_type: 'patient', resource_id: julian, metadata: { via: 'medipass', sessionId: sesionCerrada }, created_at: enDias(ahora, -3) },
      { id: randomUUID(), actor_id: ana, action: 'CLINICAL_ENTRY_CREATED', resource_type: 'clinical_record_entry', resource_id: cadenaJulian.ids[0], metadata: { entryType: 'CONSULTA' }, created_at: enMinutos(T.pasado1.scheduled_at, 28) },
      { id: randomUUID(), actor_id: martin, action: 'CLINICAL_ENTRY_CORRECTED', resource_type: 'clinical_record_entry', resource_id: cadenaJulian.ids[4], metadata: { corrects: cadenaJulian.ids[3] }, created_at: enMinutos(T.pasado2.scheduled_at, 90) },
      { id: randomUUID(), actor_id: marina, action: 'MEDIPASS_SESSION_REVOKED', resource_type: 'medipass_session', metadata: { motivo: 'El paciente cortó el acceso desde la app.' }, created_at: enDias(ahora, -9) },
    ],
  });

  // --- Resumen -------------------------------------------------------------
  console.log('');
  console.log('✅ Datos de demo listos.');
  console.log('');
  console.log(`   ${PROFESIONALES.length} profesionales validados · ${PACIENTES.length} pacientes con ficha · ${turnos.length} turnos`);
  const hcNota = cadenaJulian.reutilizada ? ' (ya existía, no se reescribió: es append-only)' : '';
  console.log(`   HC: ${cadenaJulian.largo} + ${cadenaMarina.largo} entradas, cadena verificable${hcNota}`);
  if (!idModerador) {
    console.log(`   ⚠️  No existe ${EMAIL_MODERADOR}: las reseñas quedaron sin moderador.`);
  }
  console.log('');
  console.log('   Cuentas:');
  for (const p of [
    ...PACIENTES.map((x) => ({ ...x, rol: 'paciente   ' })),
    ...PROFESIONALES.map((x) => ({ ...x, rol: 'profesional' })),
  ]) {
    // Las que no son .test conservan su propia contraseña: el script no la pisa.
    const clave = esCuentaDeDemo(p.email) ? '' : '   ← contraseña propia, sin cambios';
    console.log(`     ${p.rol}  ${p.email}${clave}`);
  }
  console.log('');
  console.log('   Las @mediconnect.test usan DEMO_SEED_PASSWORD.');
  console.log('');
  console.log(`   ▶ Videoconsulta: turno de ${PACIENTES[0].firstName} con ${PROFESIONALES[0].firstName} ${PROFESIONALES[0].lastName}`);
  console.log(`     a las ${horaAr(enCurso)} — la sala YA está abierta (la ventana abre 10 min antes).`);
  console.log(`   ▶ Checkout: turno con ${PROFESIONALES[2].firstName} ${PROFESIONALES[2].lastName} a las ${horaAr(masTarde)}, sin pagar.`);
  console.log('');
}

main()
  .catch((e: Error) => {
    console.error('❌ Seed de demo falló:', e.message);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
