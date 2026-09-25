import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma, InterestActorSide, MatchStatus } from '@prisma/client';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { APP_ENV } from '@src/shared/env/app-env';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { CrawlerReviewNotifierService } from '@src/application/crawler/crawler-review-notifier.service';

@Injectable()
export class MatchWorkflowService {
  private readonly logger = new Logger(MatchWorkflowService.name);
  private matchReminder24Lock = false;
  private matchPause72Lock = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() private readonly notifier?: CrawlerReviewNotifierService,
  ) {}

  async candidateExpressInterest(
    candidateUserId: bigint,
    jobId: bigint,
  ): Promise<{ interestId: bigint; matchCreated: boolean; matchId: bigint | null }> {
    const now = this.clock.now();
    const candidate = await this.prisma.candidate_profiles.findFirst({
      where: { user_id: candidateUserId, deleted_at: null, status: 'CONFIRMED' },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, user_id: true },
    });
    if (!candidate) {
      throw new AppError({
        code: AppErrorCode.PROFILE_NOT_CONFIRMED,
        message: 'Candidate profile must be confirmed before expressing interest.',
      });
    }
    const job = await this.prisma.jobs.findUnique({
      where: { id: jobId },
      select: { id: true, status: true, version: true },
    });
    if (!job) throw new AppError({ code: AppErrorCode.JOB_NOT_FOUND });
    if (job.status === 'CLOSED') throw new AppError({ code: AppErrorCode.JOB_ALREADY_CLOSED });

    const side: InterestActorSide = 'CANDIDATE';
    const idem = `interest:${String(candidate.id)}:${String(jobId)}:CANDIDATE:v1`;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.interests.findFirst({
        where: {
          candidate_id: candidate.id,
          job_id: jobId,
          actor_side: side,
        },
        orderBy: { version: 'desc' },
      });
      if (existing && existing.status === 'PENDING') {
        throw new AppError({
          code: AppErrorCode.INTEREST_ALREADY_EXISTS,
          message: 'Candidate already expressed interest.',
        });
      }
      const nextVersion = existing ? existing.version + 1 : 1;
      const interest = await tx.interests.create({
        data: {
          idempotency_key: idem,
          candidate_id: candidate.id,
          job_id: jobId,
          actor_side: side,
          candidate_version: candidate.version,
          job_version: job.version,
          status: 'PENDING',
          version: nextVersion,
          notified_at: now,
        },
      });
      await this.audit.record(
        {
          action: AuditActionEnum.MATCH_INTERESTED_CANDIDATE,
          objectType: 'interests',
          objectId: interest.id,
          metadata: {
            candidate_id: String(candidate.id),
            job_id: String(jobId),
            side,
          },
          now,
        },
        tx,
      );

      const companyInterest = await tx.interests.findFirst({
        where: {
          candidate_id: candidate.id,
          job_id: jobId,
          actor_side: 'COMPANY',
          status: 'PENDING',
        },
      });
      let matchCreated = false;
      let matchId: bigint | null = null;
      if (companyInterest) {
        matchCreated = true;
        const matchRow = await tx.matches.create({
          data: {
            idempotency_key: `match:${String(candidate.id)}:${String(jobId)}:v1`,
            candidate_id: candidate.id,
            job_id: jobId,
            candidate_interest_id: interest.id,
            company_interest_id: companyInterest.id,
          },
        });
        matchId = matchRow.id;
        await tx.interests.updateMany({
          where: {
            id: { in: [interest.id, companyInterest.id] },
          },
          data: { status: 'ACCEPTED', processed_at: now },
        });
        await this.audit.record(
          {
            action: AuditActionEnum.MATCH_CONTACT_OPENED,
            objectType: 'matches',
            objectId: matchRow.id,
            metadata: {
              candidate_id: String(candidate.id),
              job_id: String(jobId),
              candidate_interest_id: String(interest.id),
              company_interest_id: String(companyInterest.id),
            },
            now,
          },
          tx,
        );
      }
      return { interestId: interest.id, matchCreated, matchId };
    });
  }

  async companyExpressInterest(
    memberUserId: bigint,
    jobId: bigint,
    candidateId: bigint,
  ): Promise<{ interestId: bigint; matchCreated: boolean; matchId: bigint | null }> {
    const now = this.clock.now();
    const membership = await this.prisma.companies_members.findFirst({
      where: { user_id: memberUserId },
      include: { company: true },
    });
    if (!membership) {
      throw new AppError({ code: AppErrorCode.COMPANY_MEMBERSHIP_REQUIRED });
    }
    const job = await this.prisma.jobs.findUnique({
      where: { id: jobId },
      select: { id: true, status: true, version: true, company_id: true },
    });
    if (!job) throw new AppError({ code: AppErrorCode.JOB_NOT_FOUND });
    if (job.status === 'CLOSED') throw new AppError({ code: AppErrorCode.JOB_ALREADY_CLOSED });
    if (job.company_id && job.company_id !== membership.company_id) {
      throw new AppError({ code: AppErrorCode.COMPANY_MEMBERSHIP_REQUIRED });
    }
    const candidate = await this.prisma.candidate_profiles.findFirst({
      where: { id: candidateId, deleted_at: null, status: 'CONFIRMED' },
      select: { id: true, version: true },
      orderBy: { version: 'desc' },
    });
    if (!candidate) {
      throw new AppError({ code: AppErrorCode.PROFILE_NOT_FOUND, message: 'Candidate not found' });
    }

    const side: InterestActorSide = 'COMPANY';
    const idem = `interest:${String(candidateId)}:${String(jobId)}:COMPANY:v1`;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.interests.findFirst({
        where: { candidate_id: candidateId, job_id: jobId, actor_side: side },
        orderBy: { version: 'desc' },
      });
      if (existing && existing.status === 'PENDING') {
        throw new AppError({
          code: AppErrorCode.INTEREST_ALREADY_EXISTS,
          message: 'Company already expressed interest.',
        });
      }
      const nextVersion = existing ? existing.version + 1 : 1;
      const interest = await tx.interests.create({
        data: {
          idempotency_key: idem,
          candidate_id: candidateId,
          job_id: jobId,
          actor_side: side,
          candidate_version: candidate.version,
          job_version: job.version,
          status: 'PENDING',
          version: nextVersion,
          notified_at: now,
        },
      });
      await this.audit.record(
        {
          action: AuditActionEnum.MATCH_INTERESTED_COMPANY,
          objectType: 'interests',
          objectId: interest.id,
          metadata: {
            candidate_id: String(candidateId),
            job_id: String(jobId),
            side,
            company_id: String(membership.company_id),
            member_user_id: String(memberUserId),
          },
          now,
        },
        tx,
      );

      const candidateInterest = await tx.interests.findFirst({
        where: {
          candidate_id: candidateId,
          job_id: jobId,
          actor_side: 'CANDIDATE',
          status: 'PENDING',
        },
      });
      let matchCreated = false;
      let matchId: bigint | null = null;
      if (candidateInterest) {
        matchCreated = true;
        const matchRow = await tx.matches.create({
          data: {
            idempotency_key: `match:${String(candidateId)}:${String(jobId)}:v1`,
            candidate_id: candidateId,
            job_id: jobId,
            candidate_interest_id: candidateInterest.id,
            company_interest_id: interest.id,
          },
        });
        matchId = matchRow.id;
        await tx.interests.updateMany({
          where: { id: { in: [interest.id, candidateInterest.id] } },
          data: { status: 'ACCEPTED', processed_at: now },
        });
        await this.audit.record(
          {
            action: AuditActionEnum.MATCH_CONTACT_OPENED,
            objectType: 'matches',
            objectId: matchRow.id,
            metadata: {
              candidate_id: String(candidateId),
              job_id: String(jobId),
            },
            now,
          },
          tx,
        );
      }
      return { interestId: interest.id, matchCreated, matchId };
    });
  }

  @Cron(APP_ENV.MATCH_24H_REMINDER_CRON || '0 15 * * * *', {
    name: 'match_24h_reminder',
  })
  async run24hReminder(): Promise<{ reminded: number; errors: number }> {
    if (this.matchReminder24Lock) {
      this.logger.warn('24h reminder cron in progress, skip.');
      return { reminded: 0, errors: 0 };
    }
    this.matchReminder24Lock = true;
    const now = this.clock.now();
    const cutoff24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    let reminded = 0;
    let errors = 0;
    try {
      const pending = await this.prisma.interests.findMany({
        where: {
          status: 'PENDING',
          reminded_at: null,
          notified_at: { lte: cutoff24 },
        },
        select: { id: true, candidate_id: true, job_id: true, actor_side: true },
        take: 50,
      });
      for (const i of pending) {
        try {
          await this.prisma.interests.update({
            where: { id: i.id },
            data: { reminded_at: now },
          });
          if (this.notifier) {
            await this.notifier.notifyAdminGeneric({
              headline: `⏰ 24h 未处理兴趣提醒`,
              lines: [
                `• side=${i.actor_side} candidate=${String(i.candidate_id)} job=${String(i.job_id)}`,
                `  interest_id=${String(i.id)}`,
              ],
              footer: '请及时处理，72h 未回应将暂停推荐。',
            });
          }
          reminded++;
        } catch (_e) {
          errors++;
        }
      }
      this.logger.log(`24h reminder: reminded=${reminded} errors=${errors}`);
    } finally {
      this.matchReminder24Lock = false;
    }
    return { reminded, errors };
  }

  @Cron(APP_ENV.MATCH_72H_PAUSE_CRON || '0 45 * * * *', {
    name: 'match_72h_pause',
  })
  async run72hPause(): Promise<{ paused: number; errors: number }> {
    if (this.matchPause72Lock) {
      this.logger.warn('72h pause cron in progress, skip.');
      return { paused: 0, errors: 0 };
    }
    this.matchPause72Lock = true;
    const now = this.clock.now();
    const cutoff72 = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    let paused = 0;
    let errors = 0;
    try {
      const stale = await this.prisma.interests.findMany({
        where: {
          status: 'PENDING',
          reminded_at: { not: null, lte: cutoff72 },
        },
        select: { id: true, candidate_id: true, job_id: true },
        take: 50,
      });
      for (const i of stale) {
        try {
          await this.prisma.interests.update({
            where: { id: i.id },
            data: { status: 'EXPIRED', processed_at: now },
          });
          paused++;
        } catch (_e) {
          errors++;
        }
      }
      this.logger.log(`72h pause: paused=${paused} errors=${errors}`);
    } finally {
      this.matchPause72Lock = false;
    }
    return { paused, errors };
  }
}
