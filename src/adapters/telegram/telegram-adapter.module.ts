import { Module } from '@nestjs/common';
import { TelegramBotService } from './telegram-bot.service';
import { PostgresSessionStorage } from '@src/infrastructure/telegram/postgres-session-storage';
import { ApplicationModule } from '@src/application/application.module';
import { SharedModule } from '@src/shared/shared.module';

@Module({
  imports: [SharedModule, ApplicationModule],
  providers: [TelegramBotService, PostgresSessionStorage],
  exports: [TelegramBotService],
})
export class TelegramAdapterModule {}
