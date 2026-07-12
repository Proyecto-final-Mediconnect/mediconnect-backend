// Seed de datos base compartidos por todo el equipo. A diferencia de un dump,
// esto es CÓDIGO versionado: corre igual en la BD de cada uno y en CI.
//
// Ejecutar:  pnpm run db:seed   (idempotente: se puede correr varias veces)
//
// Por ahora solo carga el catálogo curado de especialidades (EP-02). Los usuarios
// de prueba dependen de Supabase Auth y NO se seedean acá.

import { PrismaClient } from '../generated/prisma/client';

const prisma = new PrismaClient();

// Catálogo inicial de especialidades médicas (curado; se amplía por PR).
const SPECIALTIES = [
  'Clínica Médica',
  'Pediatría',
  'Ginecología',
  'Cardiología',
  'Dermatología',
  'Traumatología',
  'Oftalmología',
  'Otorrinolaringología',
  'Neurología',
  'Psiquiatría',
  'Psicología',
  'Endocrinología',
  'Gastroenterología',
  'Urología',
  'Nutrición',
  'Kinesiología',
  'Odontología',
];

async function main(): Promise<void> {
  for (const name of SPECIALTIES) {
    await prisma.specialty.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  const total = await prisma.specialty.count();
  console.log(`✅ Seed listo: ${total} especialidades en el catálogo.`);
}

main()
  .catch((e) => {
    console.error('❌ Seed falló:', e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
