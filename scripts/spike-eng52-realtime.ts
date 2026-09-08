// ENG-52 — Validación empírica de Supabase Realtime con RLS (EP-08: chat).
//
// Prueba, contra un proyecto real de Supabase, que un cliente suscrito por
// WebSocket SOLO recibe los mensajes de las conversaciones en las que participa.
// Es la pregunta que decide si el chat de EP-08 puede apoyarse en Realtime sin
// un backend intermediando cada mensaje.
//
// Requisitos:
//   1. Haber corrido `prisma/spikes/eng52_realtime_chat.sql` en el SQL editor
//      del proyecto (crea las tablas de prueba, las políticas y la publicación).
//   2. En el .env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
//
// Ejecutar:  pnpm run spike:eng52
//
// Crea 3 usuarios de prueba, corre los 5 escenarios y los borra al final (con
// limpieza incluso ante error). Los mensajes y conversaciones cuelgan de esos
// usuarios por FK on delete cascade, así que se van con ellos.
//
// NO toca `conversations` ni `messages` reales.

import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const TABLA = 'spike_realtime_messages';

/** Cuánto se espera a que lleguen los eventos antes de evaluar. */
const VENTANA_MS = 6_000;

/** Cuánto se espera a que un canal pase a SUBSCRIBED antes de rendirse. */
const SUBSCRIBE_TIMEOUT_MS = 15_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Un canal bajo observación: qué esperábamos y qué llegó realmente. */
interface Observador {
  nombre: string;
  canal: RealtimeChannel;
  recibidos: string[];
}

interface Resultado {
  escenario: string;
  esperado: string;
  obtenido: string;
  ok: boolean;
}

function requireEnv(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) {
    console.error(`❌ Falta ${nombre} en el .env`);
    process.exit(1);
  }
  return valor;
}

/**
 * Suscribe un canal a los INSERT de la tabla del spike y acumula lo que llega.
 *
 * `filter` es el filtro del lado del SERVIDOR de Realtime. Ojo con la lectura
 * fácil: el filtro NO es un control de seguridad, es una comodidad para no
 * recibir de más. Quien decide si el cliente puede ver la fila es RLS. Por eso
 * hay escenarios con el mismo filtro y distinto usuario.
 */
async function observar(
  client: SupabaseClient,
  nombre: string,
  filter?: string,
): Promise<Observador> {
  const recibidos: string[] = [];

  const canal = client.channel(`eng52-${nombre}-${randomUUID().slice(0, 8)}`).on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: TABLA,
      ...(filter ? { filter } : {}),
    },
    (payload) => {
      const fila = payload.new as { id?: string; content?: string };
      if (fila?.content) recibidos.push(fila.content);
    },
  );

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`El canal "${nombre}" nunca llegó a SUBSCRIBED`)),
      SUBSCRIBE_TIMEOUT_MS,
    );

    canal.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(timeout);
        reject(
          new Error(`El canal "${nombre}" falló (${status}): ${err?.message}`),
        );
      }
    });
  });

  return { nombre, canal, recibidos };
}

async function main(): Promise<void> {
  const url = requireEnv('SUPABASE_URL');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  // La service_role saltea RLS: se usa para el setup y para insertar los
  // mensajes, que es lo que en la app real haría el backend.
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const creados: string[] = [];
  const canales: RealtimeChannel[] = [];
  const clients: SupabaseClient[] = [];

  /** Alta de usuario de prueba vía Admin API. Devuelve id y credenciales. */
  const crearUsuario = async (
    etiqueta: string,
  ): Promise<{ id: string; email: string; password: string }> => {
    const email = `eng52+${etiqueta}-${randomUUID().slice(0, 8)}@mediconnect.test`;
    const password = `Spike-${randomUUID()}`;

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser(${etiqueta}) falló: ${error.message}`);

    creados.push(data.user.id);
    return { id: data.user.id, email, password };
  };

  /** Cliente autenticado como ese usuario, con el JWT publicado a Realtime. */
  const clienteDe = async (u: {
    email: string;
    password: string;
  }): Promise<SupabaseClient> => {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await client.auth.signInWithPassword({
      email: u.email,
      password: u.password,
    });
    if (error) throw new Error(`signIn(${u.email}) falló: ${error.message}`);

    // Sin esto el socket va como `anon` y RLS evalúa auth.uid() = null: el
    // cliente no recibiría nada y el resultado sería un falso positivo de
    // "RLS funciona". Es la línea que más fácil se olvida.
    await client.realtime.setAuth(data.session!.access_token);

    clients.push(client);
    return client;
  };

  try {
    console.log('→ Creando usuarios de prueba...');
    // Modela el caso real: un profesional con dos pacientes distintos.
    const profesional = await crearUsuario('profesional');
    const pacienteA = await crearUsuario('paciente-a');
    const pacienteC = await crearUsuario('paciente-c');

    console.log('→ Creando las dos conversaciones...');
    const { data: convs, error: errConvs } = await admin
      .from('spike_realtime_conversations')
      .insert([
        { participant_a: pacienteA.id, participant_b: profesional.id },
        { participant_a: pacienteC.id, participant_b: profesional.id },
      ])
      .select('id, participant_a');
    if (errConvs) throw new Error(`insert conversaciones: ${errConvs.message}`);

    // PostgREST no garantiza el orden de las filas devueltas por un insert
    // múltiple, así que no se puede asumir que convs[0] es la de A. Se resuelve
    // cada conversación por su participante.
    const filas = convs as { id: string; participant_a: string }[];
    const conv1 = filas.find((c) => c.participant_a === pacienteA.id);
    const conv2 = filas.find((c) => c.participant_a === pacienteC.id);
    if (!conv1 || !conv2) throw new Error('No se resolvieron las conversaciones');

    console.log(`   profesional=${profesional.id}`);
    console.log(`   pacienteA=${pacienteA.id}  conv1=${conv1.id}`);
    console.log(`   pacienteC=${pacienteC.id}  conv2=${conv2.id}`);

    console.log('→ Abriendo suscripciones...');
    const clientA = await clienteDe(pacienteA);
    const clientC = await clienteDe(pacienteC);
    // Cliente sin sesión: solo la anon key, la misma que viaja en el bundle del
    // frontend. Es el atacante más realista.
    const clientAnon = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    clients.push(clientAnon);

    const obs = {
      // 1) El caso feliz. Sin esto, un "no recibí nada" en los demás no prueba
      //    nada: podría ser que Realtime no esté funcionando.
      aEnSuConv: await observar(clientA, 'a-en-su-conv', `conversation_id=eq.${conv1.id}`),
      // 2) Criterio literal de ENG-52: dos clientes en canales distintos.
      cEnSuConv: await observar(clientC, 'c-en-su-conv', `conversation_id=eq.${conv2.id}`),
      // 3) El que importa: C pide EXPLÍCITAMENTE el canal de la conversación de
      //    A, con el mismo filtro. Si no recibe, el que lo frena es RLS.
      cEspiandoConv1: await observar(clientC, 'c-espiando-conv1', `conversation_id=eq.${conv1.id}`),
      // 4) Sin filtro, toda la tabla. Prueba que el límite es RLS y no el filtro.
      cSinFiltro: await observar(clientC, 'c-sin-filtro'),
      // 5) Sin sesión, solo anon key.
      anonSinFiltro: await observar(clientAnon, 'anon-sin-filtro'),
    };
    canales.push(...Object.values(obs).map((o) => o.canal));

    console.log('→ Insertando un mensaje en cada conversación...');
    const marcaConv1 = `conv1-${randomUUID().slice(0, 8)}`;
    const marcaConv2 = `conv2-${randomUUID().slice(0, 8)}`;

    const { error: errMsgs } = await admin.from(TABLA).insert([
      { conversation_id: conv1.id, sender_id: profesional.id, content: marcaConv1 },
      { conversation_id: conv2.id, sender_id: profesional.id, content: marcaConv2 },
    ]);
    if (errMsgs) throw new Error(`insert mensajes: ${errMsgs.message}`);

    console.log(`→ Esperando ${VENTANA_MS / 1000}s a que lleguen los eventos...\n`);
    await sleep(VENTANA_MS);

    // Diagnóstico clave: ¿A puede LEER su mensaje por HTTP, con las mismas
    // políticas? Separa las dos causas que producen el mismo síntoma:
    //   * no lo lee  → la política RLS está mal y bloquea al participante.
    //   * sí lo lee  → RLS lo permite y el que no se lo entregó fue Realtime.
    const { data: leidoPorA, error: errLectura } = await clientA
      .from(TABLA)
      .select('content')
      .eq('conversation_id', conv1.id);

    console.log(
      `[diagnóstico] A leyendo su conversación por HTTP: ` +
        (errLectura
          ? `error ${errLectura.code} ${errLectura.message}`
          : `${leidoPorA?.length ?? 0} fila(s) ${JSON.stringify(leidoPorA?.map((r) => r.content))}`),
    );
    console.log('');

    const resultados: Resultado[] = [
      {
        escenario: '1. Control positivo — A en su propia conversación',
        esperado: 'recibe conv1',
        obtenido: obs.aEnSuConv.recibidos.join(', ') || '(nada)',
        ok:
          obs.aEnSuConv.recibidos.includes(marcaConv1) &&
          !obs.aEnSuConv.recibidos.includes(marcaConv2),
      },
      {
        escenario: '2. C en su propia conversación (canal distinto)',
        esperado: 'recibe conv2',
        obtenido: obs.cEnSuConv.recibidos.join(', ') || '(nada)',
        ok:
          obs.cEnSuConv.recibidos.includes(marcaConv2) &&
          !obs.cEnSuConv.recibidos.includes(marcaConv1),
      },
      {
        escenario: '3. C se suscribe al canal de la conversación de A',
        esperado: 'no recibe nada',
        obtenido: obs.cEspiandoConv1.recibidos.join(', ') || '(nada)',
        ok: obs.cEspiandoConv1.recibidos.length === 0,
      },
      {
        escenario: '4. C escucha la tabla entera, sin filtro',
        esperado: 'solo conv2',
        obtenido: obs.cSinFiltro.recibidos.join(', ') || '(nada)',
        ok:
          obs.cSinFiltro.recibidos.includes(marcaConv2) &&
          !obs.cSinFiltro.recibidos.includes(marcaConv1),
      },
      {
        escenario: '5. Cliente sin sesión (solo anon key), sin filtro',
        esperado: 'no recibe nada',
        obtenido: obs.anonSinFiltro.recibidos.join(', ') || '(nada)',
        ok: obs.anonSinFiltro.recibidos.length === 0,
      },
    ];

    console.log('[ENG-52] Aislamiento de Realtime con RLS\n');
    for (const r of resultados) {
      console.log(
        `${r.ok ? '✅' : '❌'} ${r.escenario}\n` +
          `     esperado: ${r.esperado}\n` +
          `     obtenido: ${r.obtenido}`,
      );
    }

    const fallos = resultados.filter((r) => !r.ok);
    console.log(
      `\n${resultados.length - fallos.length}/${resultados.length} escenarios OK`,
    );

    if (fallos.length > 0) {
      console.error('\n❌ El aislamiento NO se sostiene. No avanzar con ENG-70.');
      process.exitCode = 1;
    } else {
      console.log(
        '\n✅ Un cliente solo recibe los mensajes de sus propias conversaciones.',
      );
    }
  } finally {
    console.log('\n→ Limpiando...');
    for (const canal of canales) {
      await canal.unsubscribe().catch(() => undefined);
    }
    for (const client of clients) {
      await client.removeAllChannels().catch(() => undefined);
    }
    // Borra usuarios; conversaciones y mensajes se van por FK on delete cascade.
    for (const id of creados) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) console.error(`⚠️  No se pudo borrar el usuario ${id}: ${error.message}`);
    }
    console.log(`   ${creados.length} usuarios de prueba eliminados.`);
  }
}

main().catch((err: unknown) => {
  console.error('\n❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
