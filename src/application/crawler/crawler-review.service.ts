import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CrawlJobStatus,
  JobSourceType,
  JobStatus,
  Prisma,
  SalaryStatus,
} from '@prisma/client';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import {
  assertCrawlJobTransition,
  type CrawlJobStatusValue,
} from '@src/domain/crawler/crawl-job-status-machine';
import { CrawlerOrchestrator } from './crawler-orchestrator.service';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';

@Injectable()
export class CrawlerReviewService {
  private readonly logger = new Logger(CrawlerReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    private readonly orchestrator: CrawlerOrchestrator,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async listPending(limit = 10) {
    return this.prisma.crawl_jobs_staging.findMany({
      where: { status: 'QA_PENDING' },
      orderBy: { id: 'asc' },
      take: Math.min(Math.max(limit, 1), 50),
      select: { id: true, title_source: true, source_url: true, source_id: true },
    });
  }

  async approve(
    stagingId: bigint,
    actorId: bigint | null,
  ): Promise<{ jobId: bigint; stagingId: bigint }> {
    const now = this.clock.now();
    let staging = await this.prisma.crawl_jobs_staging.findUnique({
      where: { id: stagingId },
      include: { source: true, job_translations: true },
    });
    if (!staging)
      throw new AppError({
        code: AppErrorCode.CRAWL_STAGING_NOT_FOUND,
        message: `staging ${String(stagingId)} not found`,
      });

    const from = staging.status;
    if (from !== 'APPROVED') {
      assertCrawlJobTransition(from, 'APPROVED');
    }

    // Remote feeds enter the staging queue directly and may not have gone
    // through the regular crawler translation batch yet. A first approval
    // click must complete that prerequisite instead of surfacing a generic
    // "unexpected error" to the admin.
    if (staging.job_translations.length === 0 && staging.work_mode === 'REMOTE') {
      await this.orchestrator.translateStaging(stagingId);
      const translated = await this.prisma.crawl_jobs_staging.findUnique({
        where: { id: stagingId },
        include: { source: true, job_translations: true },
      });
      if (translated) staging = translated;
    }

    const originalLang = (staging.detected_language as 'km' | 'en' | 'zh_CN' | 'unknown') ?? 'en';
    const originalTrans =
      staging.job_translations.find(
        (t) => t.language === (originalLang === 'unknown' ? 'en' : originalLang),
      ) ?? staging.job_translations[0];
    if (!originalTrans) {
      throw new AppError({
        code: AppErrorCode.CRAWL_TRANSLATION_FAILED,
        message: `No translations found for staging ${String(stagingId)}`,
      });
    }

    const salaryProvided = Boolean(
      staging.salary_source &&
      staging.salary_source.trim().length > 0 &&
      !/面议|negotiable|ចរចា|to be discussed/i.test(staging.salary_source),
    );

    const salaryStatus: SalaryStatus = salaryProvided ? 'PROVIDED' : 'NOT_PROVIDED';
    const salaryText = staging.salary_source ?? null;

    return this.prisma.$transaction(async (tx) => {
      let next = from;
      if (next !== 'APPROVED') {
        await tx.crawl_jobs_staging.update({
          where: { id: stagingId },
          data: { status: 'APPROVED', updated_at: now },
        });
        next = 'APPROVED';
      }

      const titleNonNull = originalTrans.title || staging.title_source;
      if (!titleNonNull) {
        throw new AppError({
          code: AppErrorCode.CRAWL_QA_FAILED,
          message: `Cannot approve without a title`,
        });
      }

      const idemKey = `crawl-publish:${String(stagingId)}:${staging.parse_version}`;

      const jobCreateOrConnect: Prisma.jobsUpsertArgs = {
        where: {
          job_source_uq: {
            source_job_id: staging.source_job_id,
            source_type: 'EXTERNAL' as JobSourceType,
          },
        },
        create: {
          company_id: staging.source?.company_id ?? null,
          source_type: 'EXTERNAL' as JobSourceType,
          source_url: staging.source_url,
          source_job_id: staging.source_job_id,
          idempotency_key: idemKey,
          title: titleNonNull.slice(0, 512),
          industry: originalTrans.industry ?? staging.industry_source ?? null,
          skills: originalTrans.skills ?? [],
          tasks: originalTrans.tasks ?? [],
          locations: originalTrans.locations ?? [],
          languages_required: [],
          shifts: originalTrans.shifts ?? [],
          salary_status: salaryStatus,
          salary_text: salaryText,
          original_published_at: now,
          last_checked_at: now,
          status: 'ACTIVE_EXTERNAL' as JobStatus,
          version: 1,
        },
        update: {
          company_id: staging.source?.company_id ?? null,
          source_url: staging.source_url,
          idempotency_key: idemKey,
          title: titleNonNull.slice(0, 512),
          industry: originalTrans.industry ?? staging.industry_source ?? null,
          skills: originalTrans.skills ?? [],
          tasks: originalTrans.tasks ?? [],
          locations: originalTrans.locations ?? [],
          shifts: originalTrans.shifts ?? [],
          salary_status: salaryStatus,
          salary_text: salaryText,
          last_checked_at: now,
          status: 'ACTIVE_EXTERNAL' as JobStatus,
          version: { increment: 1 },
        },
      };

      const job = await tx.jobs.upsert(jobCreateOrConnect);

      await tx.crawl_jobs_staging.update({
        where: { id: stagingId },
        data: {
          published_job_id: job.id,
          status: 'PUBLISHED',
          updated_at: now,
        },
      });

      await tx.job_translations.updateMany({
        where: { staging_job_id: stagingId },
        data: { qa_status: 'PASSED', review_status: 'PASSED', updated_at: now },
      });

      await this.audit.record(
        {
          action: AuditActionEnum.CRAWL_REVIEW_APPROVED,
          objectType: 'crawl_jobs_staging',
          objectId: stagingId,
          actorId: actorId ?? undefined,
          metadata: {
            source_id: staging.source_id,
            source_job_id: staging.source_job_id,
            job_id: String(job.id),
          },
          now,
        },
        tx,
      );

      await this.audit.record(
        {
          action: AuditActionEnum.CRAWL_JOB_PUBLISHED,
          objectType: 'jobs',
          objectId: job.id,
          actorId: actorId ?? undefined,
          metadata: {
            source_id: staging.source_id,
            source_job_id: staging.source_job_id,
            staging_job_id: String(stagingId),
          },
          now,
        },
        tx,
      );

      return { jobId: job.id, stagingId };
    });
  }

  async reject(
    stagingId: bigint,
    actorId: bigint | null,
    reason: string,
    reasonCode?: string,
  ): Promise<void> {
    const now = this.clock.now();
    const staging = await this.prisma.crawl_jobs_staging.findUnique({ where: { id: stagingId } });
    if (!staging) throw new AppError({ code: AppErrorCode.CRAWL_STAGING_NOT_FOUND });
    const from = staging.status;
    assertCrawlJobTransition(from, 'REJECTED');

    await this.prisma.$transaction(async (tx) => {
      await tx.crawl_jobs_staging.update({
        where: { id: stagingId },
        data: {
          status: 'REJECTED',
          reject_reason: reason.slice(0, 2000),
          updated_at: now,
        },
      });
      await this.audit.record(
        {
          action: AuditActionEnum.CRAWL_REVIEW_REJECTED,
          objectType: 'crawl_jobs_staging',
          objectId: stagingId,
          actorId: actorId ?? undefined,
          metadata: {
            source_id: staging.source_id,
            source_job_id: staging.source_job_id,
            reason: reasonCode ?? reason.slice(0, 120),
          },
          now,
        },
        tx,
      );
    });
  }

  async retryTranslation(stagingId: bigint, actorId: bigint | null): Promise<{ added: number }> {
    const now = this.clock.now();
    const staging = await this.prisma.crawl_jobs_staging.findUnique({ where: { id: stagingId } });
    if (!staging) throw new AppError({ code: AppErrorCode.CRAWL_STAGING_NOT_FOUND });
    const from = staging.status;
    if (
      from !== 'REVIEW_REQUIRED' &&
      from !== 'TRANSLATED' &&
      from !== 'QA_PENDING' &&
      from !== 'DEFERRED'
    ) {
      assertCrawlJobTransition(from, 'TRANSLATED');
    }
    await this.prisma.crawl_jobs_staging.update({
      where: { id: stagingId },
      data: { translation_status: 'NOT_STARTED', review_notified_at: null, updated_at: now },
    });
    const res = await this.orchestrator.translateStaging(stagingId);
    await this.audit.record({
      action: AuditActionEnum.CRAWL_TRANSLATION_DONE,
      objectType: 'crawl_jobs_staging',
      objectId: stagingId,
      actorId: actorId ?? undefined,
      metadata: { retry: '1' },
      now,
    });
    await this.audit.record({
      action: AuditActionEnum.JOB_RETRANSLATED,
      objectType: 'crawl_jobs_staging',
      objectId: stagingId,
      actorId: actorId ?? undefined,
      metadata: {
        old_status: from,
        new_status: 'QA_PENDING',
        retranslation_trigger: 'admin_button',
        added: String(res.added),
        source_id: String(staging.source_id),
      },
      now,
    });
    return { added: res.added };
  }

  async defer(stagingId: bigint, actorId: bigint | null, reason?: string | null): Promise<boolean> {
    const now = this.clock.now();
    const staging = await this.prisma.crawl_jobs_staging.findUnique({ where: { id: stagingId } });
    if (!staging) throw new AppError({ code: AppErrorCode.CRAWL_STAGING_NOT_FOUND });
    const from = staging.status;
    assertCrawlJobTransition(from, 'DEFERRED');
    const res = await this.prisma.$transaction(async (tx) => {
      const row = await tx.crawl_jobs_staging.update({
        where: { id: stagingId },
        data: {
          status: 'DEFERRED',
          review_notified_at: null,
          updated_at: now,
        },
      });
      await this.audit.record(
        {
          action: AuditActionEnum.JOB_DEFERRED,
          objectType: 'crawl_jobs_staging',
          objectId: stagingId,
          actorId: actorId ?? undefined,
          metadata: {
            old_status: from,
            new_status: 'DEFERRED',
            defer_reason: reason ?? null,
            source_id: String(staging.source_id),
            source_job_id: staging.source_job_id,
          },
          now,
        },
        tx,
      );
      return row;
    });
    return Boolean(res);
  }

  async markStale(stagingId: bigint, actorId: bigint | null): Promise<void> {
    const now = this.clock.now();
    const staging = await this.prisma.crawl_jobs_staging.findUnique({ where: { id: stagingId } });
    if (!staging) throw new AppError({ code: AppErrorCode.CRAWL_STAGING_NOT_FOUND });
    const from = staging.status;
    assertCrawlJobTransition(from, 'STALE');
    await this.prisma.$transaction(async (tx) => {
      await tx.crawl_jobs_staging.update({
        where: { id: stagingId },
        data: { status: 'STALE', updated_at: now },
      });
      if (staging.published_job_id) {
        await tx.jobs.update({
          where: { id: staging.published_job_id },
          data: {
            status: 'CLOSED',
            closed_at: now,
            last_checked_at: now,
            version: { increment: 1 },
          },
        });
      }
      await this.audit.record(
        {
          action: AuditActionEnum.CRAWL_JOB_MARKED_STALE,
          objectType: 'crawl_jobs_staging',
          objectId: stagingId,
          actorId: actorId ?? undefined,
          metadata: { source_id: staging.source_id, source_job_id: staging.source_job_id },
          now,
        },
        tx,
      );
    });
  }
}
