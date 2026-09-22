import type { Clock } from '@src/shared/clock/clock';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
