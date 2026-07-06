import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('devuelve la página HTML de confirmación con la marca', () => {
      const html = appController.getConfirmationPage();
      expect(html).toContain('MediConnect');
      expect(html).toContain('¡Email confirmado!');
    });
  });
});
