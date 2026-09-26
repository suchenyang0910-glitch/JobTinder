import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { AppError } from '@src/shared/errors/app-error';
import type { ApplicationStatus } from '@prisma/client';

export type JobApplicationDto = {
  id: bigint;
  candidateId: bigint;
  jobId: bigint;
  status: ApplicationStatus;
  applicationUrl: string | null;
  appliedAt: Date | null;
  nextFollowUpAt: Date | null;
  lastActionAt: Date | null;
  notes: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SaveJobInput = {
  candidateId: bigint;
  jobId: bigint;
  applicationUrl?: string | null;
  notes?: string | null;
  idempotencyKey?: string;
};

export type MarkAppliedInput = {
  candidateId: bigint;
  jobId: bigint;
  appliedAt?: Date;
  applicationUrl?: string | null;
  notes?: string | null;
  idempotencyKey?: string;
};

export type UpdateStatusInput = {
  candidateId: bigint;
  jobId: bigint;
  status: ApplicationStatus;
  notes?: string | null;
  idempotencyKey?: string;
  actorId?: bigint | number;
};

export type GetByCandidateFilter = {
  candidateId: bigint;
  status?: ApplicationStatus[];
  limit?: number;
  offset?: number;
};

export type FollowUpReminderResult = {
  processed: number;
  notified: number;
  skipped: number;
  errors: number;
};

function applicationIdempotencyKey(
  candidateId: bigint | number | string,
  jobId: bigint | number | string,
): string {
  return `job_application:${candidateId}:${jobId}`;
}

@Injectable()
export class JobApplicationService {
  private readonly logger = new Logger(JobApplicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async saveJob(input: SaveJobInput): Promise<JobApplicationDto> {
    const now = this.clock.now();
    const idemKey =
      input.idempotencyKey ?? applicationIdempotencyKey(input.candidateId, input.jobId);

    const candidate = await this.prisma.candidate_profiles.findFirst({
      where: { id: input.candidateId, deleted_at: null },
      orderBy: { version: 'desc' },
    });
    if (!candidate) {
      throw new AppError({
        code: AppErrorCode.PROFILE_NOT_FOUND,
        message: `candidate ${String(input.candidateId)} not found`,
      });
    }

    const job = await this.prisma.jobs.findUnique({ where: { id: input.jobId } });
    if (!job) {
      throw new AppError({
        code: AppErrorCode.JOB_NOT_FOUND,
        message: `job ${String(input.jobId)} not found`,
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.job_applications.findUnique({
        where: {
          application_cand_job_uq: {
            candidate_id: input.candidateId,
            job_id: input.jobId,
          },
        },
      });

      if (existing) {
        const updated = await tx.job_applications.update({
          where: { id: existing.id },
          data: {
            application_url: input.applicationUrl ?? existing.application_url,
            notes: input.notes ?? existing.notes,
            last_action_at: now,
            updated_at: now,
          },
        });
        return {
          record: updated,
          oldStatus: existing.status,
          newStatus: existing.status,
          existed: true,
        };
      }

      const created = await tx.job_applications.create({
        data: {
          idempotency_key: idemKey,
          candidate_id: input.candidateId,
          job_id: input.jobId,
          status: 'SAVED',
          application_url: input.applicationUrl ?? null,
          notes: input.notes ?? null,
          last_action_at: now,
        },
      });
      return {
        record: created,
        oldStatus: null as ApplicationStatus | null,
        newStatus: 'SAVED' as ApplicationStatus,
        existed: false,
      };
    });

    if (result.oldStatus !== result.newStatus || !result.existed) {
      try {
        await this.audit.record({
          action: AuditActionEnum.JOB_APPLICATION_STATUS_CHANGED,
          objectType: 'job_applications',
          objectId: result.record.id,
          version: result.record.version,
          metadata: {
            candidate_id: String(input.candidateId),
            job_id: String(input.jobId),
            old_status: result.oldStatus ?? 'NONE',
            new_status: result.newStatus,
          },
          now,
        });
      } catch {
        /* audit never breaks business flow */
      }
    }

    return this.mapToDto(result.record);
  }

  async markApplied(input: MarkAppliedInput): Promise<JobApplicationDto> {
    const now = this.clock.now();
    const appliedAt = input.appliedAt ?? now;
    const idemKey =
      input.idempotencyKey ?? applicationIdempotencyKey(input.candidateId, input.jobId);

    const candidate = await this.prisma.candidate_profiles.findFirst({
      where: { id: input.candidateId, deleted_at: null },
      orderBy: { version: 'desc' },
    });
    if (!candidate) {
      throw new AppError({
        code: AppErrorCode.PROFILE_NOT_FOUND,
        message: `candidate ${String(input.candidateId)} not found`,
      });
    }

    const job = await this.prisma.jobs.findUnique({ where: { id: input.jobId } });
    if (!job) {
      throw new AppError({
        code: AppErrorCode.JOB_NOT_FOUND,
        message: `job ${String(input.jobId)} not found`,
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.job_applications.findUnique({
        where: {
          application_cand_job_uq: {
            candidate_id: input.candidateId,
            job_id: input.jobId,
          },
        },
      });

      const nextFollowUp = new Date(appliedAt.getTime() + 3 * 24 * 60 * 60 * 1000);

      if (existing) {
        const updated = await tx.job_applications.update({
          where: { id: existing.id },
          data: {
            status: 'APPLIED',
            applied_at: appliedAt,
            application_url: input.applicationUrl ?? existing.application_url,
            notes: input.notes ?? existing.notes,
            next_follow_up_at: nextFollowUp,
            last_action_at: now,
            updated_at: now,
          },
        });
        return {
          record: updated,
          oldStatus: existing.status,
          newStatus: 'APPLIED' as ApplicationStatus,
        };
      }

      const created = await tx.job_applications.create({
        data: {
          idempotency_key: idemKey,
          candidate_id: input.candidateId,
          job_id: input.jobId,
          status: 'APPLIED',
          applied_at: appliedAt,
          application_url: input.applicationUrl ?? null,
          notes: input.notes ?? null,
          next_follow_up_at: nextFollowUp,
          last_action_at: now,
        },
      });
      return {
        record: created,
        oldStatus: null as ApplicationStatus | null,
        newStatus: 'APPLIED' as ApplicationStatus,
      };
    });

    if (result.oldStatus !== result.newStatus) {
      try {
        await this.audit.record({
          action: AuditActionEnum.JOB_APPLICATION_STATUS_CHANGED,
          objectType: 'job_applications',
          objectId: result.record.id,
          version: result.record.version,
          metadata: {
            candidate_id: String(input.candidateId),
            job_id: String(input.jobId),
            old_status: result.oldStatus ?? 'NONE',
            new_status: result.newStatus,
          },
          now,
        });
      } catch {
        /* audit never breaks business flow */
      }
    }

    return this.mapToDto(result.record);
  }

  async updateStatus(input: UpdateStatusInput): Promise<JobApplicationDto> {
    const now = this.clock.now();
    const idemKey =
      input.idempotencyKey ?? applicationIdempotencyKey(input.candidateId, input.jobId);

    const existing = await this.prisma.job_applications.findUnique({
      where: {
        application_cand_job_uq: {
          candidate_id: input.candidateId,
          job_id: input.jobId,
        },
      },
    });

    if (!existing) {
      throw new AppError({
        code: AppErrorCode.JOB_NOT_FOUND,
        message: `application for candidate ${String(input.candidateId)} job ${String(input.jobId)} not found`,
      });
    }

    const oldStatus = existing.status;
    if (oldStatus === input.status && !input.notes) {
      return this.mapToDto(existing);
    }

    const updated = await this.prisma.job_applications.update({
      where: { id: existing.id },
      data: {
        idempotency_key: idemKey,
        status: input.status,
        notes: input.notes ?? existing.notes,
        last_action_at: now,
        updated_at: now,
      },
    });

    if (oldStatus !== input.status) {
      try {
        await this.audit.record({
          actorId: input.actorId ?? undefined,
          action: AuditActionEnum.JOB_APPLICATION_STATUS_CHANGED,
          objectType: 'job_applications',
          objectId: updated.id,
          version: updated.version,
          metadata: {
            candidate_id: String(input.candidateId),
            job_id: String(input.jobId),
            old_status: oldStatus,
            new_status: input.status,
          },
          now,
        });
      } catch {
        /* audit never breaks business flow */
      }
    }

    return this.mapToDto(updated);
  }

  async getByCandidate(
    filter: GetByCandidateFilter,
  ): Promise<{ items: JobApplicationDto[]; total: number }> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);

    const where = {
      candidate_id: filter.candidateId,
      ...(filter.status?.length ? { status: { in: filter.status } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.job_applications.count({ where }),
      this.prisma.job_applications.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: [{ last_action_at: 'desc' }, { id: 'desc' }],
      }),
    ]);

    return {
      items: rows.map((r) => this.mapToDto(r)),
      total,
    };
  }

  async runFollowUpRemindersCron(opts?: {
    lookAheadMinutes?: number;
    batchSize?: number;
    dryRun?: boolean;
  }): Promise<FollowUpReminderResult> {
    const now = this.clock.now();
    const lookAheadMs = (opts?.lookAheadMinutes ?? 60) * 60 * 1000;
    const batchSize = Math.min(Math.max(opts?.batchSize ?? 100, 1), 500);
    const dryRun = opts?.dryRun ?? false;

    const dueRows = await this.prisma.job_applications.findMany({
      where: {
        status: { in: ['APPLIED', 'SCREENING', 'INTERVIEW'] },
        next_follow_up_at: {
          not: null,
          lte: new Date(now.getTime() + lookAheadMs),
        },
      },
      take: batchSize,
      orderBy: { next_follow_up_at: 'asc' },
    });

    const result: FollowUpReminderResult = {
      processed: dueRows.length,
      notified: 0,
      skipped: 0,
      errors: 0,
    };

    for (const row of dueRows) {
      try {
        const dueDate = row.next_follow_up_at!;
        if (dueDate.getTime() > now.getTime() + lookAheadMs) {
          result.skipped++;
          continue;
        }

        if (!dryRun) {
          const nextReminder = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          await this.prisma.job_applications.update({
            where: { id: row.id },
            data: {
              next_follow_up_at: nextReminder,
              updated_at: now,
            },
          });

          try {
            await this.audit.record({
              action: AuditActionEnum.FOLLOW_UP_REMINDER_SENT,
              objectType: 'job_applications',
              objectId: row.id,
              version: row.version,
              metadata: {
                candidate_id: String(row.candidate_id),
                job_id: String(row.job_id),
                status: row.status,
                scheduled_at: dueDate.toISOString(),
              },
              now,
            });
          } catch {
            /* audit never breaks cron */
          }
        }
        result.notified++;
      } catch (err) {
        this.logger.error(
          `Follow-up reminder failed for application ${String(row.id)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        result.errors++;
      }
    }

    return result;
  }

  private mapToDto(row: {
    id: bigint;
    candidate_id: bigint;
    job_id: bigint;
    status: ApplicationStatus;
    application_url: string | null;
    applied_at: Date | null;
    next_follow_up_at: Date | null;
    last_action_at: Date | null;
    notes: string | null;
    version: number;
    created_at: Date;
    updated_at: Date;
  }): JobApplicationDto {
    return {
      id: row.id,
      candidateId: row.candidate_id,
      jobId: row.job_id,
      status: row.status,
      applicationUrl: row.application_url,
      appliedAt: row.applied_at,
      nextFollowUpAt: row.next_follow_up_at,
      lastActionAt: row.last_action_at,
      notes: row.notes,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
