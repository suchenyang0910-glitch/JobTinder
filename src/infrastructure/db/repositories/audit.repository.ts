import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma/prisma.service';
import {
  AuditActionEnum,
  type AuditActionType,
  AUDIT_METADATA_SAFE_KEYS,
} from '@src/shared/audit/audit-action-enum';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { AppError } from '@src/shared/errors/app-error';

/**
 * Audit repository - ONLY accepts safe metadata keys.
 * NEVER call this with raw PII; the write path filters unknown keys defensively.
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  private sanitizeMetadata(raw?: Record<string, unknown>): Record<string, unknown> {
    if (!raw) return {};
    const out: Record<string, unknown> = {};
    const keys = Object.keys(raw);
    for (const k of keys) {
      if (AUDIT_METADATA_SAFE_KEYS.has(k)) {
        out[k] = raw[k];
      }
    }
    return out;
  }

  async record(params: {
    actorId?: bigint | number;
    action: AuditActionType;
    objectType: string;
    objectId?: bigint | number;
    version?: number;
    metadata?: Record<string, unknown>;
    now: Date;
  }): Promise<void> {
    const actionKey = Object.values(AuditActionEnum).find((a) => a === params.action);
    if (!actionKey) {
      throw new AppError({
        code: AppErrorCode.INTERNAL_ASSERTION,
        message: `Invalid audit action: ${params.action}`,
        retryable: false,
      });
    }
    const cleanMeta = this.sanitizeMetadata(params.metadata) as Prisma.JsonObject;
    await this.prisma.audit_events.create({
      data: {
        actor_id: params.actorId ? BigInt(params.actorId) : null,
        action: actionKey,
        object_type: params.objectType,
        object_id: params.objectId ? BigInt(params.objectId) : null,
        version: params.version ?? null,
        metadata: cleanMeta,
        created_at: params.now,
      },
    });
  }
}

import type { Prisma } from '@prisma/client';
