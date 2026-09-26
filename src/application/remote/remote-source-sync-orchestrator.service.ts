import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import type {
  CrawlJobStatus,
  CrawlQAStatus,
  CrawlTranslationStatus,
  SourceParserType,
} from '@prisma/client';
import { fetchRemotiveApiJobs } from '@src/infrastructure/remote/remotive-api.adapter';
import {
  fetchRemotiveRssJobs,
  fetchRemoteOkRssJobs,
  fetchWeWorkRemotelyRssJobs,
  fetchJobicyRssJobs,
} from '@src/infrastructure/remote/rss-feeds.adapter';
import {
  dedupeNormalizedRemoteJobs,
  normalizeRemoteJob,
  type DedupeResult,
} from '@src/application/remote/remote-job-normalize.service';
import {
  evaluateEligibilitySyncNoUrl,
  type EligibilityCheckResult,
} from '@src/application/remote/remote-job-eligibility.service';
import type {
  NormalizedRemoteJob,
  RemoteRawJob,
  RemoteSourcePlatform,
} from '@src/domain/remote/remote-entities';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { CLOCK_TOKEN, type Clock } from '@src/shared/clock/clock';
import { APP_ENV } from '@src/shared/env/app-env';
import { Inject } from '@nestjs/common';
import { createHash } from 'node:crypto';

export type RemoteSourceName =
  | 'remotive_api'
  | 'remotive_rss'
  | 'remote_ok_rss'
  | 'we_work_remotely_rss'
  | 'jobicy_rss';

const SOURCE_META: Record<
  RemoteSourceName,
  {
    baseUrl: string;
    jobsUrl: string;
    sourceType: string;
    parserType: SourceParserType;
    platform: RemoteSourcePlatform;
    defaultEnabled: boolean;
  }
> = {
  remotive_api: {
    baseUrl: 'https://remotive.com',
    jobsUrl: 'https://remotive.com/api/remote-jobs',
    sourceType: 'THIRD_PARTY_JOB_BOARD',
    parserType: 'API',
    platform: 'REMOTIVE',
    defaultEnabled: true,
  },
  remotive_rss: {
    baseUrl: 'https://remotive.com',
    jobsUrl: 'https://remotive.com/remote-jobs/feed',
    sourceType: 'THIRD_PARTY_JOB_BOARD',
    parserType: 'RSS',
    platform: 'REMOTIVE',
    defaultEnabled: true,
  },
  remote_ok_rss: {
    baseUrl: 'https://remoteok.com',
    jobsUrl: 'https://remoteok.com/remote-jobs.rss',
    sourceType: 'THIRD_PARTY_JOB_BOARD',
    parserType: 'RSS',
    platform: 'REMOTE_OK',
    defaultEnabled: true,
  },
  we_work_remotely_rss: {
    baseUrl: 'https://weworkremotely.com',
    jobsUrl: 'https://weworkremotely.com/remote-jobs.rss',
    sourceType: 'THIRD_PARTY_JOB_BOARD',
    parserType: 'RSS',
    platform: 'WE_WORK_REMOTELY',
    defaultEnabled: true,
  },
  jobicy_rss: {
    baseUrl: 'https://jobicy.com',
    jobsUrl: 'https://jobicy.com/jobs/feed',
    sourceType: 'THIRD_PARTY_JOB_BOARD',
    parserType: 'RSS',
    platform: 'JOBICY',
    defaultEnabled: true,
  },
};

export interface RemoteSourceFetchResult {
  source: RemoteSourceName;
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number;
  rawFetched: number;
}

export interface RemoteSyncReport {
  startedAt: Date;
  finishedAt: Date;
  sources: RemoteSourceFetchResult[];
  totalRawFetched: number;
  dedupe: DedupeResult & { totalAfterDedupe: number };
  stagingCreated: number;
  stagingUpdated: number;
  eligibility: { confirmed: number; needsConfirm: number; notEligible: number };
  qaFlagsPerJob: Record<string, string[]>;
}

@Injectable()
export class RemoteSourceSyncOrchestratorService {
  private readonly logger = new Logger(RemoteSourceSyncOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() private readonly actorId: bigint | number | undefined = undefined,
  ) {}

  async syncAll(opts?: {
    sources?: RemoteSourceName[];
    limitPerSource?: number;
    dryRun?: boolean;
  }): Promise<RemoteSyncReport> {
    const sources =
      opts?.sources ??
      (['remotive_api', 'remotive_rss', 'remote_ok_rss', 'we_work_remotely_rss', 'jobicy_rss'] as RemoteSourceName[]);
    const startedAt = this.clock.now();
    const allRaw: RemoteRawJob[] = [];
    const fetchResults: RemoteSourceFetchResult[] = [];

    for (const name of sources) {
      const res = await this.fetchSource(name, {
        limitPerSource: opts?.limitPerSource,
      });
      fetchResults.push(res.result);
      allRaw.push(...res.jobs);
    }

    const normalized = allRaw.map(normalizeRemoteJob);
    const dedupe = dedupeNormalizedRemoteJobs(normalized);
    const totalAfterDedupe = dedupe.kept.length;

    let stagingCreated = 0;
    let stagingUpdated = 0;
    const eligibilityCounts = { confirmed: 0, needsConfirm: 0, notEligible: 0 };
    const qaFlagsPerJob: Record<string, string[]> = {};

    if (!opts?.dryRun) {
      await this.ensureSourceRegistryEntries(sources);
      for (const job of dedupe.kept) {
        const r = await this.upsertStagingFromNormalized(job);
        if (r.created) stagingCreated++;
        else stagingUpdated++;
        const e = r.eligibility;
        if (e.status === 'CONFIRMED') eligibilityCounts.confirmed++;
        else if (e.status === 'NEEDS_CONFIRMATION') eligibilityCounts.needsConfirm++;
        else eligibilityCounts.notEligible++;
        qaFlagsPerJob[job.idempotencyPlatformJobKey] = r.qaFlags;
      }
      try {
        await this.audit.record({
          actorId: this.actorId ?? undefined,
          action: AuditActionEnum.REMOTE_SOURCE_SYNCED,
          objectType: 'remote_source_sync',
          objectId: undefined,
          version: undefined,
          metadata: {
            sources,
            totalRawFetched: allRaw.length,
            afterDedupe: totalAfterDedupe,
            stagingCreated,
            stagingUpdated,
            eligibilityCounts,
          },
          now: this.clock.now(),
        });
      } catch {
        /* audit never breaks sync */
      }
    }

    const finishedAt = this.clock.now();
    return {
      startedAt,
      finishedAt,
      sources: fetchResults,
      totalRawFetched: allRaw.length,
      dedupe: { ...dedupe, totalAfterDedupe },
      stagingCreated,
      stagingUpdated,
      eligibility: eligibilityCounts,
      qaFlagsPerJob,
    };
  }

  private async fetchSource(
    name: RemoteSourceName,
    opts?: { limitPerSource?: number },
  ): Promise<{ result: RemoteSourceFetchResult; jobs: RemoteRawJob[] }> {
    try {
      if (name === 'remotive_api') {
        const r = await fetchRemotiveApiJobs({
          baseUrl: process.env.REMOTIVE_API_BASE_URL || undefined,
          limit: opts?.limitPerSource,
          timeoutMs: Number(APP_ENV.CRAWLER_REQUEST_TIMEOUT_MS) || undefined,
        });
        return {
          result: {
            source: name,
            ok: r.ok,
            errorCode: r.errorCode,
            errorMessage: r.errorMessage,
            httpStatus: r.httpStatus,
            rawFetched: r.jobs.length,
          },
          jobs: r.jobs,
        };
      }
      if (name === 'remotive_rss') {
        const r = await fetchRemotiveRssJobs({
          feedUrl: process.env.REMOTIVE_RSS_URL || undefined,
          timeoutMs: Number(APP_ENV.CRAWLER_REQUEST_TIMEOUT_MS) || undefined,
        });
        return {
          result: {
            source: name,
            ok: r.ok,
            errorCode: r.errorCode,
            errorMessage: r.errorMessage,
            httpStatus: r.httpStatus,
            rawFetched: r.jobs.length,
          },
          jobs: r.jobs,
        };
      }
      if (name === 'we_work_remotely_rss' || name === 'jobicy_rss') {
        const r =
          name === 'we_work_remotely_rss'
            ? await fetchWeWorkRemotelyRssJobs({
                feedUrl: process.env.WWR_RSS_URL || undefined,
                timeoutMs: Number(APP_ENV.CRAWLER_REQUEST_TIMEOUT_MS) || undefined,
              })
            : await fetchJobicyRssJobs({
                feedUrl: process.env.JOBICY_RSS_URL || undefined,
                timeoutMs: Number(APP_ENV.CRAWLER_REQUEST_TIMEOUT_MS) || undefined,
              });
        return {
          result: {
            source: name,
            ok: r.ok,
            errorCode: r.errorCode,
            errorMessage: r.errorMessage,
            httpStatus: r.httpStatus,
            rawFetched: r.jobs.length,
          },
          jobs: r.jobs,
        };
      }
      // remote_ok_rss
      const r = await fetchRemoteOkRssJobs({
        feedUrl: process.env.REMOTE_OK_RSS_URL || undefined,
        timeoutMs: Number(APP_ENV.CRAWLER_REQUEST_TIMEOUT_MS) || undefined,
      });
      return {
        result: {
          source: name,
          ok: r.ok,
          errorCode: r.errorCode,
          errorMessage: r.errorMessage,
          httpStatus: r.httpStatus,
          rawFetched: r.jobs.length,
        },
        jobs: r.jobs,
      };
    } catch (err: any) {
      return {
        result: {
          source: name,
          ok: false,
          errorCode: (err && err.code) || 'UNEXPECTED_ERROR',
          errorMessage: (err && err.message) || String(err),
          httpStatus: 0,
          rawFetched: 0,
        },
        jobs: [],
      };
    }
  }

  async ensureSourceRegistryEntries(sources: RemoteSourceName[]): Promise<void> {
    for (const name of sources) {
      const meta = SOURCE_META[name];
      await this.prisma.source_registry.upsert({
        where: {
          source_base_jobs_url_uq: { base_url: meta.baseUrl, jobs_url: meta.jobsUrl },
        },
        create: {
          name: `Remote Feed: ${name}`,
          base_url: meta.baseUrl,
          jobs_url: meta.jobsUrl,
          source_type: meta.sourceType,
          parser_type: meta.parserType,
          enabled: meta.defaultEnabled,
          crawl_interval_minutes: 360,
          review_status: 'APPROVED',
          discovery_method: 'remote_feed_preconfigured',
          robots_status: 'UNCHECKED',
        },
        update: {
          parser_type: meta.parserType,
        },
      });
    }
  }

  private async upsertStagingFromNormalized(job: NormalizedRemoteJob): Promise<{
    stagingId: bigint;
    created: boolean;
    eligibility: EligibilityCheckResult;
    qaFlags: string[];
  }> {
    const eligibility = evaluateEligibilitySyncNoUrl(job, {
      userTimezone: 'Asia/Phnom_Penh',
      overlapMinHours: 2,
    });
    const qaFlags: string[] = [];
    if (eligibility.status === 'NOT_ELIGIBLE') qaFlags.push('ELIGIBILITY_NOT_ELIGIBLE');
    else if (eligibility.status === 'NEEDS_CONFIRMATION') qaFlags.push('ELIGIBILITY_NEEDS_CONFIRM');
    if (!job.title) qaFlags.push('TITLE_MISSING');
    if (!job.applicationUrl) qaFlags.push('APPLICATION_URL_MISSING');
    if (job.raw.tags.length === 0 && job.skills.length === 0) qaFlags.push('NO_SKILLS');
    if (
      eligibility.dimensions.find(
        (d) => d.key === 'application_url_accessible' && d.result === 'FAIL',
      )
    ) {
      qaFlags.push('APPLICATION_URL_FAIL');
    }
    const meta = SOURCE_META_BY_PLATFORM(job);
    const sourceReg = await this.prisma.source_registry.upsert({
      where: {
        source_base_jobs_url_uq: { base_url: meta.baseUrl, jobs_url: meta.jobsUrl },
      },
      create: {
        name: `Remote Feed: ${job.sourcePlatform} (on-demand)`,
        base_url: meta.baseUrl,
        jobs_url: meta.jobsUrl,
        source_type: meta.sourceType,
        parser_type: meta.parserType,
        enabled: true,
        crawl_interval_minutes: 360,
        review_status: 'APPROVED',
        discovery_method: 'remote_feed_upsert',
        robots_status: 'UNCHECKED',
      },
      update: {},
    });

    const snapshotContent = JSON.stringify(job.raw.rawPayload ?? {});
    const contentHash = sha1Hex(snapshotContent);

    let snapshot = await this.prisma.crawl_snapshots.findFirst({
      where: { source_id: sourceReg.id, content_hash: contentHash },
    });
    if (!snapshot) {
      snapshot = await this.prisma.crawl_snapshots.create({
        data: {
          source_id: sourceReg.id,
          url: job.raw.sourceUrl,
          content_hash: contentHash,
          raw_content: Buffer.from(snapshotContent, 'utf8'),
          content_type:
            job.raw.sourceParserType === 'RSS' ? 'application/rss+json' : 'application/json',
          http_status: 200,
          fetched_at: job.raw.fetchedAt,
          parser_version: `remote:${job.raw.sourceParserType}:1.0`,
        },
      });
    } else {
      snapshot = await this.prisma.crawl_snapshots.update({
        where: { id: snapshot.id },
        data: { fetched_at: job.raw.fetchedAt },
      });
    }

    const parseVersion = `remote:${job.raw.sourceParserType}:1.0`;
    const initialStatus: CrawlJobStatus = qaFlags.includes('ELIGIBILITY_NOT_ELIGIBLE')
      ? 'DEFERRED'
      : 'QA_PENDING';
    const translationStatus: CrawlTranslationStatus = 'NOT_STARTED';
    const qaStatus: CrawlQAStatus = qaFlags.length > 0 ? 'REVIEW_REQUIRED' : 'NOT_RUN';
    const existing = await this.prisma.crawl_jobs_staging.findFirst({
      where: {
        source_id: sourceReg.id,
        source_job_id: job.raw.sourceJobId,
        parse_version: parseVersion,
      },
    });

    const common = {
      snapshot_id: snapshot.id,
      source_url: job.raw.sourceUrl,
      status: existing ? existing.status : initialStatus,
      detected_language: 'en',
      title_source: job.title,
      tasks_source: job.tasks.length > 0 ? job.tasks.join('\n') : null,
      skills_source: job.skills.length > 0 ? job.skills.join(', ') : null,
      industry_source: job.industry,
      locations_source: job.locations.length > 0 ? job.locations.join(', ') : null,
      salary_source: job.salaryText,
      shift_source: null as string | null,
      benefits_source: null as string | null,
      parsed_json: job as unknown as object,
      translation_status: translationStatus,
      qa_status: existing ? existing.qa_status : qaStatus,
      review_status: existing ? existing.review_status : ('NOT_RUN' as CrawlQAStatus),
      parse_version: parseVersion,
      qa_flags: qaFlags,
      work_mode: 'REMOTE' as const,
      remote_scope: job.remoteScope,
      eligible_countries: job.eligibleCountries,
      employer_country: job.employerCountry,
      timezone_required: job.timezoneRequired,
      timezone_overlap_hours: job.timezoneOverlapHours,
      work_authorization: job.workAuthorization,
      employment_type: job.employmentType,
      payment_method: job.paymentMethod,
      salary_currency: job.salaryCurrency,
      application_url: job.applicationUrl,
      source_platform: job.sourcePlatform,
      source_last_seen_at: job.sourceLastSeenAt,
      eligibility_status: eligibility.status,
      expiry_date: job.originalDeadlineAt,
      last_confirmed_at: job.originalPublishedAt,
    };

    if (existing) {
      const updated = await this.prisma.crawl_jobs_staging.update({
        where: { id: existing.id },
        data: { ...common, updated_at: new Date() },
      });
      return {
        stagingId: updated.id,
        created: false,
        eligibility,
        qaFlags,
      };
    }

    const created = await this.prisma.crawl_jobs_staging.create({
      data: {
        ...common,
        source_id: sourceReg.id,
        source_job_id: job.raw.sourceJobId,
        created_at: job.raw.fetchedAt,
      },
    });
    return {
      stagingId: created.id,
      created: true,
      eligibility,
      qaFlags,
    };
  }
}

function sha1Hex(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function SOURCE_META_BY_PLATFORM(job: NormalizedRemoteJob): {
  baseUrl: string;
  jobsUrl: string;
  sourceType: string;
  parserType: SourceParserType;
} {
  const p = job.sourcePlatform;
  const parser: SourceParserType = job.raw.sourceParserType;
  if (p === 'REMOTIVE') {
    return {
      baseUrl: 'https://remotive.com',
      jobsUrl:
        parser === 'API'
          ? 'https://remotive.com/api/remote-jobs'
          : 'https://remotive.com/remote-jobs/feed',
      sourceType: 'THIRD_PARTY_JOB_BOARD',
      parserType: parser,
    };
  }
  if (p === 'WE_WORK_REMOTELY') {
    return {
      baseUrl: 'https://weworkremotely.com',
      jobsUrl: 'https://weworkremotely.com/remote-jobs.rss',
      sourceType: 'THIRD_PARTY_JOB_BOARD',
      parserType: parser,
    };
  }
  if (p === 'JOBICY') {
    return {
      baseUrl: 'https://jobicy.com',
      jobsUrl: 'https://jobicy.com/jobs/feed',
      sourceType: 'THIRD_PARTY_JOB_BOARD',
      parserType: parser,
    };
  }
  return {
    baseUrl: 'https://remoteok.com',
    jobsUrl: 'https://remoteok.com/remote-jobs.rss',
    sourceType: 'THIRD_PARTY_JOB_BOARD',
    parserType: parser,
  };
}
