import { Controller, Get, Header } from '@nestjs/common';
import { AppService } from './app.service';
import { SkipLegal } from './legal/skip-legal.decorator';

// Pública: sin usuario no hay consentimiento que exigir (ENG-140).
@SkipLegal()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  getConfirmationPage(): string {
    return this.appService.getConfirmationPage();
  }
}
