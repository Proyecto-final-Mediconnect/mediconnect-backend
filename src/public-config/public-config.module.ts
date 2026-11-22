import { Module } from '@nestjs/common';
import { PublicConfigController } from './public-config.controller';

/** ENG-229 — `GET /config`. */
@Module({ controllers: [PublicConfigController] })
export class PublicConfigModule {}
