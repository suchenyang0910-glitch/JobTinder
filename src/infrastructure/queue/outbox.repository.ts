import { Injectable } from '@nestjs/common';
import type { Prisma, notifications } from '@prisma/client';
import { PrismaService } from '../db/prisma/prisma.service';
import type { NotificationType, OutboxStatus } from '@prisma/client';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { AppError } from '@src/shared/errors/app-error';

export interface OutboxCreateInput {
  dedupeKey: string;
  recipientId: bigint | number;
  type: NotificationType;
  payload?: Record<string, unknown>;
  availableAfter?: Date;
  maxAttempts?: number;
}

@Injectable()
export class OutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createInTx(tx: Prisma.TransactionClient, input: OutboxCreateInput): Promise<notifications> {
    const payloadJson = (input.payload ?? {}) as Prisma.InputJsonValue;
    try {
      return await tx.notifications.create({
        data: {
          dedupe_key: input.dedupeKey,
          recipient_id: BigInt(input.recipientId),
          type: input.type,
          payload: payloadJson,
          available_after: input.availableAfter ?? new Date(),
          max_attempts: input.maxAttempts ?? 8,
        },
      });
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        const existing = await tx.notifications.findUnique({
          where: { dedupe_key: input.dedupeKey },
        });
        if (existing) return existing;
      }
      throw new AppError({
        code: AppErrorCode.INTERNAL_DB_ERROR,
        message: 'Outbox create failed',
        retryable: true,
        cause: e,
      });
    }
  }

  async pollBatch(
    tx: Prisma.TransactionClient,
    params: { limit: number; now: Date },
  ): Promise<notifications[]> {
    const rows = await tx.notifications.findMany({
      where: { status: 'PENDING', available_after: { lte: params.now } },
      take: params.limit,
      orderBy: [{ available_after: 'asc' }, { id: 'asc' }],
    });
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await tx.notifications.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });
    return tx.notifications.findMany({ where: { id: { in: ids } } });
  }

  async markSucceeded(
    tx: Prisma.TransactionClient,
    id: bigint | number,
    now: Date,
    extra?: { externalRef?: string | null; note?: string | null },
  ): Promise<void> {
    await tx.notifications.update({
      where: { id: BigInt(id) },
      data: {
        status: 'SUCCEEDED',
        processed_at: now,
        external_ref: extra?.externalRef ?? undefined,
        note_succeeded: extra?.note ?? undefined,
      },
    });
  }

  async markAttemptFailed(
    tx: Prisma.TransactionClient,
    id: bigint | number,
    params: {
      errorCode: string;
      errorDesc: string;
      nextAvailableAfter: Date;
      maxAttempts: number;
      forceDead?: boolean;
      now: Date;
    },
  ): Promise<OutboxStatus> {
    const row = await tx.notifications.findUnique({ where: { id: BigInt(id) } });
    if (!row) {
      throw new AppError({ code: AppErrorCode.NOTIFY_DEDUPE_HIT, message: 'Outbox row missing' });
    }
    const dead = params.forceDead || row.attempts >= params.maxAttempts;
    const status: OutboxStatus = dead ? 'DEAD' : 'PENDING';
    await tx.notifications.update({
      where: { id: BigInt(id) },
      data: {
        status,
        last_error_code: params.errorCode,
        last_error_desc: params.errorDesc.slice(0, 1024),
        available_after: status === 'DEAD' ? row.available_after : params.nextAvailableAfter,
        processed_at: status === 'DEAD' ? params.now : null,
      },
    });
    return status;
  }

  private isUniqueViolation(e: unknown): boolean {
    if (e && typeof e === 'object' && 'code' in e) {
      return (e as { code?: string }).code === 'P2002';
    }
    return false;
  }
}

export type { Prisma };
