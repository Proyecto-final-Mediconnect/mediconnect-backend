# Seudonimización (ENG-215)

Antes de mandar un texto a un modelo de IA (la transcripción de una consulta, en
ENG-214), se reemplaza todo lo que identifica a alguien por un marcador. El
modelo trabaja con marcadores y su respuesta se reidentifica de nuestro lado.
Diseño en el ADR-020, punto 4; probado en el spike ENG-239.

```ts
const pseudonymizer = new Pseudonymizer(await TransformersRecognizer.load()); // una vez por proceso
const { text, table } = await pseudonymizer.pseudonymize(transcripcion, conocidos);
const respuesta = await modelo(text);          // solo `text` sale
const resumen = table.reidentify(respuesta);   // de nuestro lado; después `table` se descarta
```

## Qué se tapa y cómo

| Capa | Qué tapa | Marcador |
| --- | --- | --- |
| 1. Diccionario | Lo que el sistema ya sabe del paciente y del profesional: nombre y apellido (enteros, al revés, por partes, con o sin tildes, con "doctor", "Dra."), DNI con o sin puntos, mail, teléfono (entero, sin 54/9 o sin característica), dirección y matrícula. | `[PACIENTE]`, `[PROFESIONAL]`, `[DNI_n]`, `[MAIL_n]`… |
| 2. Patrones | Mails, URLs, CUIL, número de afiliado o credencial, fechas con año (`14/02/1983`, `3 de agosto de 1950`), DNI con puntos o después de "DNI", direcciones ("calle San Martín 450"), teléfonos y cualquier número de 8 dígitos o más. | `[MAIL_n]`, `[URL_n]`, `[CUIL_n]`, `[AFILIADO_n]`, `[FECHA_n]`, `[DIRECCION_n]`, `[TELEFONO_n]`, `[NUMERO_n]` |
| 3. Entidades | Personas, lugares y organizaciones que nadie cargó ("mi hermana Laura", "vivo en Tandil", "el Hospital Italiano", "OSDE"), con un modelo local multilingüe (`Xenova/distilbert-base-multilingual-cased-ner-hrl`, q8). | `[PERSONA_n]`, `[LUGAR_n]`, `[ORGANIZACION_n]` |

- **El mismo dato da siempre el mismo marcador** (sin importar tildes, mayúsculas
  ni separadores): el modelo entiende que se habla de la misma persona. Se
  numeran por orden de aparición.
- **La capa 3 corre sobre pedazos de hasta 300 palabras, por oración, de a uno.**
  Con la consulta entera el modelo no encontró ningún nombre (ENG-239). Un nombre
  que el modelo vio en un pedazo se tapa en todo el texto.
- **Reidentificación canónica:** `[PACIENTE]` y `[PROFESIONAL]` vuelven con el
  nombre completo ("doctor Gómez" vuelve como "Martín Gómez"); el resto vuelve
  como se dijo. Un marcador que el modelo inventó queda como está.
- **Última barrera:** si después de las tres capas queda a la vista algo de lo que
  el sistema conoce, `pseudonymize` tira `PseudonymizationLeakError` y no se
  manda nada.
- **No se tapa** lo que el resumen necesita: medicamentos y dosis, valores
  ("120/80", "250.000 plaquetas"), fechas sin año ("vuelva el 3 de marzo"),
  enfermedades con nombre propio ("Parkinson"), y palabras comunes que coinciden
  con un nombre ("en paz" cuando la paciente es Rosa Paz: las partes sueltas de un
  nombre solo se tapan con mayúscula).

## Dónde queda cada dato

- **La tabla de equivalencias (`ReidentificationTable`) nunca sale de nuestro
  lado:** ni al proveedor, ni a un log, ni a la base. Los valores viven en campos
  privados (`#`), que `console.log` y `JSON.stringify` no muestran. Para dejar
  registrado que el texto salió seudonimizado está `table.summary()`, que dice
  cuántos valores de cada tipo se taparon, sin datos.
- **Metadatos de la llamada al proveedor (lo cumple ENG-214):** el request lleva
  solo el texto seudonimizado. Ni el id del paciente, ni el del turno, ni el del
  profesional van en el prompt, en los headers ni en `metadata`. Si hace falta un
  identificador para correlacionar, es uno al azar de ese trabajo, que no se
  guarda junto a nada que identifique a la persona.
- **La capa 3 corre en la máquina del pipeline** (GitHub Actions, ADR-020 opción
  A): el texto no sale a ningún servicio para reconocer entidades. Vive en
  `ai-pipeline/` porque el modelo y sus dependencias pesan ~1,4 GB y no entran en
  Render.

## Cómo se mide

- **Tests unitarios** (`pseudonymizer.spec.ts`, en el CI de siempre): las capas 1
  y 2, el armado de pedazos, los marcadores y la reidentificación, con un
  reconocedor de mentira.
- **Evaluación con el modelo real** (`ai-pipeline/eval-pseudonymization.ts`, en el
  workflow `ai-pseudonymization.yml`): pasa las consultas ficticias de
  `fixtures.ts` por las tres capas y falla si un identificador queda a la vista
  (falso negativo) o si se tapa un dato clínico. **El tope aceptado es 0 en los
  dos.** Resultado al 22/11/2026: 39 de 39 identificadores tapados y 22 de 22 datos
  clínicos intactos, ~400 MB de memoria y menos de 1 s para los 5 casos.
- Cada error que aparezca en una consulta real (sin sus datos) se agrega como un
  caso ficticio nuevo en `fixtures.ts`: así queda cubierto para siempre.

## Limitaciones conocidas

- **Es seudonimización, no anonimización.** Una combinación rara de datos que no
  son identificadores (una enfermedad poco común y un pueblo chico) puede seguir
  apuntando a alguien. Por eso se combina con un proveedor que no entrena con los
  datos (ADR-020).
- **El modelo de entidades se puede equivocar** con nombres poco comunes, apodos
  o nombres en minúscula ("vino laura"). Los de la consulta (paciente y
  profesional) no dependen del modelo: los tapa el diccionario.
- **Un DNI dicho con espacios** ("30 123 456") se tapa si es el del paciente
  (diccionario); el de un tercero, solo si se dice "DNI" antes o va con puntos.
- **Algún valor clínico puede taparse de más** (un "1.250.000" se toma por un DNI).
  No se pierde: vuelve al reidentificar, pero el modelo lo ve como un marcador.
- **El audio no se puede seudonimizar:** la voz identifica. Lo cubren el
  consentimiento y el borrado del audio (ADR-020, puntos 3 y 7).
