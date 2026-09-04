/**
 * ENG-123 — Ancla externa de las cadenas de Historia Clínica.
 *
 * ## Por qué existe
 *
 * ENG-85 detecta que a una cadena le borren la cola o la reescriban hacia
 * adelante, comparándola contra `chain_head_snapshots`. Pero esa tabla vive en
 * **la misma base** que protege: alguien con acceso de escritura a Supabase puede
 * modificar la HC y el snapshot en la misma operación, y el job del lunes reporta
 * `OK`. Es el libro contable y la grabación de la cámara guardados en la misma
 * caja fuerte.
 *
 * Ninguna cadena de hash almacenada en la base que protege puede resolver eso
 * sola. Hace falta una copia **fuera del alcance de quien puede escribir la base**.
 *
 * ## Qué se publica
 *
 * Una sola **raíz** por corrida, no un valor por paciente: con miles de pacientes
 * lo segundo sería ilegible y nadie lo miraría, y el objetivo es que un humano
 * pueda comparar dos valores de un vistazo.
 *
 *     raíz = sha256( por cada paciente, ordenado por patient_id:
 *                      patient_id ‖ \n ‖ sequence_number ‖ \n ‖ head_hash ‖ \n )
 *
 * Si se mueve cualquier cosa en cualquier cadena, la raíz cambia. Cuando no
 * coincida con la última publicada sin que haya crecido nada, hay que ir a mirar
 * — el detalle por paciente ya está en `integrity_checks`.
 *
 * La raíz se publica en Slack y en el resumen de la corrida de GitHub Actions:
 * dos sistemas con credenciales distintas de las de Supabase. La copia que queda
 * en `integrity_checks.details` **no es el ancla** (el atacante puede tocarla),
 * es lo que le permite al job detectar el desvío solo.
 *
 * ## Lo que esto no resuelve
 *
 * Slack es un ancla débil: un admin del workspace puede borrar mensajes, y en el
 * plan gratuito el historial se corta a los 90 días (igual que la retención de
 * logs de Actions). No es a prueba de todo — es una cerradura más, en otro
 * sistema. El atacante pasa de necesitar Supabase a necesitar Supabase **y**
 * Slack **y** el historial de Actions, y encima darse cuenta de que las anclas
 * existen. El ancla fuerte de verdad sería un repo git aparte con rama protegida
 * o un servicio de timestamping; no hace falta para el MVP.
 *
 * Módulo puro a propósito: no toca Prisma ni Nest, para poder probar el
 * determinismo de la raíz en memoria.
 */
import { createHash } from 'node:crypto';

/** Cabeza de la cadena de un paciente, tal como la dejó una corrida sana. */
export interface AnchoredHead {
  patientId: string;
  sequenceNumber: number;
  headHash: string;
}

export interface ChainAnchor {
  /** SHA-256 hex de todas las cabezas. */
  root: string;
  patients: number;
  entries: number;
}

/**
 * Raíz de una corrida vacía: `sha256("")`.
 *
 * Está nombrada en vez de quedar implícita porque es lo que va a publicar el job
 * hasta que ENG-57 escriba la primera entrada de HC, y conviene poder
 * reconocerla de un vistazo en el canal en vez de sospechar de ella.
 */
export const EMPTY_ANCHOR_ROOT = createHash('sha256').update('').digest('hex');

/**
 * Calcula la raíz de un conjunto de cabezas.
 *
 * El orden lo fija esta función (ascendente por `patientId`) y no el llamador: si
 * dependiera del orden en que la base devolvió las filas, dos corridas sobre los
 * mismos datos podrían dar raíces distintas y el ancla no serviría para nada.
 *
 * El separador `\n` es seguro: los tres campos son un UUID, un entero y un hex de
 * 64 caracteres. Ninguno puede contener un salto de línea ni inyectar un
 * separador, así que no hay dos conjuntos distintos que produzcan la misma
 * preimagen.
 */
export function computeAnchor(heads: AnchoredHead[]): ChainAnchor {
  const ordered = [...heads].sort((a, b) =>
    a.patientId < b.patientId ? -1 : a.patientId > b.patientId ? 1 : 0,
  );

  const preimage = ordered
    .map(
      (head) => `${head.patientId}\n${head.sequenceNumber}\n${head.headHash}\n`,
    )
    .join('');

  return {
    root: createHash('sha256').update(preimage, 'utf8').digest('hex'),
    patients: ordered.length,
    // Con la cadena validada la secuencia arranca en 1 y es contigua, así que el
    // `sequenceNumber` de la cabeza es la cantidad de entradas del paciente.
    entries: ordered.reduce((total, head) => total + head.sequenceNumber, 0),
  };
}

/**
 * Compara la raíz de esta corrida contra la de la anterior.
 *
 * **La raíz cambia con cada entrada nueva**, así que un cambio de raíz NO es por
 * sí mismo una señal de manipulación — sería una máquina de falsos positivos.
 * Lo que no tiene explicación legítima es que la raíz cambie **sin que la HC haya
 * crecido**: la tabla es append-only, así que la única forma de que el total de
 * entradas no suba mientras el contenido cambia es que alguien haya reescrito o
 * borrado algo.
 *
 * Este chequeo NO es redundante con el de `chain_head_snapshots` (ENG-85), y esa
 * es su razón de ser: si un atacante reescribe la HC **y** el snapshot de forma
 * coherente, las verificaciones por paciente pasan en verde. La comparación de
 * raíz contra el total de entradas lo agarra igual, porque le exige además
 * mantener el conteo — y aunque también falsee eso, la raíz vieja sigue publicada
 * en Slack y en Actions, fuera de su alcance.
 */
export function anchorRegressed(
  current: ChainAnchor,
  previous: ChainAnchor | null,
): boolean {
  if (!previous) return false;
  if (current.root === previous.root) return false;

  return current.entries <= previous.entries;
}
