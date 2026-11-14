import { PeriodQueryDto } from '../../common/time/period.dto';

/**
 * `?from&to` de "Mi actividad" (ENG-196). Sin fechas, los últimos tres meses
 * calendario enteros (ver `ProfessionalStatsService`).
 */
export class StatsQueryDto extends PeriodQueryDto {}
