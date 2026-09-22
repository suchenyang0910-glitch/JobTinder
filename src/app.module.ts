import { Module } from '@nestjs/common';
import { APP_ENV } from '@src/shared/env/app-env';
import { SharedModule } from '@src/shared/shared.module';
import { InfrastructureModule } from '@src/infrastructure/infrastructure.module';
import { ApplicationModule } from '@src/application/application.module';
import { TelegramAdapterModule } from '@src/adapters/telegram/telegram-adapter.module';

void APP_ENV;

@Module({
  imports: [SharedModule, InfrastructureModule, ApplicationModule, TelegramAdapterModule],
})
export class AppModule {}
