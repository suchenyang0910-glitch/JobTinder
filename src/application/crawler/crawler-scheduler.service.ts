import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { CrawlerOrchestrator, type CrawlRunStats } from './crawler-orchestrator.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { APP_ENV } from '@src/shared/env/app-env';
import type { OutboxStatus } from '@prisma/client';
import { CrawlerReviewNotifierService } from './crawler-review-notifier.service';
import { SourceDiscoveryService, type DiscoveredCompanyInput } from './source-discovery.service';
import { OpsStatsService } from '@src/application/ops/ops-stats.service';
import {
  RemoteSourceSyncOrchestratorService,
  type RemoteSourceName,
} from '@src/application/remote/remote-source-sync-orchestrator.service';
import { RemoteJobNormalizeService } from '@src/application/remote/remote-job-normalize.service';
import { RemoteJobEligibilityService } from '@src/application/remote/remote-job-eligibility.service';
import { RemoteDailyDigestService } from '@src/application/remote/remote-daily-digest.service';
import type { NormalizedRemoteJob } from '@src/domain/remote/remote-entities';

@Injectable()
export class CrawlerSchedulerService {
  private readonly logger = new Logger(CrawlerSchedulerService.name);
  private lastRunLock = false;
  private discoveryLock = false;
  private notifyLock = false;
  private dailyReportLock = false;
  private remoteSourceSyncLock = false;
  private remoteNormalizeLock = false;
  private remoteEligibilityLock = false;
  private remoteDailyDigestLock = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: CrawlerOrchestrator,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() private readonly notifier?: CrawlerReviewNotifierService,
    @Optional() private readonly discovery?: SourceDiscoveryService,
    @Optional() private readonly opsStats?: OpsStatsService,
    @Optional() private readonly remoteSync?: RemoteSourceSyncOrchestratorService,
    @Optional() private readonly remoteNormalizeSvc?: RemoteJobNormalizeService,
    @Optional() private readonly remoteEligibilitySvc?: RemoteJobEligibilityService,
    @Optional() private readonly remoteDigestSvc?: RemoteDailyDigestService,
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

  @Cron(APP_ENV.PILOT_DAILY_REPORT_CRON || '0 0 9 * * *', {
    name: 'pilot_daily_report',
  })
  async handleDailyPilotReport(): Promise<{ pushed: boolean }> {
    if (!this.notifier || !this.opsStats) return { pushed: false };
    if (this.dailyReportLock) {
      this.logger.warn('Daily pilot report still in progress, skip.');
      return { pushed: false };
    }
    this.dailyReportLock = true;
    try {
      const stats = await this.opsStats.getOpsStats();
      const text = this.opsStats.formatTelegram(stats);
      const ok = await this.notifier.notifyAdminGeneric({
        headline: `🗓️ 14 天试点日报 — ${this.today(stats.generatedAt)}`,
        lines: [],
        footer: text,
      });
      this.logger.log(`Daily pilot report: pushed=${ok}`);
      return { pushed: ok };
    } catch (e) {
      this.logger.error(
        `Daily pilot report failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      return { pushed: false };
    } finally {
      this.dailyReportLock = false;
    }
  }

  private today(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  @Cron(APP_ENV.REMOTE_SOURCE_SYNC_CRON || '0 0 */6 * * *', {
    name: 'remote_source_sync',
    disabled: !APP_ENV.CRAWLER_ENABLED,
  })
  async handleRemoteSourceSyncCron(): Promise<{ ok: boolean; sources?: RemoteSourceName[] }> {
    if (!APP_ENV.CRAWLER_ENABLED || !this.remoteSync) return { ok: false };
    if (this.remoteSourceSyncLock) {
      this.logger.warn('Remote source sync cron still in progress, skip.');
      return { ok: false };
    }
    this.remoteSourceSyncLock = true;
    try {
      const sources: RemoteSourceName[] = ['remotive_api', 'remotive_rss', 'remote_ok_rss'];
      const report = await this.remoteSync.syncAll({ sources });
      this.logger.log(
        `Remote source sync: fetched=${report.totalRawFetched} dedupeAfter=${report.dedupe.totalAfterDedupe} created=${report.stagingCreated} updated=${report.stagingUpdated} confirmed=${report.eligibility.confirmed} needsConfirm=${report.eligibility.needsConfirm} notEligible=${report.eligibility.notEligible}`,
      );
      return { ok: true, sources };
    } catch (e) {
      this.logger.error(
        `Remote source sync failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      return { ok: false };
    } finally {
      this.remoteSourceSyncLock = false;
    }
  }

  @Cron(APP_ENV.REMOTE_NORMALIZE_CRON || '0 30 */6 * * *', {
    name: 'remote_normalize',
    disabled: !APP_ENV.CRAWLER_ENABLED,
  })
  async handleRemoteNormalizeCron(): Promise<{ ok: boolean; processed?: number }> {
    if (!APP_ENV.CRAWLER_ENABLED || !this.remoteSync || !this.remoteNormalizeSvc)
      return { ok: false };
    if (this.remoteNormalizeLock) {
      this.logger.warn('Remote normalize cron still in progress, skip.');
      return { ok: false };
    }
    this.remoteNormalizeLock = true;
    try {
      const pending = await this.prisma.crawl_jobs_staging.findMany({
        where: {
          work_mode: 'REMOTE',
          OR: [{ remote_scope: null }, { qa_flags: { hasSome: ['TITLE_MISSING', 'NO_SKILLS'] } }],
        },
        take: 500,
        select: { id: true, parsed_json: true, qa_flags: true },
      });
      let processed = 0;
      for (const row of pending) {
        try {
          const parsed = row.parsed_json as unknown as NormalizedRemoteJob | null;
          if (parsed?.raw) {
            const reNorm = this.remoteNormalizeSvc.normalize(parsed.raw);
            await this.prisma.crawl_jobs_staging.update({
              where: { id: row.id },
              data: {
                remote_scope: reNorm.remoteScope ?? undefined,
                eligible_countries: reNorm.eligibleCountries,
                work_authorization: reNorm.workAuthorization,
                employment_type: reNorm.employmentType ?? undefined,
                updated_at: new Date(),
              },
            });
            processed++;
          }
        } catch {
          /* row errors never break batch */
        }
      }
      this.logger.log(`Remote normalize: processed=${processed} of ${pending.length}`);
      await this.audit
        .record({
          action: AuditActionEnum.REMOTE_JOB_NORMALIZED,
          objectType: 'crawl_jobs_staging',
          metadata: { batch_size: String(pending.length), processed: String(processed) },
          now: this.clock.now(),
        })
        .catch(() => undefined);
      return { ok: true, processed };
    } catch (e) {
      this.logger.error(
        `Remote normalize failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      return { ok: false };
    } finally {
      this.remoteNormalizeLock = false;
    }
  }

  @Cron(APP_ENV.REMOTE_ELIGIBILITY_CRON || '0 0 7 * * *', {
    name: 'remote_eligibility',
    disabled: !APP_ENV.CRAWLER_ENABLED,
  })
  async handleRemoteEligibilityCron(): Promise<{
    ok: boolean;
    confirmed?: number;
    needsConfirm?: number;
    notEligible?: number;
  }> {
    if (!APP_ENV.CRAWLER_ENABLED || !this.remoteEligibilitySvc) return { ok: false };
    if (this.remoteEligibilityLock) {
      this.logger.warn('Remote eligibility cron still in progress, skip.');
      return { ok: false };
    }
    this.remoteEligibilityLock = true;
    try {
      const pending = await this.prisma.crawl_jobs_staging.findMany({
        where: {
          work_mode: 'REMOTE',
          eligibility_status: { notIn: ['CONFIRMED'] },
        },
        take: 500,
        select: { id: true, parsed_json: true, eligibility_status: true },
      });
      let confirmed = 0;
      let needsConfirm = 0;
      let notEligible = 0;
      for (const row of pending) {
        try {
          const parsed = row.parsed_json as unknown as NormalizedRemoteJob | null;
          if (!parsed?.raw) continue;
          const result = this.remoteEligibilitySvc.evaluateSyncNoUrl(parsed, {
            userTimezone: 'Asia/Phnom_Penh',
            overlapMinHours: 2,
          });
          const qaFlags: string[] = [];
          if (result.status === 'NOT_ELIGIBLE') qaFlags.push('ELIGIBILITY_NOT_ELIGIBLE');
          else if (result.status === 'NEEDS_CONFIRMATION')
            qaFlags.push('ELIGIBILITY_NEEDS_CONFIRM');
          await this.prisma.crawl_jobs_staging.update({
            where: { id: row.id },
            data: {
              eligibility_status: result.status,
              qa_flags: qaFlags.length ? qaFlags : undefined,
              updated_at: new Date(),
            },
          });
          if (result.status === 'CONFIRMED') confirmed++;
          else if (result.status === 'NEEDS_CONFIRMATION') needsConfirm++;
          else notEligible++;
        } catch {
          /* row errors never break batch */
        }
      }
      this.logger.log(
        `Remote eligibility: confirmed=${confirmed} needsConfirm=${needsConfirm} notEligible=${notEligible} (pool=${pending.length})`,
      );
      await this.audit
        .record({
          action: AuditActionEnum.REMOTE_ELIGIBILITY_CHECKED,
          objectType: 'crawl_jobs_staging',
          metadata: {
            confirmed: String(confirmed),
            needs_confirm: String(needsConfirm),
            not_eligible: String(notEligible),
            pool: String(pending.length),
          },
          now: this.clock.now(),
        })
        .catch(() => undefined);
      return { ok: true, confirmed, needsConfirm, notEligible };
    } catch (e) {
      this.logger.error(
        `Remote eligibility failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      return { ok: false };
    } finally {
      this.remoteEligibilityLock = false;
    }
  }

  @Cron(APP_ENV.REMOTE_DAILY_DIGEST_CRON || '0 0 9 * * *', {
    name: 'remote_daily_digest',
  })
  async handleRemoteDailyDigestCron(): Promise<{
    ok: boolean;
    processedCandidates?: number;
    sentCandidates?: number;
    skippedEmpty?: number;
    totalJobsSent?: number;
  }> {
    if (!this.remoteDigestSvc) return { ok: false };
    if (this.remoteDailyDigestLock) {
      this.logger.warn('Remote daily digest cron still in progress, skip.');
      return { ok: false };
    }
    this.remoteDailyDigestLock = true;
    try {
      const r = await this.remoteDigestSvc.runDailyDigest({ candidateLimit: 1000 });
      this.logger.log(
        `Remote daily digest: processed=${r.processedCandidates} sent=${r.sentCandidates} skippedEmpty=${r.skippedEmpty} totalJobs=${r.totalJobsSent}`,
      );
      return { ok: true, ...r };
    } catch (e) {
      this.logger.error(
        `Remote daily digest failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      return { ok: false };
    } finally {
      this.remoteDailyDigestLock = false;
    }
  }
}
