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
 * son pantallas sobre este endpoint, no endpoints nuevos.
 *
 * ENG-60 resolvió el alcance que ENG-57 había dejado abierto: el profesional con
 * un turno no cancelado ve la HC **completa** del paciente, no solo lo que firmó.
 * Trajo su política de RLS, el 403 sin relación y el registro del acceso en
 * `audit_logs`.
 *
 * ENG-100 suma `POST :entryId/corrections`: una corrección es una entrada nueva
 * que referencia a la corregida, así que necesita su propia ruta y no un PATCH —
 * la tabla no admite UPDATE.
 */
@Module({
  controllers: [ClinicalRecordsController],
  providers: [ClinicalRecordsService],
  exports: [ClinicalRecordsService],
})
export class ClinicalRecordsModule {}
