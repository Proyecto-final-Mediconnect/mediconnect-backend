import { Module } from '@nestjs/common';
import { ClinicalRecordsService } from './clinical-records.service';

/**
 * Historia Clínica (EP-06).
 *
 * ENG-57 deja solo el modelo de datos y el service: **todavía no hay
 * controller**. Los endpoints los agregan las historias que se apoyan acá —
 * ENG-58 (agregar una entrada), ENG-59 (el paciente ve su HC), ENG-60 (el
 * profesional ve la del paciente) y ENG-100 (corregir una entrada)— y cada una
 * trae también su política de RLS si necesita una nueva.
 *
 * Se registra igual en `AppModule` para que el service esté disponible por
 * inyección desde el primer día y esas cuatro historias no tengan que empezar
 * cableando el módulo.
 */
@Module({
  providers: [ClinicalRecordsService],
  exports: [ClinicalRecordsService],
})
export class ClinicalRecordsModule {}
