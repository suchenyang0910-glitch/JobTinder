export interface Clock {
  now(): Date;
}

export const CLOCK_TOKEN = Symbol('CLOCK_TOKEN');
