import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import type { Clock } from '@src/shared/clock/clock';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { AppError } from '@src/shared/errors/app-error';
import { IdempotentKeyBuilder } from '@src/shared/idempotency/idempotent-key-builder';
import { OutboxRepository } from '@src/infrastructure/queue/outbox.repository';
import type { OutboxCreateInput } from '@src/infrastructure/queue/outbox.repository';
import {
  applyUserEdits,
  isProfileReadyToConfirm,
  type CandidateDraftFields,
} from '@src/domain/profiles/candidate-profile-domain';
import type { ProfileStatus, Language, UserRole, UserStatus, Prisma } from '@prisma/client';

export interface CreateCandidateDraftInput {
  userId: bigint | number;
  initialFields?: Partial<CandidateDraftFields>;
  source: 'manual' | 'ai' | 'mock';
  aiProviderId?: string;
}

export interface UpdateCandidateDraftInput {
  userId: bigint | number;
  draftId: bigint | number;
  expectedVersion: number;
  edits: Partial<CandidateDraftFields>;
}

export interface ConfirmCandidateProfileInput {
  userId: bigint | number;
  draftId: bigint | number;
  expectedVersion: number;
  finalEdits?: Partial<CandidateDraftFields>;
}

export interface CandidateProfileView {
  id: bigint;
  version: number;
  status: ProfileStatus;
  fields: CandidateDraftFields;
  fieldSources: Record<string, unknown>;
  confirmedAt?: Date;
  draftSource?: string | null;
}

/**
 * Onboarding application service for candidate profiles.
 *
 * Guarantees:
 *  - Drafts are separate from confirmed versions.
 *  - expectedVersion is checked inside a transaction for every write.
 *  - Audit events + outbox notifications are appended in the same transaction.
 */
@Injectable()
export class CandidateOnboardingService {
  private readonly logger = new Logger(CandidateOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    private readonly audit: AuditRepository,
    private readonly outbox: OutboxRepository,
  ) {}

  async createDraft(input: CreateCandidateDraftInput): Promise<CandidateProfileView> {
    const now = this.clock.now();
    const user = await this.prisma.users.findUnique({
      where: { id: BigInt(input.userId) },
      select: { id: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new AppError({ code: AppErrorCode.AUTH_UNAUTHORIZED, message: 'User not active' });
    }
    void IdempotentKeyBuilder; // Imported for future use; idempotency on draft-create done by userId+status lookup

    const fields: CandidateDraftFields = input.initialFields ?? {};

    const created = await this.prisma.$transaction(async (tx) => {
      // Idempotency: if a DRAFT already exists for this user, return it rather than creating duplicates.
      const existing = await tx.candidate_profiles.findFirst({
        where: { user_id: user.id, status: 'DRAFT' },
        orderBy: { version: 'desc' },
      });
      if (existing) return existing;

      // Determine starting version = max existing + 1, else 1
      const maxRow = await tx.candidate_profiles.findFirst({
        where: { user_id: user.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = maxRow ? maxRow.version + 1 : 1;

      const row = await tx.candidate_profiles.create({
        data: {
          user_id: user.id,
          version: nextVersion,
          status: 'DRAFT',
          skills: fields.skills ?? [],
          industries: fields.industries ?? [],
          target_roles: fields.targetRoles ?? [],
          task_keywords: fields.taskKeywords ?? [],
          locations: fields.locations ?? [],
          languages_known: fields.languagesKnown ?? [],
          salary_status: fields.salaryStatus ?? 'NOT_PROVIDED',
          salary_text: fields.salaryText ?? null,
          availability_note: fields.availabilityNote ?? null,
          field_sources: {},
          draft_source: input.source,
          ai_provider_id: input.aiProviderId ?? null,
        },
      });

      await this.audit.record(
        {
          actorId: user.id,
          action: AuditActionEnum.PROFILE_DRAFT_CREATED,
          objectType: 'candidate_profile',
          objectId: row.id,
          version: row.version,
          now,
          metadata: {
            role: 'CANDIDATE',
            draft_version: row.version,
            source: input.source,
            field_count: Object.values(fields).filter((v) =>
              Array.isArray(v) ? v.length > 0 : !!v,
            ).length,
          },
        },
        tx,
      );
      return row;
    });

    return this.toView(created);
  }

  async updateDraft(input: UpdateCandidateDraftInput): Promise<CandidateProfileView> {
    const now = this.clock.now();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.candidate_profiles.findUnique({
        where: { id: BigInt(input.draftId) },
      });
      if (!row) {
        throw new AppError({ code: AppErrorCode.PROFILE_NOT_FOUND });
      }
      if (row.user_id !== BigInt(input.userId)) {
        throw new AppError({ code: AppErrorCode.AUTH_UNAUTHORIZED, message: 'Not owner' });
      }
      if (row.status !== 'DRAFT') {
        throw new AppError({
          code: AppErrorCode.PROFILE_DRAFT_STALE,
          message: `Status=${row.status}`,
        });
      }
      if (row.version !== input.expectedVersion) {
        throw new AppError({ code: AppErrorCode.VERSION_MISMATCH });
      }
      const currentFields: CandidateDraftFields = {
        skills: row.skills,
        industries: row.industries,
        targetRoles: row.target_roles,
        taskKeywords: row.task_keywords,
        locations: row.locations,
        languagesKnown: row.languages_known,
        salaryStatus: row.salary_status,
        salaryText: row.salary_text ?? undefined,
        availabilityNote: row.availability_note ?? undefined,
      };
      const { next, changedFields } = applyUserEdits(currentFields, input.edits);

      const updated = await tx.candidate_profiles.update({
        where: { id: row.id },
        data: {
          skills: next.skills ?? row.skills,
          industries: next.industries ?? row.industries,
          target_roles: next.targetRoles ?? row.target_roles,
          task_keywords: next.taskKeywords ?? row.task_keywords,
          locations: next.locations ?? row.locations,
          languages_known: next.languagesKnown ?? row.languages_known,
          salary_status: next.salaryStatus ?? row.salary_status,
          salary_text: next.salaryText !== undefined ? next.salaryText : row.salary_text,
          availability_note:
            next.availabilityNote !== undefined ? next.availabilityNote : row.availability_note,
        },
      });

      await this.audit.record(
        {
          actorId: row.user_id,
          action: AuditActionEnum.PROFILE_DRAFT_UPDATED,
          objectType: 'candidate_profile',
          objectId: updated.id,
          version: updated.version,
          now,
          metadata: {
            role: 'CANDIDATE',
            draft_version: updated.version,
            changed_fields: changedFields,
          },
        },
        tx,
      );
      return updated;
    });

    return this.toView(updated);
  }

  async confirm(input: ConfirmCandidateProfileInput): Promise<CandidateProfileView> {
    const now = this.clock.now();

    const confirmed = await this.prisma.$transaction(async (tx) => {
      const row = await tx.candidate_profiles.findUnique({ where: { id: BigInt(input.draftId) } });
      if (!row) throw new AppError({ code: AppErrorCode.PROFILE_NOT_FOUND });
      if (row.user_id !== BigInt(input.userId)) {
        throw new AppError({ code: AppErrorCode.AUTH_UNAUTHORIZED });
      }
      if (row.status !== 'DRAFT') {
        throw new AppError({ code: AppErrorCode.PROFILE_DRAFT_STALE });
      }
      if (row.version !== input.expectedVersion) {
        throw new AppError({ code: AppErrorCode.VERSION_MISMATCH });
      }

      let currentFields: CandidateDraftFields = {
        skills: row.skills,
        industries: row.industries,
        targetRoles: row.target_roles,
        taskKeywords: row.task_keywords,
        locations: row.locations,
        languagesKnown: row.languages_known,
        salaryStatus: row.salary_status,
        salaryText: row.salary_text ?? undefined,
        availabilityNote: row.availability_note ?? undefined,
      };
      const changed: string[] = [];
      if (input.finalEdits) {
        const r = applyUserEdits(currentFields, input.finalEdits);
        currentFields = r.next;
        changed.push(...r.changedFields);
      }

      const ready = isProfileReadyToConfirm(currentFields);
      if (!ready.ok) {
        throw new AppError({
          code: AppErrorCode.PROFILE_NOT_CONFIRMED,
          message: `Missing required fields: ${ready.missing.join(', ')}`,
          metadata: { missingFields: ready.missing },
        });
      }

      // Any previous CONFIRMED / PAUSED version for this user is soft-marked deleted.
      await tx.candidate_profiles.updateMany({
        where: {
          user_id: row.user_id,
          id: { not: row.id },
          status: { in: ['CONFIRMED', 'PAUSED'] },
        },
        data: { status: 'DELETED', deleted_at: now, updated_at: now },
      });

      const updated = await tx.candidate_profiles.update({
        where: { id: row.id },
        data: {
          status: 'CONFIRMED',
          version: { increment: 0 }, // Confirmed shares same numeric version as source draft (we keep row)
          confirmed_at: now,
          skills: currentFields.skills ?? row.skills,
          industries: currentFields.industries ?? row.industries,
          target_roles: currentFields.targetRoles ?? row.target_roles,
          task_keywords: currentFields.taskKeywords ?? row.task_keywords,
          locations: currentFields.locations ?? row.locations,
          languages_known: currentFields.languagesKnown ?? row.languages_known,
          salary_status: currentFields.salaryStatus ?? row.salary_status,
          salary_text:
            currentFields.salaryText !== undefined ? currentFields.salaryText : row.salary_text,
          availability_note:
            currentFields.availabilityNote !== undefined
              ? currentFields.availabilityNote
              : row.availability_note,
          // Mark all present fields as user_confirmed
          field_sources: {
            skills: currentFields.skills?.length ? 'user_confirmed' : 'unknown',
            industries: currentFields.industries?.length ? 'user_confirmed' : 'unknown',
            targetRoles: currentFields.targetRoles?.length ? 'user_confirmed' : 'unknown',
            taskKeywords: currentFields.taskKeywords?.length ? 'user_confirmed' : 'unknown',
            locations: currentFields.locations?.length ? 'user_confirmed' : 'unknown',
            languagesKnown: currentFields.languagesKnown?.length ? 'user_confirmed' : 'unknown',
            salaryStatus:
              currentFields.salaryStatus && currentFields.salaryStatus !== 'NOT_PROVIDED'
                ? 'user_confirmed'
                : 'unknown',
            availabilityNote: currentFields.availabilityNote ? 'user_confirmed' : 'unknown',
          },
          updated_at: now,
        },
      });

      await this.audit.record(
        {
          actorId: row.user_id,
          action: AuditActionEnum.PROFILE_CONFIRMED,
          objectType: 'candidate_profile',
          objectId: updated.id,
          version: updated.version,
          now,
          metadata: {
            role: 'CANDIDATE',
            new_version: updated.version,
            changed_from_draft_fields: changed,
          },
        },
        tx,
      );

      // Outbox: (1) PROFILE_CONFIRMED
      const q1 = IdempotentKeyBuilder.notification({
        type: 'PROFILE_CONFIRMED',
        objectId: updated.id,
        objectVersion: updated.version,
      });
      const n1 = await this.tryEnqueueNotify(tx, {
        dedupeKey: q1,
        recipientId: row.user_id,
        type: 'PROFILE_CONFIRMED',
        payload: { profileId: String(updated.id), version: updated.version },
        actorId: row.user_id,
        notificationType: 'PROFILE_CONFIRMED',
        version: updated.version,
        now,
      });

      // Outbox: (2) MATCH_CREATED placeholder queued now with dedupe for future match
      void n1;
      const q2 = IdempotentKeyBuilder.notification({
        type: 'MATCH_CREATED',
        objectId: updated.id,
        objectVersion: updated.version,
      });
      await this.tryEnqueueNotify(tx, {
        dedupeKey: q2,
        recipientId: row.user_id,
        type: 'MATCH_CREATED',
        payload: { profileId: String(updated.id), version: updated.version, hint: 'placeholder' },
        actorId: row.user_id,
        notificationType: 'MATCH_CREATED',
        version: updated.version,
        now,
      });

      // Outbox: (3) INTEREST_REMINDER_24H scheduled 24h later
      const q3 = IdempotentKeyBuilder.notification({
        type: 'INTEREST_REMINDER_24H',
        objectId: updated.id,
        objectVersion: updated.version,
      });
      await this.tryEnqueueNotify(tx, {
        dedupeKey: q3,
        recipientId: row.user_id,
        type: 'INTEREST_REMINDER_24H',
        payload: { profileId: String(updated.id), version: updated.version },
        availableAfter: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        actorId: row.user_id,
        notificationType: 'INTEREST_REMINDER_24H',
        version: updated.version,
        now,
      });

      return updated;
    });

    return this.toView(confirmed);
  }

  private async tryEnqueueNotify(
    tx: Prisma.TransactionClient,
    params: {
      dedupeKey: string;
      recipientId: bigint | number;
      type: OutboxCreateInput['type'];
      payload?: Record<string, unknown>;
      availableAfter?: Date;
      maxAttempts?: number;
      actorId: bigint | number;
      notificationType: string;
      version: number;
      now: Date;
    },
  ): Promise<void> {
    try {
      const row = await this.outbox.createInTx(tx, {
        dedupeKey: params.dedupeKey,
        recipientId: params.recipientId,
        type: params.type,
        payload: params.payload,
        availableAfter: params.availableAfter,
        maxAttempts: params.maxAttempts,
      });
      await this.audit.record(
        {
          actorId: params.actorId,
          action: AuditActionEnum.NOTIFY_QUEUED,
          objectType: 'notification',
          objectId: row.id,
          version: params.version,
          now: params.now,
          metadata: {
            type: params.notificationType,
            recipient_id: String(params.recipientId),
            notification_id: String(row.id),
          },
        },
        tx,
      );
    } catch (e) {
      this.logger.warn(
        `Outbox ${params.notificationType} enqueue failed`,
        e instanceof Error ? e.stack : undefined,
      );
    }
  }

  async getLatestConfirmed(userId: bigint | number): Promise<CandidateProfileView | null> {
    const row = await this.prisma.candidate_profiles.findFirst({
      where: { user_id: BigInt(userId), status: { in: ['CONFIRMED', 'PAUSED'] } },
      orderBy: { version: 'desc' },
    });
    return row ? this.toView(row) : null;
  }

  async getActiveDraft(userId: bigint | number): Promise<CandidateProfileView | null> {
    const row = await this.prisma.candidate_profiles.findFirst({
      where: { user_id: BigInt(userId), status: 'DRAFT' },
      orderBy: { version: 'desc' },
    });
    return row ? this.toView(row) : null;
  }

  private toView(row: {
    id: bigint;
    version: number;
    status: ProfileStatus;
    skills: string[];
    industries: string[];
    target_roles: string[];
    task_keywords: string[];
    locations: string[];
    languages_known: string[];
    salary_status: string;
    salary_text: string | null;
    availability_note: string | null;
    field_sources: unknown;
    confirmed_at: Date | null;
    draft_source: string | null;
  }): CandidateProfileView {
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      fields: {
        skills: row.skills,
        industries: row.industries,
        targetRoles: row.target_roles,
        taskKeywords: row.task_keywords,
        locations: row.locations,
        languagesKnown: row.languages_known,
        salaryStatus: row.salary_status as CandidateDraftFields['salaryStatus'],
        salaryText: row.salary_text ?? undefined,
        availabilityNote: row.availability_note ?? undefined,
      },
      fieldSources: row.field_sources as Record<string, unknown>,
      confirmedAt: row.confirmed_at ?? undefined,
      draftSource: row.draft_source,
    };
  }
}

export type { Language, UserRole, UserStatus };
