# Runbook — Verificación de integridad de la Historia Clínica (ENG-85)

Qué hacer cuando llega la alerta de Slack `🚨 Integridad de la Historia Clínica`.

## Qué es esto

Un job semanal (`.github/workflows/integrity-check.yml`, lunes 06:00 UTC) recorre
la cadena de hash SHA-256 de **todos** los pacientes, recalcula cada hash y lo
compara contra la cabeza que dejó la corrida anterior. Es el control que sostiene
el requisito de inalterabilidad del registro clínico de la **Ley 26.529 art. 15**.

El diseño de la cadena está en
[`mediconnect-docs/documentacion-tecnica/spikes/ENG-45-hash-chain.md`](https://github.com/Proyecto-final-Mediconnect/mediconnect-docs/blob/main/documentacion-tecnica/spikes/ENG-45-hash-chain.md).

| Pieza | Dónde |
|---|---|
| Lógica de hash y verificación | `src/common/hash-chain/hash-chain.ts` (ENG-45) |
| Auditoría contra la corrida anterior | `src/integrity/chain-audit.ts` |
| Orquestación y persistencia | `src/integrity/integrity.service.ts` |
| Ejecutable | `scripts/verify-integrity.ts` (`pnpm run verify:integrity`) |
| Historial de corridas | tabla `integrity_checks` |
| Cabeza por paciente | tabla `chain_head_snapshots` |

## Motivos de falla

| Motivo | Qué pasó | Se ve sin la corrida anterior |
|---|---|---|
| `CONTENT_TAMPERED` | Cambió el contenido o el profesional firmante de una entrada, sin recalcular su hash | Sí |
| `BROKEN_LINK` | Se borró o se insertó una entrada en el medio de la cadena | Sí |
| `SEQUENCE_GAP` | Hay un hueco en `sequence_number` | Sí |
| `GENESIS_MISMATCH` | La cadena no arranca en el hash génesis (64 ceros) | Sí |
| `TAIL_TRUNCATED` | Se borraron las **últimas** entradas del paciente | **No** |
| `HISTORY_REWRITTEN` | Se reescribió la cadena hacia adelante y se volvió a sellar | **No** |

Los dos últimos son los que la cadena sola no puede ver —una cadena de hash no
conoce su propia longitud— y por eso existe `chain_head_snapshots`.

## Qué hacer cuando suena la alerta

1. **Mirar el detalle.** La alerta trae el `integrity_checks.id`:

   ```sql
   select status, inconsistencies_found, run_at, jsonb_pretty(details)
     from integrity_checks where id = '<id de la alerta>';
   ```

2. **Descartar la causa benigna.** Antes de asumir manipulación, verificar que no
   haya habido una migración, una restauración de backup o una carga masiva entre
   esta corrida y la anterior. `run_at` de las dos últimas filas de
   `integrity_checks` acota la ventana.

3. **NO "arreglar" la cadena.** No hay que recalcular hashes ni actualizar
   `chain_head_snapshots` a mano para que la próxima corrida dé verde: eso destruye
   la evidencia y blanquea la manipulación. El job ya se cuida de esto solo — **no
   actualiza el snapshot de una cadena que falló** —, así que la alerta se va a
   repetir todas las semanas hasta que se resuelva de verdad. Es intencional.

4. **Escalar.** Una inconsistencia en la HC es un incidente de seguridad con
   implicancias legales, no un bug. Avisar al responsable del proyecto antes de
   tocar la base.

5. **Reconstruir qué pasó.** `audit_logs` registra los accesos a HC. Cruzar el
   `patient_id` y la ventana temporal entre las dos últimas corridas.

## Si la alerta es `⚠️ la verificación no pudo correr`

La integridad **no quedó verificada** esa semana. Suele ser el secret
`DATABASE_URL` vencido o Supabase inaccesible. Corregir y relanzar el workflow a
mano (`workflow_dispatch`); no hace falta esperar al lunes siguiente.

## Correrlo a mano

```bash
# Contra la base local
pnpm run verify:integrity

# Contra otra base
DATABASE_URL="postgresql://..." pnpm run verify:integrity
```

Sale con código `0` si todo verificó y `1` si hay inconsistencias **o** si la
corrida no pudo terminar. Sin `SLACK_WEBHOOK_URL` verifica y registra igual, solo
que no alerta.

## Secrets que necesita el workflow

| Secret | Para qué |
|---|---|
| `DATABASE_URL` | Connection string de producción (Supabase) |
| `SLACK_WEBHOOK_URL` | Incoming Webhook del canal del equipo |

## Límites conocidos

`chain_head_snapshots` vive en la misma base que protege. Un atacante con acceso
de escritura suficiente puede reescribir la cadena **y** el snapshot en la misma
operación, y quedar consistente. Eso sube mucho el costo del ataque —hay que
tocar dos tablas de forma coordinada en vez de un `UPDATE`— pero no lo cierra.

La mitigación que sí lo cierra es el **anclaje externo**: publicar periódicamente
el hash de cabeza de cada paciente fuera del alcance del atacante (otra base, un
log append-only de un tercero, un correo firmado). Lo recomienda el spike ENG-45 y
queda como tarea técnica aparte de EP-06; este job es el lugar natural para
emitir el ancla cuando exista, porque ya recorre todas las cadenas.

Lo que sí queda registrado hoy fuera de la base es el resumen de cada corrida en
el historial de GitHub Actions (`$GITHUB_STEP_SUMMARY`): si alguien manipula
`integrity_checks`, los runs de Actions siguen ahí.

## Qué falta de EP-06

Este job verifica lo que haya en `clinical_record_entries`. **El escritor de HC
todavía no existe**: lo trae ENG-57, junto con los triggers append-only y las
políticas RLS de la tabla. Hasta entonces el job corre sobre una tabla vacía y
reporta `OK` con 0 pacientes, que es lo correcto.

ENG-85 sí adelantó el fix bloqueante que ENG-45 dejó anotado para ENG-57:
`clinical_record_entries.created_at` pasó a `timestamptz(3)` y perdió el
`default now()`. Con `timestamptz(6)` la verificación desde Node reportaba
entradas sanas como manipuladas, y el valor lo tiene que generar la aplicación
para poder sellar la entrada. **ENG-57 tiene que escribir `created_at`
explícitamente**: la columna ya no tiene default.
