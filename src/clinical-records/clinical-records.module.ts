import { Module } from '@nestjs/common';
import { ClinicalRecordsController } from './clinical-records.controller';
import { ClinicalRecordsService } from './clinical-records.service';

/**
 * Historia Clínica (EP-06).
 *
 * ENG-57 dejó el modelo de datos y el service; ENG-58 suma el controller con el
 * alta de entradas y la lectura de la HC.
 *
 * El `GET` sirve a los dos roles con una sola ruta —RLS decide qué devuelve—, así
 * que ENG-59 (el paciente ve su HC) y ENG-60 (el profesional ve la del paciente)
 * son pantallas sobre este endpoint, no endpoints nuevos. ENG-60 sí tiene que
 * traer su política de RLS si decide ampliar lo que ve el profesional, y ENG-100
 * (corregir una entrada) su propio POST, porque una corrección referencia a la
 * entrada corregida.
 */
@Module({
  controllers: [ClinicalRecordsController],
  providers: [ClinicalRecordsService],
  exports: [ClinicalRecordsService],
})
export class ClinicalRecordsModule {}
