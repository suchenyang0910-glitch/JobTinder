import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { APP_ENV } from '@src/shared/env/app-env';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private connectPromise: Promise<void> | null = null;

  constructor() {
    super();
  }

  onModuleInit() {
    // Background connect; throw in development only (fail-fast).
    // In all envs we do NOT block the Nest bootstrap on DB readiness — the
    // /health probe is served independently and readiness checks use
    // PrismaService.ping() explicitly. This matches production separation of
    // liveness (process up) vs readiness (DB reachable).
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
