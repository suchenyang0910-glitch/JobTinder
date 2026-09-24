import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Optional } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { CrawlerOrchestrator, type CrawlRunStats } from './crawler-orchestrator.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { APP_ENV } from '@src/shared/env/app-env';
import type { OutboxStatus } from '@prisma/client';
import { CrawlerReviewNotifierService } from './crawler-review-notifier.service';
import { SourceDiscoveryService, type DiscoveredCompanyInput } from './source-discovery.service';

@Injectable()
export class CrawlerSchedulerService {
  private readonly logger = new Logger(CrawlerSchedulerService.name);
  private lastRunLock = false;
  private discoveryLock = false;
  private notifyLock = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: CrawlerOrchestrator,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() private readonly notifier?: CrawlerReviewNotifierService,
    @Optional() private readonly discovery?: SourceDiscoveryService,
  ) {}

  @Cron(APP_ENV.CRAWLER_CRON_EXPRESSION || '0 */15 * * * *', {
    name: 'crawler_sources_scan',
    disabled: !APP_ENV.CRAWLER_ENABLED,
  })
  async handleCron(): Promise<void> {
    if (!APP_ENV.CRAWLER_ENABLED) return;
    if (this.lastRunLock) {
      this.logger.warn('Previous crawler cron run still in progress, skipping tick.');
      return;
    }
    this.lastRunLock = true;
    try {
      await this.runAllDueSources();
    } catch (e) {
      this.logger.error(
        `Crawler cron failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
    } finally {
      this.lastRunLock = false;
    }
  }

  async runAllDueSources(): Promise<void> {
    const now = this.clock.now();
    const sources = await this.prisma.source_registry.findMany({
      where: {
        enabled: true,
        review_status: 'APPROVED',
      },
    });

    const due = sources.filter((s) => {
      if (s.last_crawled_at == null) return true;
      const intervalMs = Number(s.crawl_interval_minutes ?? 360) * 60_000;
      return Number(now) - Number(s.last_crawled_at) >= intervalMs;
    });

    for (const s of due) {
      await this.runSourceWithRunRecord(s.id);
    }
  }

  async runAllSources(): Promise<void> {
    const sources = await this.prisma.source_registry.findMany({
      where: { enabled: true, review_status: 'APPROVED' },
    });
    for (const s of sources) {
      await this.runSourceWithRunRecord(s.id);
    }
  }

  async runSourceWithRunRecord(sourceId: bigint): Promise<CrawlRunStats> {
    const now = this.clock.now();
    let stats: CrawlRunStats = {
      newCount: 0,
      changedCount: 0,
      closedCount: 0,
      translatedCount: 0,
      reviewRequiredCount: 0,
      errorCount: 0,
      lastError: null,
    };
    let finalStatus: OutboxStatus = 'SUCCEEDED';
    const runRow = await this.prisma.crawl_runs.create({
      data: { source_id: sourceId, started_at: now, status: 'PROCESSING' },
    });
    try {
      await this.audit.record({
        action: AuditActionEnum.CRAWL_RUN_STARTED,
        objectType: 'crawl_runs',
        objectId: runRow.id,
        metadata: { source_id: sourceId },
        now,
      });
      stats = await this.orchestrator.runSource(sourceId);
      await this.notifier?.notifyPendingJobs(sourceId);
      if (stats.errorCount > 0) finalStatus = 'FAILED';
    } catch (e) {
      stats.errorCount += 1;
      stats.lastError =
        e instanceof Error ? (e.stack ?? e.message).slice(0, 2048) : String(e).slice(0, 2048);
      finalStatus = 'FAILED';
    } finally {
      const finishedAt = this.clock.now();
      try {
        await this.prisma.crawl_runs.update({
          where: { id: runRow.id },
          data: {
            finished_at: finishedAt,
            status: finalStatus,
            new_count: stats.newCount,
            changed_count: stats.changedCount,
            closed_count: stats.closedCount,
            translated_count: stats.translatedCount,
            review_required_count: stats.reviewRequiredCount,
            error_count: stats.errorCount,
            last_error: stats.lastError,
          },
        });
        await this.audit.record({
          action: AuditActionEnum.CRAWL_RUN_FINISHED,
          objectType: 'crawl_runs',
          objectId: runRow.id,
          metadata: {
            source_id: sourceId,
            status: finalStatus,
            new_count: stats.newCount,
            changed_count: stats.changedCount,
            closed_count: stats.closedCount,
            translated_count: stats.translatedCount,
            review_required_count: stats.reviewRequiredCount,
            error_count: stats.errorCount,
          },
          now: finishedAt,
        });
      } catch (inner) {
        this.logger.error(
          `Failed to finalize crawl_runs row ${String(runRow.id)}: ${inner instanceof Error ? inner.message : String(inner)}`,
        );
      }
    }
    return stats;
  }

  @Cron(APP_ENV.CRAWLER_DISCOVERY_CRON || '0 0 8 * * *', {
    name: 'crawler_source_discovery',
    disabled: !APP_ENV.CRAWLER_ENABLED,
  })
  async handleDiscoveryCron(): Promise<void> {
    if (!APP_ENV.CRAWLER_ENABLED || !this.discovery) return;
    if (this.discoveryLock) {
      this.logger.warn('Discovery cron still in progress, skipping tick.');
      return;
    }
    this.discoveryLock = true;
    try {
      const cands = this.builtinDirectoryFeed();
      const r = await this.discovery.discoverFromCandidates(cands, {
        actorId: null,
        validateLive: false,
      });
      this.logger.log(
        `Discovery cron: discovered=${r.discovered.length} duplicates=${r.duplicates} validationErrors=${r.validationErrors} notified=${r.notified}`,
      );
    } catch (e) {
      this.logger.error(
        `Discovery cron failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
    } finally {
      this.discoveryLock = false;
    }
  }

  async discoverDirectoryFeed(
    validateLive = false,
  ): Promise<ReturnType<SourceDiscoveryService['discoverFromCandidates']>> {
    if (!this.discovery) throw new Error('SourceDiscoveryService unavailable');
    return this.discovery.discoverFromCandidates(this.builtinDirectoryFeed(), {
      actorId: null,
      validateLive,
    });
  }

  builtinDirectoryFeed(): DiscoveredCompanyInput[] {
    const rows: DiscoveredCompanyInput[] = [
      {
        name: 'Cambodia Chamber of Commerce Members Feed',
        base_url: 'https://www.ccdkh.org.kh',
        jobs_url: 'https://www.ccdkh.org.kh/members',
        discovery_method: 'cambodia_chamber_directory',
        source_type: 'CHAMBER_DIRECTORY' as const,
        city: 'Phnom Penh',
        industry: 'Chamber Services',
      },
      {
        name: 'CanCham Cambodia Business Directory',
        base_url: 'https://canchamcambodia.org',
        jobs_url: 'https://canchamcambodia.org/membership/directory',
        discovery_method: 'cancham_membership_directory',
        source_type: 'CHAMBER_DIRECTORY' as const,
        city: 'Phnom Penh',
        industry: 'Business Association',
      },
      {
        name: 'KhmerSME Enterprise Directory',
        base_url: 'https://khmersme.gov.kh',
        jobs_url: 'https://khmersme.gov.kh/directory',
        discovery_method: 'khmersme_enterprise_directory',
        source_type: 'CHAMBER_DIRECTORY' as const,
        city: 'Phnom Penh',
        industry: 'SME Registry',
      },
      {
        name: 'Sabay Cambodia Company Profiles',
        base_url: 'https://www.sabay.com.kh',
        jobs_url: 'https://www.sabay.com.kh/jobs',
        discovery_method: 'sabay_company_profiles',
        source_type: 'THIRD_PARTY_JOB_BOARD' as const,
        city: 'Phnom Penh',
        industry: 'Digital Media',
      },
    ];
    return rows;
  }

  @Cron(APP_ENV.CRAWLER_REVIEW_NOTIFY_CRON || '0 */20 * * * *', {
    name: 'crawler_review_notifications',
    disabled: !APP_ENV.CRAWLER_ENABLED,
  })
  async handleReviewNotifyCron(): Promise<void> {
    if (!APP_ENV.CRAWLER_ENABLED || !this.notifier) return;
    if (this.notifyLock) {
      this.logger.warn('Review notify cron still in progress, skipping tick.');
      return;
    }
    this.notifyLock = true;
    try {
      const jobs = await this.notifier.notifyPendingJobs();
      let sources = 0;
      const pendingSources = await this.prisma.source_registry.findMany({
        where: { review_status: 'PENDING', source_notified_at: null },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 10,
      });
      for (const s of pendingSources) {
        const ok = await this.notifier.notifySource(s.id);
        if (ok) {
          await this.prisma.source_registry.update({
            where: { id: s.id },
            data: { source_notified_at: new Date() },
          });
          sources++;
        }
      }
      this.logger.log(`Notify cron: jobs=${jobs} sources=${sources}`);
    } catch (e) {
      this.logger.error(
        `Notify cron failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
    } finally {
      this.notifyLock = false;
    }
  }
}
