import { Global, Logger, Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClinicalDataCipher } from './clinical-data-cipher';

/**
 * ENG-216 — El cipher del contenido clínico, para cualquier módulo.
 *
 * Al arrancar deja dicho en el log si el cifrado está prendido y con qué `kid`
 * (nunca la clave). Si `DATA_ENCRYPTION_KEYS` está mal formada, el backend no
 * arranca: es preferible a guardar datos que después nadie pueda leer.
 */
@Global()
@Module({
  providers: [
    {
      provide: ClinicalDataCipher,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const cipher = ClinicalDataCipher.fromEnv(prisma);
        const logger = new Logger('ClinicalDataCipher');
        if (cipher.enabled) {
          logger.log(
            `Cifrado del contenido clínico activo (clave maestra ${cipher.activeKid}).`,
          );
        } else {
          logger.warn(
            'DATA_ENCRYPTION_KEYS no está configurada: el contenido clínico nuevo se guarda sin cifrar.',
          );
        }
        return cipher;
      },
    },
  ],
  exports: [ClinicalDataCipher],
})
export class CryptoModule {}
