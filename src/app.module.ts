import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_ENV } from '@src/shared/env/app-env';
import { SharedModule } from '@src/shared/shared.module';
import { InfrastructureModule } from '@src/infrastructure/infrastructure.module';
import { ApplicationModule } from '@src/application/application.module';
import { TelegramAdapterModule } from '@src/adapters/telegram/telegram-adapter.module';
import { CrawlerInternalController } from '@src/adapters/http/crawler-internal.controller';

void APP_ENV;

const CLI_MODE = process.env.CRAWLER_CLI_MODE === 'true';

@Module({
  imports: [
    SharedModule,
    InfrastructureModule,
    ApplicationModule,
    ...(CLI_MODE ? [] : [TelegramAdapterModule]),
    ScheduleModule.forRoot(),
  ],
  controllers: [CrawlerInternalController],
})
export class AppModule {}
