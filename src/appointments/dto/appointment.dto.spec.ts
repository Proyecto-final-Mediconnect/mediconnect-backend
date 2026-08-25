import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AvailabilityQueryDto } from './availability-query.dto';
import { CreateAppointmentDto } from './create-appointment.dto';

/** Propiedades que fallaron la validación, para afirmar el QUÉ y no el mensaje. */
function failedProps(dto: object): string[] {
  return validateSync(dto, { whitelist: true }).map((e) => e.property);
}

const VALID_BOOKING = {
  professionalId: '22222222-2222-4222-8222-222222222222',
  date: '2026-08-17',
  startTime: '09:30',
};

describe('CreateAppointmentDto', () => {
  it('acepta una reserva bien formada', () => {
    const dto = plainToInstance(CreateAppointmentDto, VALID_BOOKING);
    expect(failedProps(dto)).toEqual([]);
  });

  it.each([
    ['professionalId', 'no-es-un-uuid'],
    ['date', '17/08/2026'],
    ['date', '2026-13-01'],
    ['date', '2026-08-32'],
    ['startTime', '9:30'],
    ['startTime', '24:00'],
    ['startTime', '09:60'],
  ])('rechaza %s = %s', (field, value) => {
    const dto = plainToInstance(CreateAppointmentDto, {
      ...VALID_BOOKING,
      [field]: value,
    });

    expect(failedProps(dto)).toContain(field);
  });

  it('acepta la medianoche', () => {
    const dto = plainToInstance(CreateAppointmentDto, {
      ...VALID_BOOKING,
      startTime: '00:00',
    });

    expect(failedProps(dto)).toEqual([]);
  });
});

describe('AvailabilityQueryDto', () => {
  it('acepta un rango bien formado', () => {
    const dto = plainToInstance(AvailabilityQueryDto, {
      from: '2026-08-17',
      to: '2026-08-23',
    });

    expect(failedProps(dto)).toEqual([]);
  });

  it.each(['from', 'to'])('rechaza %s con formato inválido', (field) => {
    const dto = plainToInstance(AvailabilityQueryDto, {
      from: '2026-08-17',
      to: '2026-08-23',
      [field]: '2026-8-1',
    });

    expect(failedProps(dto)).toContain(field);
  });

  it('exige los dos extremos', () => {
    const dto = plainToInstance(AvailabilityQueryDto, {});

    expect(failedProps(dto).sort()).toEqual(['from', 'to']);
  });
});
