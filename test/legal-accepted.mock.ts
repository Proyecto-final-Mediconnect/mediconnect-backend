/**
 * Mock de Prisma para `LegalAcceptedGuard` (ENG-140): el usuario de la sesión
 * ya aceptó la versión vigente de los textos legales.
 *
 * `JwtAuthGuard` exige esa aceptación en toda ruta autenticada. Los e2e que no
 * prueban eso arrancan con un usuario que aceptó, así siguen probando lo suyo;
 * el 403 sin aceptación se prueba en `legal-accepted.e2e-spec.ts`.
 */
export function legalAcceptedPrismaMock() {
  return {
    legalAcceptance: {
      findUnique: jest.fn().mockResolvedValue({ id: 'aceptacion-vigente' }),
    },
  };
}
