import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CandidateJobSearchStatus, CompanyHiringStatus, StatusSource } from '@prisma/client';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';

const ALL_CANDIDATE_STATUSES: ReadonlySet<CandidateJobSearchStatus> = new Set([
  'LOOKING_JOB',
  'INTERVIEWING',
  'FOUND_JOB',
  'NOT_LOOKING',
]);

const ALL_COMPANY_STATUSES: ReadonlySet<CompanyHiringStatus> = new Set([
  'OPEN',
  'INTERVIEWING',
  'FILLED',
  'CLOSED',
  'CANCELLED',
]);

@Injectable()
export class ResultFeedbackService {
  private readonly logger = new Logger(ResultFeedbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async updateCandidateJobSearchStatus(
    candidateUserId: bigint,
    newStatus: CandidateJobSearchStatus,
    opts?: {
      source?: StatusSource;
      relatedJobId?: bigint | null;
      fromJtMatch?: boolean;
    },
  ): Promise<{ candidateProfileId: bigint; oldStatus: string | null; newStatus: string }> {
    if (!ALL_CANDIDATE_STATUSES.has(newStatus)) {
      throw new AppError({
        code: AppErrorCode.PROFILE_ROLE_CONFLICT,
        message: `Invalid candidate job search status: ${String(newStatus)}`,
      });
    }
    const now = this.clock.now();
    const source: StatusSource = opts?.source ?? 'MANUAL';
    const profile = await this.prisma.candidate_profiles.findFirst({
      where: { user_id: candidateUserId, deleted_at: null },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        user_id: true,
        job_search_status: true,
        status: true,
      },
    });
    if (!profile) {
      throw new AppError({
        code: AppErrorCode.PROFILE_NOT_FOUND,
        message: `No candidate profile found for user ${String(candidateUserId)}`,
      });
    }
    if (profile.status === 'DELETED') {
      throw new AppError({ code: AppErrorCode.PROFILE_PAUSED });
    }
    const oldStatus = profile.job_search_status;
    return this.prisma.$transaction(async (tx) => {
      await tx.candidate_profiles.update({
        where: { id: profile.id },
        data: {
          job_search_status: newStatus,
          job_search_status_updated_at: now,
          job_search_status_source: source,
        },
      });
      await this.audit.record(
        {
          action: AuditActionEnum.CANDIDATE_STATUS_CHANGED,
          objectType: 'candidate_profiles',
          objectId: profile.id,
          metadata: {
            old_status: oldStatus ?? null,
            new_status: newStatus,
            status_source: source,
            related_job_id: opts?.relatedJobId ? String(opts.relatedJobId) : null,
            from_jt_match: opts?.fromJtMatch != null ? String(opts.fromJtMatch) : null,
            candidate_user_id: String(candidateUserId),
          },
          now,
        },
        tx,
      );
      this.logger.log(
        `[candidate-status] user=${String(candidateUserId)} profile=${String(profile.id)} ${oldStatus} -> ${newStatus} (source=${source})`,
      );
      return { candidateProfileId: profile.id, oldStatus: oldStatus ?? null, newStatus };
    });
  }

  async updateCompanyHiringStatus(
    memberUserId: bigint,
    jobId: bigint,
    newStatus: CompanyHiringStatus,
    opts?: {
      source?: StatusSource;
      fromJtMatch?: boolean;
    },
  ): Promise<{
    jobId: bigint;
    companyId: bigint | null;
    oldStatus: string | null;
    newStatus: string;
  }> {
    if (!ALL_COMPANY_STATUSES.has(newStatus)) {
      throw new AppError({
        code: AppErrorCode.JOB_EXTERNAL_ONLY,
        message: `Invalid company hiring status: ${String(newStatus)}`,
      });
    }
    const now = this.clock.now();
    const source: StatusSource = opts?.source ?? 'MANUAL';
    const membership = await this.prisma.companies_members.findFirst({
      where: { user_id: memberUserId },
      select: { company_id: true, role: true, is_owner: true },
    });
    if (!membership) {
      throw new AppError({ code: AppErrorCode.COMPANY_MEMBERSHIP_REQUIRED });
    }
    const job = await this.prisma.jobs.findUnique({
      where: { id: jobId },
      select: { id: true, company_id: true, status: true, hiring_status: true },
    });
    if (!job) throw new AppError({ code: AppErrorCode.JOB_NOT_FOUND });
    if (job.company_id && job.company_id !== membership.company_id) {
      throw new AppError({ code: AppErrorCode.COMPANY_MEMBERSHIP_REQUIRED });
    }
    const oldStatus = job.hiring_status;
    return this.prisma.$transaction(async (tx) => {
      await tx.jobs.update({
        where: { id: jobId },
        data: {
          hiring_status: newStatus,
          hiring_status_updated_at: now,
          hiring_status_source: source,
        },
      });
      await this.audit.record(
        {
          action: AuditActionEnum.COMPANY_JOB_STATUS_CHANGED,
          objectType: 'jobs',
          objectId: jobId,
          metadata: {
            old_status: oldStatus ?? null,
            new_status: newStatus,
            status_source: source,
            company_id: job.company_id != null ? String(job.company_id) : null,
            member_user_id: String(memberUserId),
            from_jt_match: opts?.fromJtMatch != null ? String(opts.fromJtMatch) : null,
          },
          now,
        },
        tx,
      );
      if (
        (newStatus === 'CLOSED' || newStatus === 'FILLED' || newStatus === 'CANCELLED') &&
        job.status !== 'CLOSED'
      ) {
        try {
          await tx.jobs.update({
            where: { id: jobId },
            data: { status: 'CLOSED', closed_at: now },
          });
        } catch (_e) {
          // ignore cascade update errors here
        }
      }
      this.logger.log(
        `[company-hiring-status] job=${String(jobId)} ${oldStatus} -> ${newStatus} (source=${source})`,
      );
      return {
        jobId,
        companyId: job.company_id ?? null,
        oldStatus: oldStatus ?? null,
        newStatus,
      };
    });
  }
}
