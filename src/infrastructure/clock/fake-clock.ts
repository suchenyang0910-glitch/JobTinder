import type { Clock } from '@src/shared/clock/clock';

export class FakeClock implements Clock {
  constructor(private current: Date) {}

  static fromISO(iso: string): FakeClock {
    return new FakeClock(new Date(iso));
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceHours(h: number): void {
    this.advanceMs(h * 60 * 60 * 1000);
  }

  advanceDays(d: number): void {
    this.advanceMs(d * 24 * 60 * 60 * 1000);
  }

  set(to: Date): void {
    this.current = new Date(to.getTime());
  }
}
