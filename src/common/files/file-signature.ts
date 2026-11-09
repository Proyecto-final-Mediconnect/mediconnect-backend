/**
 * Los archivos que acepta MediConnect: PDF, JPG y PNG.
 *
 * Los usan los documentos que aporta el paciente (ENG-164) y los adjuntos del
 * chat (ENG-102). Se mira el contenido y no solo el `Content-Type`, que lo pone
 * el cliente: un ejecutable renombrado a `.pdf` no entra.
 */

/** El tope de los dos buckets (`file_size_limit`) y de sus tablas. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Un `Map` y no un objeto: `Content-Type` lo manda el cliente y `constructor` o
// `__proto__` no pueden resolver a nada del prototipo.
const ALLOWED = new Map<string, { ext: string; magic: number[] }>([
  ['application/pdf', { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] }], // %PDF
  ['image/png', { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] }],
  ['image/jpeg', { ext: 'jpg', magic: [0xff, 0xd8, 0xff] }],
]);

/** Los tipos aceptados, para los mensajes de error y los `CHECK` de la base. */
export const ALLOWED_MIME_TYPES = [...ALLOWED.keys()];

/**
 * La extensión con la que se guarda el archivo, si el tipo declarado es uno de
 * los aceptados **y** el contenido empieza con su firma. Si no, `null`.
 */
export function allowedExtension(
  mimetype: string,
  buffer: Buffer,
): string | null {
  const tipo = ALLOWED.get(mimetype);
  if (!tipo) return null;
  return tipo.magic.every((byte, i) => buffer[i] === byte) ? tipo.ext : null;
}
