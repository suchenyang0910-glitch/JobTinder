import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { CrawlerReviewService } from './crawler-review.service';
import { CrawlerReviewNotifierService } from './crawler-review-notifier.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { APP_ENV } from '@src/shared/env/app-env';
import {
  assertCrawlJobTransition,
  type CrawlJobStatusValue,
} from '@src/domain/crawler/crawl-job-status-machine';

const USER_AGENT = 'Mozilla/5.0 (compatible; JobTinderLifecycle/1.0; +https://jobtinder.kh/bot)';

type LifecycleStats = {
  staleMarkedHttp404: number;
  expiredDeadline: number;
  notified72h: number;
  skipped: number;
  errors: number;
};

@Injectable()
export class CrawlerLifecycleService {
  private readonly logger = new Logger(CrawlerLifecycleService.name);
  private staleCheckLock = false;
  private expireCheckLock = false;
  private notify72hLock = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crawlerReview: CrawlerReviewService,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() private readonly notifier?: CrawlerReviewNotifierService,
  ) {}

  @Cron(APP_ENV.CRAWLER_LIFECYCLE_STALE_CRON || '0 0 * * * *', {
    name: 'crawler_lifecycle_stale',
    disabled: !APP_ENV.CRAWLER_ENABLED,
  })
  async runStaleCheckCron(): Promise<LifecycleStats> {
    if (!APP_ENV.CRAWLER_ENABLED) return this.emptyStats();
    if (this.staleCheckLock) {
      this.logger.warn('Stale check cron still in progress, skipping tick.');
      return this.emptyStats();
    }
    this.staleCheckLock = true;
    const stats = this.emptyStats();
    try {
      const candidates = await this.prisma.crawl_jobs_staging.findMany({
        where: {
          status: { in: ['APPROVED', 'PUBLISHED', 'PAUSED'] as CrawlJobStatusValue[] },
        },
        select: {
          id: true,
          status: true,
          source_url: true,
          published_job_id: true,
          updated_at: true,
        },
        take: 50,
        orderBy: { updated_at: 'asc' },
      });
      for (const row of candidates) {
        try {
          const status = await this.fetchUrlStatus(row.source_url);
          if (status === 404 || status === 410) {
            try {
              await this.crawlerReview.markStale(row.id, null);
              stats.staleMarkedHttp404 += 1;
            } catch (_staleErr) {
              stats.skipped += 1;
            }
          } else {
            stats.skipped += 1;
          }
        } catch (_httpErr) {
          stats.errors += 1;
        }
      }
      this.logger.log(
        `Stale check cron: http404_marked=${stats.staleMarkedHttp404} skipped=${stats.skipped} errors=${stats.errors}`,
      );
    } catch (e) {
      this.logger.error(
        `Stale check cron failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
    } finally {
      this.staleCheckLock = false;
    }
    return stats;
  }

  @Cron(APP_ENV.CRAWLER_LIFECYCLE_EXPIRE_CRON || '0 0 1 * * *', {
    name: 'crawler_lifecycle_expire',
    disabled: !APP_ENV.CRAWLER_ENABLED,
  })
  async runExpireDeadlineCron(): Promise<LifecycleStats> {
    if (!APP_ENV.CRAWLER_ENABLED) return this.emptyStats();
    if (this.expireCheckLock) {
      this.logger.warn('Expire deadline cron still in progress, skipping tick.');
      return this.emptyStats();
    }
    this.expireCheckLock = true;
    const stats = this.emptyStats();
    const now = this.clock.now();
    try {
      const due = await this.prisma.crawl_jobs_staging.findMany({
        where: {
          status: { in: ['APPROVED', 'PUBLISHED', 'PAUSED', 'DEFERRED'] as CrawlJobStatusValue[] },
          OR: [{ expiry_date: { not: null, lte: now } }],
        },
        select: {
          id: true,
          status: true,
          published_job_id: true,
          source_id: true,
          source_job_id: true,
          expiry_date: true,
        },
      });
      for (const row of due) {
        try {
          await this.expireStaging(row.id, row.status, {
            jobId: row.published_job_id,
            sourceId: row.source_id,
            sourceJobId: row.source_job_id,
          });
          stats.expiredDeadline += 1;
        } catch (_e) {
          stats.errors += 1;
        }
      }
      this.logger.log(`Expire cron: expired=${stats.expiredDeadline} errors=${stats.errors}`);
    } catch (e) {
      this.logger.error(
        `Expire cron failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
    } finally {
      this.expireCheckLock = false;
    }
    return stats;
  }

  @Cron(APP_ENV.CRAWLER_LIFECYCLE_NOTIFY72H_CRON || '0 30 9 * * *', {
    name: 'crawler_lifecycle_notify72h',
    disabled: !APP_ENV.CRAWLER_ENABLED,
  })
  async run72hUnupdatedNotifyCron(): Promise<LifecycleStats> {
    if (!APP_ENV.CRAWLER_ENABLED || !this.notifier) return this.emptyStats();
    if (this.notify72hLock) {
      this.logger.warn('72h notify cron still in progress, skipping tick.');
      return this.emptyStats();
    }
    this.notify72hLock = true;
    const stats = this.emptyStats();
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    try {
      const rows = await this.prisma.crawl_jobs_staging.findMany({
        where: {
          status: { in: ['APPROVED', 'PUBLISHED', 'PAUSED'] as CrawlJobStatusValue[] },
          updated_at: { lte: cutoff },
        },
        select: { id: true, title_source: true, source_url: true, status: true, updated_at: true },
        take: 20,
        orderBy: { updated_at: 'asc' },
      });
      if (rows.length > 0) {
        const ok = await this.notifier.notifyAdminGeneric({
          headline: `📮 72h 未更新岗位：${rows.length} 条`,
          lines: rows.map(
            (r) =>
              `• [${r.status}] ${(r.title_source || '(无标题)').slice(0, 48)}  ` +
              `updated=${this.formatAge(r.updated_at, now)}\n  ${r.source_url}`,
          ),
          footer: '请前往 /review 确认是否仍有效。',
        });
        stats.notified72h = ok ? rows.length : 0;
      }
      this.logger.log(`72h notify cron: rows=${rows.length} notified=${stats.notified72h}`);
    } catch (e) {
      this.logger.error(
        `72h notify cron failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
    } finally {
      this.notify72hLock = false;
    }
    return stats;
  }

  private emptyStats(): LifecycleStats {
    return {
      staleMarkedHttp404: 0,
      expiredDeadline: 0,
      notified72h: 0,
      skipped: 0,
      errors: 0,
    };
  }

  private async fetchUrlStatus(url: string): Promise<number> {
    const ac = new AbortController();
    const timeoutMs = 10_000;
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      for (const method of ['HEAD', 'GET'] as const) {
        try {
          const resp = await fetch(url, {
            method,
            headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
            redirect: 'follow',
            signal: ac.signal,
          });
          return resp.status;
        } catch (_e) {
          // try next method
        }
      }
      return 0;
    } finally {
      clearTimeout(t);
    }
  }

  private async expireStaging(
    stagingId: bigint,
    from: string,
    refs: { jobId: bigint | null; sourceId: bigint; sourceJobId: string },
  ): Promise<void> {
    assertCrawlJobTransition(from as CrawlJobStatusValue, 'EXPIRED');
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.crawl_jobs_staging.update({
        where: { id: stagingId },
        data: {
          status: 'EXPIRED',
          closed_reason: 'DEADLINE',
          updated_at: now,
        },
      });
      if (refs.jobId != null) {
        await tx.jobs.update({
          where: { id: refs.jobId },
          data: {
            status: 'CLOSED',
            closed_at: now,
            closed_reason: 'DEADLINE',
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
          metadata: {
            old_status: from,
            new_status: 'EXPIRED',
            closed_reason: 'DEADLINE',
            source_id: String(refs.sourceId),
            source_job_id: refs.sourceJobId,
            job_id: refs.jobId != null ? String(refs.jobId) : null,
          },
          now,
        },
        tx,
      );
    });
  }

  private formatAge(d: Date, now: Date): string {
    const ms = now.getTime() - new Date(d).getTime();
    const h = Math.max(0, Math.floor(ms / 3_600_000));
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d${h % 24}h`;
  }
}
