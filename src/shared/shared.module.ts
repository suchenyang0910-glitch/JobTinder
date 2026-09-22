import { Global, Module } from '@nestjs/common';
import { CLOCK_TOKEN, type Clock } from './clock/clock';
import { SystemClock } from '@src/infrastructure/clock/system-clock';
import { APP_ENV } from './env/app-env';

void APP_ENV;

@Global()
@Module({
  providers: [
    {
      provide: CLOCK_TOKEN,
      useClass: SystemClock as unknown as new () => Clock,
    },
  ],
  exports: [CLOCK_TOKEN],
})
export class SharedModule {}
