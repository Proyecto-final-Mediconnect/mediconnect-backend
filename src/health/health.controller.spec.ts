import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('devuelve status ok', () => {
    expect(controller.check().status).toBe('ok');
  });

  it('devuelve un timestamp ISO válido', () => {
    const { timestamp } = controller.check();
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });
});
