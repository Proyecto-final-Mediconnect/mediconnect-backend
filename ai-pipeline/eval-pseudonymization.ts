// ENG-215 — Evaluación de la seudonimización con el modelo real.
//
//   cd ai-pipeline && npm ci && npm run eval:pseudonymization
//
// Pasa las consultas FICTICIAS de `src/ai/pseudonymization/fixtures.ts` por las
// tres capas y mide:
//   - falsos negativos: identificadores que quedaron a la vista (tiene que ser 0);
//   - falsos positivos sobre datos clínicos: lo que el resumen necesita y se tapó
//     (tiene que ser 0);
//   - memoria y tiempo.
// Termina con código 1 si hay algún falso negativo o algún dato clínico tapado:
// así el workflow falla y no se mergea una regresión.

import { PSEUDONYMIZATION_CASES } from '../src/ai/pseudonymization/fixtures';
import { Pseudonymizer } from '../src/ai/pseudonymization/pseudonymizer';
import { NER_MODEL, TransformersRecognizer } from './transformers-recognizer';

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

const loadStart = performance.now();
const recognizer = await TransformersRecognizer.load();
const loadMs = performance.now() - loadStart;
const pseudonymizer = new Pseudonymizer(recognizer);

let hidden = 0;
let totalHide = 0;
let kept = 0;
let totalKeep = 0;
const failures: string[] = [];
const runStart = performance.now();

for (const testCase of PSEUDONYMIZATION_CASES) {
  const { text, table } = await pseudonymizer.pseudonymize(
    testCase.transcript,
    testCase.known,
  );
  const leaked = testCase.mustHide.filter((value) => text.includes(value));
  const covered = testCase.mustKeep.filter((value) => !text.includes(value));

  hidden += testCase.mustHide.length - leaked.length;
  totalHide += testCase.mustHide.length;
  kept += testCase.mustKeep.length - covered.length;
  totalKeep += testCase.mustKeep.length;

  const ok = leaked.length === 0 && covered.length === 0;
  console.log(`\n${ok ? 'OK ' : 'MAL'} ${testCase.name}`);
  console.log(`    marcadores: ${JSON.stringify(table.summary())}`);
  if (leaked.length > 0) {
    console.log(`    quedaron a la vista: ${leaked.join(' | ')}`);
    failures.push(`${testCase.name}: ${leaked.length} a la vista`);
  }
  if (covered.length > 0) {
    console.log(`    datos clínicos tapados: ${covered.join(' | ')}`);
    failures.push(`${testCase.name}: ${covered.length} datos clínicos tapados`);
  }
  if (process.env.SHOW_TEXT === '1') {
    // Solo con datos ficticios: para mirar a mano qué viajaría al modelo.
    console.log(`\n${text}\n`);
  }
}

const pct = (n: number, total: number) =>
  total === 0 ? '100 %' : `${((n / total) * 100).toFixed(1)} %`;

console.log('\n--- Resultado ---');
console.log(
  `Identificadores tapados: ${hidden}/${totalHide} (${pct(hidden, totalHide)}). Falsos negativos: ${totalHide - hidden}.`,
);
console.log(
  `Datos clínicos intactos: ${kept}/${totalKeep} (${pct(kept, totalKeep)}).`,
);
console.log(
  `Modelo: ${NER_MODEL} (q8). Carga: ${(loadMs / 1000).toFixed(1)} s. Seudonimizar los ${PSEUDONYMIZATION_CASES.length} casos: ${Math.round(performance.now() - runStart)} ms. Memoria: ${mb(process.memoryUsage().rss)}.`,
);

if (failures.length > 0) {
  console.error(`\nMAL ${failures.length} caso(s) con problemas.`);
  process.exitCode = 1;
}
