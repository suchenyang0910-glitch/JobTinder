// Standalone outbox worker entrypoint.
// Runs separately from the main NestJS HTTP/Bot process.
// Polls the "notifications" outbox table and dispatches via OutboxNotificationHandler.
//
// Lifecycle:
//   PENDING → PROCESSING → handler.dispatch() →
//     success → SUCCEEDED (write audit NOTIFY_SUCCEEDED)
//     fail retryable → PENDING (available_after += backoff)
//     fail dead → DEAD (write audit NOTIFY_FAILED_DEAD)

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { InfrastructureModule } from '@src/infrastructure/infrastructure.module';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { OutboxRepository } from '@src/infrastructure/queue/outbox.repository';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import type { Clock } from '@src/shared/clock/clock';
import { APP_ENV } from '@src/shared/env/app-env';
import { NOTIFY_HANDLER_TOKEN } from '@src/infrastructure/queue/outbox-notification-handler';
import type { OutboxNotificationHandler } from '@src/infrastructure/queue/outbox-notification-handler';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { createHash } from 'node:crypto';

const logger = new Logger('OutboxWorker');

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(InfrastructureModule, {
    logger: ['error', 'warn', 'log'],
  });

  const prisma = app.get(PrismaService);
  const outbox = app.get(OutboxRepository);
  const clock: Clock = app.get(CLOCK_TOKEN as unknown as symbol);
  const handler: OutboxNotificationHandler = app.get(NOTIFY_HANDLER_TOKEN as unknown as symbol);
  const audit: AuditRepository = app.get(AuditRepository as unknown as symbol);

  const BATCH = Number(APP_ENV.OUTBOX_WORKER_BATCH_SIZE ?? 100);
  const INTERVAL_MS = Number(APP_ENV.OUTBOX_WORKER_POLL_INTERVAL_MS ?? 2000);
  const MAX_ATTEMPTS = Number(APP_ENV.OUTBOX_WORKER_MAX_ATTEMPTS ?? 8);
  const ENABLED = !!APP_ENV.OUTBOX_WORKER_ENABLED;

  if (!ENABLED) {
    logger.log('OUTBOX_WORKER_ENABLED=false — worker exiting.');
    await app.close();
    return;
  }

  logger.log(
    `Outbox worker started. poll=${INTERVAL_MS}ms batch=${BATCH} maxAttempts=${MAX_ATTEMPTS}`,
  );

  const stopOn = (signal: NodeJS.Signals) =>
    process.once(signal, () => {
      void (async () => {
        logger.log(`${signal} received — closing outbox worker.`);
        await app.close();
        process.exit(0);
      })();
    });
  stopOn('SIGINT');
  stopOn('SIGTERM');

  const tick = async () => {
    try {
      await prisma.$transaction(async (tx) => {
        const rows = await outbox.pollBatch(tx, { limit: BATCH, now: clock.now() });
        if (rows.length === 0) return;

        for (const row of rows) {
          try {
            const result = await handler.dispatch(row);
            const now = clock.now();
            if (result.ok) {
              await outbox.markSucceeded(tx, row.id, now, {
                externalRef: result.externalRef ?? null,
                note: result.summary ?? null,
              });
              await audit.record({
                actorId: BigInt(0),
                action: AuditActionEnum.NOTIFY_SUCCEEDED,
                objectType: 'notification',
                objectId: BigInt(String(row.id)),
                version: row.attempts,
                now,
                metadata: {
                  type: row.type,
                  attempts: row.attempts,
                  recipient_id: hash8(String(row.recipient_id)),
                  notification_id: String(row.id),
                },
              });
              logger.log(
                `[outbox] OK id=${String(row.id)} type=${row.type} summary=${result.summary ?? '-'}`,
              );
            } else {
              // Non-retryable logical failure — treat as immediate DEAD so we don't spam
              const finalStatus = await outbox.markAttemptFailed(tx, row.id, {
                errorCode: result.errorCode ?? 'LOGIC_FAILED',
                errorDesc: result.errorDesc ?? 'Handler returned ok=false',
                nextAvailableAfter: now,
                maxAttempts: MAX_ATTEMPTS,
                forceDead: true,
                now,
              });
              if (finalStatus === 'DEAD') {
                await audit.record({
                  actorId: BigInt(0),
                  action: AuditActionEnum.NOTIFY_FAILED_DEAD,
                  objectType: 'notification',
                  objectId: BigInt(String(row.id)),
                  version: row.attempts,
                  now,
                  metadata: {
                    type: row.type,
                    attempts: row.attempts,
                    recipient_id: hash8(String(row.recipient_id)),
                    notification_id: String(row.id),
                    reason_code: result.errorCode,
                  },
                });
              }
              logger.warn(
                `[outbox] LOGIC_FAIL id=${String(row.id)} type=${row.type} code=${result.errorCode} status=${finalStatus}`,
              );
            }
          } catch (e) {
            const code =
              e && typeof e === 'object' && 'code' in e ? String(e.code) : 'INTERNAL_UNKNOWN';
            const desc = e instanceof Error ? e.message : String(e ?? 'unknown');
            const delayMs =
              e &&
              typeof e === 'object' &&
              'retryAfterMs' in e &&
              typeof e.retryAfterMs === 'number'
                ? (e as { retryAfterMs: number }).retryAfterMs
                : Math.min(60_000, 1000 * Math.pow(2, Math.max(0, Math.min(row.attempts, 5))));
            const now = clock.now();
            const nextAvailable = new Date(now.getTime() + delayMs);
            const finalStatus = await outbox.markAttemptFailed(tx, row.id, {
              errorCode: code,
              errorDesc: desc,
              nextAvailableAfter: nextAvailable,
              maxAttempts: MAX_ATTEMPTS,
              now,
            });
            if (finalStatus === 'DEAD') {
              await audit.record({
                actorId: BigInt(0),
                action: AuditActionEnum.NOTIFY_FAILED_DEAD,
                objectType: 'notification',
                objectId: BigInt(String(row.id)),
                version: row.attempts,
                now,
                metadata: {
                  type: row.type,
                  attempts: row.attempts,
                  recipient_id: hash8(String(row.recipient_id)),
                  notification_id: String(row.id),
                  reason_code: code,
                },
              });
            }
            logger.warn(
              `[outbox] TRANSIENT id=${String(row.id)} type=${row.type} attempts=${row.attempts} status=${finalStatus} code=${code}`,
            );
          }
        }
      });
    } catch (e) {
      const stack = e instanceof Error ? e.stack : undefined;
      logger.error('Outbox tick failed', stack);
    }
  };

  setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  void tick();
}

function hash8(plain: string): string {
  return createHash('sha256').update(plain).digest('hex').slice(0, 8);
}

bootstrap().catch((e) => {
  logger.error('Outbox worker bootstrap failed', e?.stack ?? undefined);
  process.exit(1);
});
