import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { CrawlerOrchestrator, type CrawlRunStats } from './crawler-orchestrator.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { APP_ENV } from '@src/shared/env/app-env';
import type { OutboxStatus } from '@prisma/client';

@Injectable()
export class CrawlerSchedulerService {
  private readonly logger = new Logger(CrawlerSchedulerService.name);
  private lastRunLock = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: CrawlerOrchestrator,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
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
}
