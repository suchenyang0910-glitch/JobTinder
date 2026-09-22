import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, CrawlQAStatus, CrawlJobStatus, CrawlTranslationStatus } from '@prisma/client';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import {
  assertCrawlJobTransition,
  type CrawlJobStatusValue,
} from '@src/domain/crawler/crawl-job-status-machine';
import type { DetectedLanguage, ParsedStagingJobFields } from '@src/domain/crawler/crawl-entities';
import {
  StaticHttpCrawler,
  PARSER_VERSION,
  USER_AGENT,
  type FetchResult,
} from '@src/infrastructure/crawler/static-http-crawler';
import { CrawlerTranslationService } from '@src/infrastructure/ai/crawler-translation.service';
import {
  CrawlerQAService,
  type QAStagingInput,
  type QATranslationInput,
} from './crawler-qa.service';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import type { AILanguage } from '@src/domain/trust/ai-extract-provider';
import { AIExtractProvider, AI_PROVIDER_TOKEN } from '@src/domain/trust/ai-extract-provider';

const PARSE_VERSION = 'parse-1.0';

export interface CrawlRunStats {
  newCount: number;
  changedCount: number;
  closedCount: number;
  translatedCount: number;
  reviewRequiredCount: number;
  errorCount: number;
  lastError: string | null;
}

@Injectable()
export class CrawlerOrchestrator {
  private readonly logger = new Logger(CrawlerOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    private readonly crawler: StaticHttpCrawler,
    private readonly translation: CrawlerTranslationService,
    private readonly qa: CrawlerQAService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(AI_PROVIDER_TOKEN) private readonly aiProvider: AIExtractProvider,
  ) {}

  async runSource(sourceId: bigint): Promise<CrawlRunStats> {
    const stats: CrawlRunStats = {
      newCount: 0,
      changedCount: 0,
      closedCount: 0,
      translatedCount: 0,
      reviewRequiredCount: 0,
      errorCount: 0,
      lastError: null,
    };
    const now = this.clock.now();
    const source = await this.prisma.source_registry.findUnique({ where: { id: sourceId } });
    if (!source)
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_NOT_FOUND,
        message: `source ${String(sourceId)} not found`,
      });
    if (source.review_status !== 'APPROVED') {
      stats.lastError = `source review_status=${source.review_status}, must be APPROVED to run`;
      stats.errorCount = 1;
      return stats;
    }
    if (!source.enabled) return stats;
    if (source.parser_type !== 'STATIC_HTML') {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_PARSER_NOT_IMPLEMENTED,
        message: `parser_type ${source.parser_type} is not implemented in stage-1`,
      });
    }

    const robots = await this.crawler.checkRobots(source.base_url);
    if (!robots.allowed) {
      await this.prisma.source_registry.update({
        where: { id: sourceId },
        data: { robots_status: 'DISALLOWED', last_crawled_at: now },
      });
      stats.lastError = `robots.txt disallowed: ${robots.reason ?? ''}`;
      stats.errorCount = 1;
      await this.audit.record({
        action: AuditActionEnum.CRAWL_SOURCE_REGISTERED,
        objectType: 'source_registry',
        objectId: sourceId,
        metadata: { robots_status: 'DISALLOWED', reason: robots.reason },
        now,
      });
      return stats;
    }
    await this.prisma.source_registry.update({
      where: { id: sourceId },
      data: { robots_status: robots.allowed ? 'ALLOWED' : 'UNCHECKED', last_crawled_at: now },
    });

    const index = await this.crawler.fetchPage({
      sourceId,
      url: source.jobs_url,
      crawlDelayMs: robots.crawlDelayMs,
    });
    if (index.errorCode) {
      stats.errorCount++;
      stats.lastError = `index fetch ${index.errorCode}: ${index.errorMessage ?? ''}`;
      return stats;
    }
    const jobLinks = this.crawler.discoverJobLinks(index.body, source.base_url);
    const existingSourceJobIds = new Set(
      (
        await this.prisma.crawl_jobs_staging.findMany({
          where: { source_id: sourceId },
          select: { source_job_id: true },
        })
      ).map((r) => r.source_job_id),
    );
    const seenSourceJobIdsThisRun = new Set<string>();

    for (const url of jobLinks.slice(0, 50)) {
      try {
        const sourceJobId = this.inferSourceJobId(url, source.base_url);
        seenSourceJobIdsThisRun.add(sourceJobId);
        const result = await this.crawler.fetchPage({
          sourceId,
          url,
          crawlDelayMs: robots.crawlDelayMs,
        });
        const snapshot = await this.persistSnapshot(sourceId, result);
        if (result.errorCode) {
          if (result.httpStatus === 404 || result.httpStatus === 410) {
            if (existingSourceJobIds.has(sourceJobId)) {
              await this.markStaleBySourceJobId(sourceId, sourceJobId);
              stats.closedCount++;
            }
          }
          stats.errorCount++;
          continue;
        }
        const isChanged =
          !(await this.prisma.crawl_snapshots.findUnique({
            where: {
              source_id_content_hash: { source_id: sourceId, content_hash: result.contentHash },
            },
          })) || !existingSourceJobIds.has(sourceJobId);
        const parsed = await this.parseTextToStagingFields(
          this.crawler.extractTextFromHtml(result.body),
          result.url,
        );
        let staging = await this.upsertStagingRow({
          sourceId,
          sourceJobId,
          snapshotId: snapshot.id,
          url,
          fetchResult: result,
          parsed,
          existingSourceJobIds,
        });
        if (staging.status === 'DISCOVERED') {
          staging = await this.transitionStatus(staging.id, 'FETCHED', null);
          staging = await this.transitionStatus(staging.id, 'PARSED', null);
          stats.newCount++;
          await this.audit.record({
            action: AuditActionEnum.CRAWL_JOB_PARSED,
            objectType: 'crawl_jobs_staging',
            objectId: staging.id,
            metadata: {
              source_id: sourceId,
              source_job_id: sourceJobId,
              parser_type: String(source.parser_type),
              parser_version: PARSE_VERSION,
            },
            now,
          });
        } else if (isChanged) {
          stats.changedCount++;
        }
        if (staging.status === 'PARSED') {
          try {
            const translated = await this.translateStaging(staging.id);
            staging = translated.row;
            stats.translatedCount += translated.added;
          } catch (e) {
            stats.errorCount++;
            staging = await this.transitionStatus(staging.id, 'REVIEW_REQUIRED', null);
            await this.prisma.crawl_jobs_staging.update({
              where: { id: staging.id },
              data: { qa_status: 'REVIEW_REQUIRED' },
            });
          }
        }
        if (staging.status === 'TRANSLATED') {
          const qa = await this.runQAForStaging(staging.id);
          staging = qa.row;
          if (qa.requiresReview) {
            stats.reviewRequiredCount++;
          }
        }
      } catch (e) {
        stats.errorCount++;
        stats.lastError = e instanceof Error ? e.message : String(e);
      }
    }

    // Missing in this run → mark STALE if was FETCHED/PARSED/TRANSLATED previously (preserves REJECTED/APPROVED).
    for (const sid of existingSourceJobIds) {
      if (seenSourceJobIdsThisRun.has(sid)) continue;
      try {
        const updated = await this.prisma.crawl_jobs_staging.updateMany({
          where: {
            source_id: sourceId,
            source_job_id: sid,
            status: { in: ['FETCHED', 'PARSED', 'TRANSLATED', 'QA_PENDING'] },
          },
          data: { status: 'STALE', updated_at: now },
        });
        if (updated.count > 0) {
          stats.closedCount++;
          const row = await this.prisma.crawl_jobs_staging.findFirst({
            where: { source_id: sourceId, source_job_id: sid },
          });
          if (row)
            await this.audit.record({
              action: AuditActionEnum.CRAWL_JOB_MARKED_STALE,
              objectType: 'crawl_jobs_staging',
              objectId: row.id,
              metadata: { source_id: sourceId, source_job_id: sid },
              now,
            });
        }
      } catch {
        // ignore
      }
    }

    await this.prisma.source_registry.update({
      where: { id: sourceId },
      data: { last_success_at: now },
    });
    return stats;
  }

  private async persistSnapshot(sourceId: bigint, r: FetchResult) {
    try {
      return await this.prisma.crawl_snapshots.create({
        data: {
          source_id: sourceId,
          url: r.url,
          http_status: r.httpStatus || null,
          content_hash: r.contentHash,
          raw_content: r.body ? Buffer.from(r.body.slice(0, 1_000_000), 'utf8') : null,
          content_type: r.contentType,
          fetched_at: r.fetchedAt,
          parser_version: PARSER_VERSION,
          error_code: r.errorCode,
          error_message: r.errorMessage,
        },
      });
    } catch (e) {
      const dup = await this.prisma.crawl_snapshots.findUnique({
        where: { source_id_content_hash: { source_id: sourceId, content_hash: r.contentHash } },
      });
      if (dup) return dup;
      throw e;
    }
  }

  private inferSourceJobId(url: string, baseUrl: string): string {
    try {
      const u = new URL(url, baseUrl);
      const path = u.pathname.replace(/\/+/g, '/');
      if (path.length > 4) return `${u.host}${path}`.slice(0, 256);
      return `${u.host}|${u.searchParams.toString()}`.slice(0, 256);
    } catch {
      return url.slice(0, 256);
    }
  }

  private async parseTextToStagingFields(
    cleanText: string,
    _url: string,
  ): Promise<{
    fields: ParsedStagingJobFields;
    rawJson: Prisma.InputJsonValue;
    detected: DetectedLanguage;
  }> {
    const empty: ParsedStagingJobFields = {
      title: null,
      tasks: [],
      skills: [],
      industry: null,
      locations: [],
      salaryText: null,
      shifts: [],
      benefits: [],
      headcount: null,
      workPermitRequired: null,
      availability: null,
      applyMethod: null,
    };
    const detected = this.translation.detectLanguage(cleanText);
    const detectedAILang: AILanguage = detected === 'unknown' ? 'en' : detected;
    const firstLine = cleanText.split(/\n/)[0]?.trim();
    const heuristicTitle =
      firstLine && firstLine.length >= 2 && firstLine.length <= 120 ? firstLine : null;
    try {
      const extracted = await this.aiProvider.extractJobDraft(
        cleanText.slice(0, 8000),
        detectedAILang,
      );
      const f: ParsedStagingJobFields = {
        title: extracted.fields.title ?? heuristicTitle,
        tasks: extracted.fields.tasks,
        skills: extracted.fields.skills,
        industry: extracted.fields.industry,
        locations: extracted.fields.locations,
        salaryText: extracted.fields.salaryText,
        shifts: extracted.fields.shifts,
        benefits: [
          extracted.fields.housingProvided ? 'housing' : null,
          extracted.fields.mealsProvided ? 'meals' : null,
          extracted.fields.transportProvided ? 'transport' : null,
        ].filter(Boolean) as string[],
        headcount: extracted.fields.headcount,
        workPermitRequired: extracted.fields.workPermitRequired,
        availability: extracted.fields.availabilityStart,
        applyMethod: null,
      };
      return { fields: f, rawJson: extracted as unknown as Prisma.InputJsonValue, detected };
    } catch (e) {
      this.logger.warn(`heuristic-only parse: ${e instanceof Error ? e.message : String(e)}`);
      return {
        fields: { ...empty, title: heuristicTitle },
        rawJson: { heuristic: true },
        detected,
      };
    }
  }

  private async upsertStagingRow(params: {
    sourceId: bigint;
    sourceJobId: string;
    snapshotId: bigint;
    url: string;
    fetchResult: FetchResult;
    parsed: {
      fields: ParsedStagingJobFields;
      rawJson: Prisma.InputJsonValue;
      detected: DetectedLanguage;
    };
    existingSourceJobIds: Set<string>;
  }) {
    const { sourceId, sourceJobId, snapshotId, url, fetchResult, parsed } = params;
    const tasksSource = parsed.fields.tasks.join('\n');
    const skillsSource = parsed.fields.skills.join(', ');
    const locationsSource = parsed.fields.locations.join(', ');
    const shiftSource = parsed.fields.shifts.join(', ');
    const benefitsSource = parsed.fields.benefits.join(', ');
    const totalChars =
      (parsed.fields.title?.length ?? 0) +
      tasksSource.length +
      skillsSource.length +
      locationsSource.length +
      (parsed.fields.industry?.length ?? 0) +
      (parsed.fields.salaryText?.length ?? 0) +
      shiftSource.length +
      benefitsSource.length +
      (parsed.fields.availability?.length ?? 0);
    if (params.existingSourceJobIds.has(sourceJobId)) {
      const existing = await this.prisma.crawl_jobs_staging.findFirst({
        where: { source_id: sourceId, source_job_id: sourceJobId, parse_version: PARSE_VERSION },
      });
      if (existing) {
        return this.prisma.crawl_jobs_staging.update({
          where: { id: existing.id },
          data: {
            snapshot_id: snapshotId,
            source_url: url,
            detected_language: parsed.detected,
            title_source: parsed.fields.title,
            tasks_source: tasksSource || null,
            skills_source: skillsSource || null,
            industry_source: parsed.fields.industry,
            locations_source: locationsSource || null,
            salary_source: parsed.fields.salaryText,
            shift_source: shiftSource || null,
            benefits_source: benefitsSource || null,
            parsed_json: parsed.rawJson,
          },
        });
      }
    }
    const row = await this.prisma.crawl_jobs_staging.upsert({
      where: {
        crawl_staging_source_job_ver_uq: {
          source_id: sourceId,
          source_job_id: sourceJobId,
          parse_version: PARSE_VERSION,
        },
      },
      create: {
        source_id: sourceId,
        snapshot_id: snapshotId,
        source_job_id: sourceJobId,
        source_url: url,
        status: 'DISCOVERED',
        detected_language: parsed.detected,
        title_source: parsed.fields.title,
        tasks_source: tasksSource || null,
        skills_source: skillsSource || null,
        industry_source: parsed.fields.industry,
        locations_source: locationsSource || null,
        salary_source: parsed.fields.salaryText,
        shift_source: shiftSource || null,
        benefits_source: benefitsSource || null,
        parsed_json: parsed.rawJson,
        parse_version: PARSE_VERSION,
        qa_flags: [],
      },
      update: {
        snapshot_id: snapshotId,
        source_url: url,
        detected_language: parsed.detected,
        title_source: parsed.fields.title,
        tasks_source: tasksSource || null,
        skills_source: skillsSource || null,
        industry_source: parsed.fields.industry,
        locations_source: locationsSource || null,
        salary_source: parsed.fields.salaryText,
        shift_source: shiftSource || null,
        benefits_source: benefitsSource || null,
        parsed_json: parsed.rawJson,
      },
    });
    void fetchResult;
    void totalChars;
    return row;
  }

  private async transitionStatus(id: bigint, to: CrawlJobStatusValue, actorId: bigint | null) {
    const row = await this.prisma.crawl_jobs_staging.findUnique({ where: { id } });
    if (!row)
      throw new AppError({
        code: AppErrorCode.CRAWL_STAGING_NOT_FOUND,
        message: `staging row ${String(id)} not found`,
      });
    assertCrawlJobTransition(row.status, to);
    void actorId;
    return this.prisma.crawl_jobs_staging.update({
      where: { id },
      data: { status: to, updated_at: this.clock.now() },
    });
  }

  async translateStaging(
    stagingId: bigint,
  ): Promise<{ row: Prisma.crawl_jobs_stagingGetPayload<{}>; added: number }> {
    const row = await this.prisma.crawl_jobs_staging.findUnique({
      where: { id: stagingId },
      include: { snapshot: true },
    });
    if (!row) throw new AppError({ code: AppErrorCode.CRAWL_STAGING_NOT_FOUND });
    const httpStatus = row.snapshot?.http_status ?? null;
    const originalText = [
      row.title_source,
      row.tasks_source,
      row.skills_source,
      row.industry_source,
      row.locations_source,
      row.salary_source,
      row.shift_source,
      row.benefits_source,
    ]
      .filter(Boolean)
      .join('\n');
    const fallback = {
      title: row.title_source,
      tasks:
        row.tasks_source
          ?.split(/\n/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      skills:
        row.skills_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      industry: row.industry_source,
      locations:
        row.locations_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      salaryText: row.salary_source,
      shifts:
        row.shift_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      benefits:
        row.benefits_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
    };
    const detected =
      (row.detected_language as DetectedLanguage) ?? this.translation.detectLanguage(originalText);
    const { translations, failedLanguages } = await this.translation.translateIntoOtherLanguages({
      sourceLanguage: detected,
      originalText,
      structuredFallback: fallback,
    });
    void httpStatus;
    let added = 0;
    const now = this.clock.now();
    for (const lang of ['km', 'en', 'zh_CN'] as const) {
      const t = translations[lang];
      await this.prisma.job_translations.upsert({
        where: {
          job_trans_staging_lang_ver_uq: {
            staging_job_id: stagingId,
            language: lang,
            translation_version: t.version,
          },
        },
        create: {
          staging_job_id: stagingId,
          language: lang,
          title: t.fields.title,
          tasks: t.fields.tasks,
          skills: t.fields.skills,
          industry: t.fields.industry,
          locations: t.fields.locations,
          salary_text: t.fields.salaryText,
          shifts: t.fields.shifts,
          benefits: t.fields.benefits,
          translation_provider: t.provider,
          translation_model: t.model,
          translation_version: t.version,
          qa_status: 'NOT_RUN',
          review_status: 'NOT_RUN',
          warnings: t.fields.warnings,
        },
        update: {
          title: t.fields.title,
          tasks: t.fields.tasks,
          skills: t.fields.skills,
          industry: t.fields.industry,
          locations: t.fields.locations,
          salary_text: t.fields.salaryText,
          shifts: t.fields.shifts,
          benefits: t.fields.benefits,
          translation_provider: t.provider,
          translation_model: t.model,
          warnings: t.fields.warnings,
          updated_at: now,
        },
      });
      added++;
    }
    await this.audit.record({
      action: AuditActionEnum.CRAWL_TRANSLATION_DONE,
      objectType: 'crawl_jobs_staging',
      objectId: stagingId,
      metadata: {
        source_id: row.source_id,
        source_job_id: row.source_job_id,
        failed_languages: failedLanguages.join(','),
        translation_provider: this.aiProvider.providerId,
      },
      now,
    });
    const nextStatus: CrawlJobStatusValue =
      failedLanguages.length > 0 ? 'REVIEW_REQUIRED' : 'TRANSLATED';
    const transStatus: CrawlTranslationStatus = failedLanguages.length > 0 ? 'FAILED' : 'DONE';
    const updated = await this.prisma.crawl_jobs_staging.update({
      where: { id: stagingId },
      data: {
        status: nextStatus,
        translation_status: transStatus,
        updated_at: now,
      },
    });
    return { row: updated, added };
  }

  async runQAForStaging(
    stagingId: bigint,
  ): Promise<{ row: Prisma.crawl_jobs_stagingGetPayload<{}>; requiresReview: boolean }> {
    const row = await this.prisma.crawl_jobs_staging.findUnique({
      where: { id: stagingId },
      include: { snapshot: true, job_translations: true },
    });
    if (!row) throw new AppError({ code: AppErrorCode.CRAWL_STAGING_NOT_FOUND });
    const structural = this.qa.runStructuralQA({
      titleSource: row.title_source,
      tasksSource: row.tasks_source?.split(/\n/).filter(Boolean) ?? [],
      skillsSource:
        row.skills_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      industrySource: row.industry_source,
      locationsSource:
        row.locations_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      salarySource: row.salary_source,
      shiftSource:
        row.shift_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      benefitsSource:
        row.benefits_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      parsedJsonHeadcount:
        (row.parsed_json as { fields?: { headcount?: number | null } } | null)?.fields?.headcount ??
        null,
      detectedLanguage: row.detected_language,
      sourceJobSnapshotHttpStatus: row.snapshot?.http_status ?? null,
      totalChars: [
        row.title_source,
        row.tasks_source,
        row.skills_source,
        row.industry_source,
        row.locations_source,
        row.salary_source,
        row.shift_source,
        row.benefits_source,
      ]
        .filter(Boolean)
        .join('').length,
    });
    const translations: Record<'km' | 'en' | 'zh_CN', QATranslationInput> = {
      km: null as unknown as QATranslationInput,
      en: null as unknown as QATranslationInput,
      zh_CN: null as unknown as QATranslationInput,
    };
    for (const t of row.job_translations) {
      translations[t.language] = {
        language: t.language,
        title: t.title,
        tasks: t.tasks,
        skills: t.skills,
        industry: t.industry,
        locations: t.locations,
        salaryText: t.salary_text,
        shifts: t.shifts,
        benefits: t.benefits,
      };
    }
    const origForConsistency: QAStagingInput = {
      titleSource: row.title_source,
      tasksSource: row.tasks_source?.split(/\n/).filter(Boolean) ?? [],
      skillsSource:
        row.skills_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      industrySource: row.industry_source,
      locationsSource:
        row.locations_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      salarySource: row.salary_source,
      shiftSource:
        row.shift_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      benefitsSource:
        row.benefits_source
          ?.split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      parsedJsonHeadcount:
        (row.parsed_json as { fields?: { headcount?: number | null } } | null)?.fields?.headcount ??
        null,
      detectedLanguage: row.detected_language,
      sourceJobSnapshotHttpStatus: row.snapshot?.http_status ?? null,
      totalChars: [
        row.title_source,
        row.tasks_source,
        row.skills_source,
        row.industry_source,
        row.locations_source,
        row.salary_source,
        row.shift_source,
        row.benefits_source,
      ]
        .filter(Boolean)
        .join('').length,
    };
    const consistencyReal = this.qa.runConsistencyQA({
      original: origForConsistency,
      translations,
    });
    const failedLangs = row.job_translations
      .filter((t) => t.warnings?.some((w) => /TRANSLATION_FAILED/.test(w)))
      .map((t) => t.language);
    const aggregated = this.qa.aggregateForStaging({
      structural,
      consistency: consistencyReal,
      translationFailedLanguages: failedLangs,
    });
    const now = this.clock.now();
    const nextStatus: CrawlJobStatusValue = aggregated.requiresReview
      ? 'REVIEW_REQUIRED'
      : row.status === 'REVIEW_REQUIRED'
        ? row.status
        : 'QA_PENDING';
    const qaStatusDb: CrawlQAStatus = aggregated.requiresReview ? 'REVIEW_REQUIRED' : 'PASSED';
    if (aggregated.requiresReview) {
      await this.audit.record({
        action: AuditActionEnum.CRAWL_QA_FLAGGED,
        objectType: 'crawl_jobs_staging',
        objectId: stagingId,
        metadata: { source_id: row.source_id, qa_flags: aggregated.flags.join(',') },
        now,
      });
    }
    const updated = await this.prisma.crawl_jobs_staging.update({
      where: { id: stagingId },
      data: {
        status: nextStatus,
        qa_status: qaStatusDb,
        qa_flags: aggregated.flags,
        updated_at: now,
      },
    });
    return { row: updated, requiresReview: aggregated.requiresReview };
  }

  private async markStaleBySourceJobId(sourceId: bigint, sourceJobId: string) {
    await this.prisma.crawl_jobs_staging.updateMany({
      where: {
        source_id: sourceId,
        source_job_id: sourceJobId,
        status: { notIn: ['STALE', 'REJECTED', 'APPROVED', 'PUBLISHED'] },
      },
      data: { status: 'STALE', updated_at: this.clock.now() },
    });
  }
}
