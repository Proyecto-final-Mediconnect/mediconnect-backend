# Procedimiento de activación del consentimiento legal (ENG-140)

El backend puede **registrar** la aceptación de los textos legales sin **exigirla**.
Lo decide `LEGAL_ENFORCEMENT`, y el orden en que se prende importa: prenderla
antes de tiempo deja a los usuarios existentes sin forma de aceptar.

## Por qué existe el flag

`mediconnect-backend` y `mediconnect-web` son dos servicios distintos en Render,
con deploys independientes que dispara el mismo push a `main`. Entre que termina
uno y termina el otro pasan minutos, y en esa ventana las dos puntas no hablan el
mismo contrato:

| Situación | Qué pasa sin el flag |
| --- | --- |
| Backend nuevo, web vieja | El registro responde **400**: la web no manda `acceptedLegalVersion` y el DTO lo exigía. |
| Backend nuevo, web vieja | Todo usuario existente recibe **403 `LEGAL_NOT_ACCEPTED`** en cualquier ruta autenticada, y la web todavía no tiene la pantalla para aceptar. |
| Web nueva, backend viejo | El registro responde **400**: el `ValidationPipe` corre con `forbidNonWhitelisted` y rechaza el campo de más. |

O sea que **no hay orden de merge que lo evite**: rompe en los dos sentidos. El
flag convierte un deploy coordinado en cuatro deploys independientes.

La app mobile agrava el caso: su pantalla de aceptación viaja en un APK
(ENG-143), y un APK no se despliega, se distribuye. Hasta que el build nuevo esté
en los teléfonos, un paciente mobile sin aceptación queda bloqueado sin salida.

## Estados

**Apagada** (ausente, vacía o `false`) — es el default:

- El registro acepta que `acceptedLegalVersion` no venga. Si viene, tiene que ser
  la vigente: una versión equivocada se rechaza siempre.
- Solo se guarda la fila de `legal_acceptances` si el cliente mandó la
  aceptación. No se inventa una fila que nadie aceptó: esa fila es la prueba del
  consentimiento.
- `LegalAcceptedGuard` deja pasar sin consultar la base.

**Prendida** (`true`):

- El registro sin `acceptedLegalVersion` responde 400. Se valida **antes** del
  `signUp`, así que la cuenta no queda creada en Supabase y el usuario puede
  reintentar con el mismo email.
- Toda ruta autenticada responde 403 `LEGAL_NOT_ACCEPTED` a quien no aceptó la
  versión vigente, salvo las marcadas con `@SkipLegal()`.

## Orden de activación

1. **Mergear y desplegar el backend** con el flag apagado. No cambia nada para
   nadie: a partir de acá se guarda la aceptación de quien la manda.
2. **Mergear y desplegar la web** (ENG-140). Desde acá todo registro nuevo por la
   web queda con su aceptación guardada, y quien ya tenía cuenta ve el pedido de
   consentimiento cuando `GET /me` dice `legalAccepted: false`.
3. **Distribuir el build mobile** (ENG-143) y confirmar que la pantalla de
   aceptación aparece en un dispositivo real, no solo en los tests.
4. **Prender el flag** en Render (`LEGAL_ENFORCEMENT=true`) y reiniciar el
   servicio.
5. **Verificar**, en este orden:
   - registro nuevo por la web: funciona y deja la fila en `legal_acceptances`;
   - registro sin el campo (con `curl`): 400;
   - login con una cuenta anterior: aparece el pedido de consentimiento y, al
     aceptar, entra;
   - login desde el APK: ídem;
   - `GET /health`: sigue respondiendo 200 (está en `@SkipLegal()`).
6. **Endurecer el DTO**: pasar `acceptedLegalVersion` de `@IsOptional()` a
   obligatorio y borrar `requireLegalAcceptance` de `AuthService`, que deja de
   hacer falta. Es el PR que cierra ENG-140.

## Cómo volver atrás

Poner `LEGAL_ENFORCEMENT=false` (o borrarla) y reiniciar. No hace falta
desplegar código ni tocar la base: las filas de `legal_acceptances` ya escritas
quedan como están, y son append-only de todos modos.

El paso 6 es el que no tiene vuelta sin un deploy, y por eso va último y
separado.

## Cuando cambien los textos legales

Subir `LEGAL_VERSION` en el backend (`src/legal/legal.ts`) y en la web
(`src/features/legal/legal.ts`) **a la vez**, y volver a pasar por los pasos 2 a
5: con una versión nueva, todos los usuarios quedan sin aceptación vigente, así
que vuelve a aplicar el mismo problema de ventana entre deploys. Con el flag
apagado durante el cambio, nadie se bloquea mientras los dos lados se ponen de
acuerdo.
