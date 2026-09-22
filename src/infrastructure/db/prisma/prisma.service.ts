import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { APP_ENV } from '@src/shared/env/app-env';

/**
 * Error codes emitted by Prisma at the runtime/engine layer before any query
 * reaches Postgres. All of these signal "DB unavailable right now" and should
 * be surfaced to end users as a friendly retry prompt, never "Unexpected error".
 *  P1000  Authentication failed
 *  P1001  Can't reach DB server (refused / timeout)
 *  P1002  DB server reached but timed out
 *  P1003  Database does not exist (common during local setup)
 *  P1008  Operation timed out (long-running / overloaded)
 *  P1017  Server has closed the connection
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private connectPromise: Promise<void> | null = null;

  constructor() {
    super();
  }

  onModuleInit() {
    // Background connect; never fatal to Nest bootstrap (liveness/readiness split).
    const p = this.$connect()
      .then(() => this.logger.log('Prisma connected OK'))
      .catch((e: unknown) => {
        const stack = e instanceof Error ? e.stack : undefined;
        if (APP_ENV.NODE_ENV === 'development') {
          this.logger.warn(
            `Prisma connect FAILED (not fatal — process stays up so /health works). ` +
              `Start Postgres and retry the failing operation: ${e instanceof Error ? e.message : String(e)}`,
          );
        } else {
          this.logger.error('Prisma connect FAILED', stack);
        }
      });
    this.connectPromise = p;
  }

  async onModuleDestroy() {
    try {
      await this.$disconnect();
    } catch {
      /* ignore */
    }
  }

  /** Readiness check — resolves true when Prisma $connect has succeeded. */
  async ping(): Promise<boolean> {
    try {
      await this.connectPromise;
      const one = await this.$queryRawUnsafe<{ one: bigint }[]>('SELECT 1 AS one;');
      return Array.isArray(one) && one.length > 0;
    } catch {
      return false;
    }
  }
}
