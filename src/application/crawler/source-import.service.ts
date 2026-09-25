import { readFileSync } from 'node:fs';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import {
  parseSourcesCsv,
  runSourceVerificationHeuristics,
  suggestSourceReviewStatus,
  type SourceCsvRowInput,
  type ValidatedSourceRow,
} from '@src/infrastructure/crawler/source-verifier';
import { StaticHttpCrawler } from '@src/infrastructure/crawler/static-http-crawler';
import {
  assertSourceReviewTransition,
  type SourceReviewStatusValue,
  type SourceType,
} from '@src/domain/crawler/source-review-status-machine';
import { CrawlerReviewNotifierService } from './crawler-review-notifier.service';

export interface SourceImportOptions {
  dryRun?: boolean;
  allowNonHttps?: boolean;
  actorId?: bigint | null;
  discoveryMethodFallback?: string;
  skipLiveHttp?: boolean;
}

export interface PerRowReport {
  row: number;
  name: string;
  base_url: string;
  jobs_url: string;
  imported: boolean;
  duplicateOfId?: bigint | null;
  insertedId?: bigint | null;
  verification_score?: number | null;
  review_status?: SourceReviewStatusValue | null;
  errors?: string[];
  warnings?: string[];
}

export interface ImportSourcesResult {
  totalRows: number;
  parseErrors: { row: number; message: string }[];
  importReports: PerRowReport[];
  inserted: number;
  duplicates: number;
  failed: number;
  dryRun: boolean;
}

@Injectable()
export class SourceImportService {
  private readonly logger = new Logger(SourceImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    private readonly crawler: StaticHttpCrawler,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() private readonly notifier?: CrawlerReviewNotifierService,
  ) {}

  async importFromCsvFile(
    filePath: string,
    options: SourceImportOptions = {},
  ): Promise<ImportSourcesResult> {
    let text: string;
    try {
      text = readFileSync(filePath, { encoding: 'utf8' });
    } catch (e) {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV,
        message: `Cannot read CSV file: ${filePath} — ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    return this.importFromCsvText(text, options);
  }

  async importFromCsvText(
    csvText: string,
    options: SourceImportOptions = {},
  ): Promise<ImportSourcesResult> {
    const dryRun = Boolean(options.dryRun);
    const parsed = parseSourcesCsv(csvText, { allowNonHttps: options.allowNonHttps });
    const reports: PerRowReport[] = [];
    let inserted = 0;
    let duplicates = 0;
    let failed = 0;
    const now = this.clock.now();

    for (let r = 0; r < parsed.rows.length; r++) {
      const row = parsed.rows[r]!;
      const csvRowNo = r + 2;
      const report: PerRowReport = {
        row: csvRowNo,
        name: row.name,
        base_url: row.base_url,
        jobs_url: row.jobs_url,
        imported: false,
        errors: [],
        warnings: [],
      };
      try {
        const existing = await this.prisma.source_registry.findFirst({
          where: { base_url: row.base_url, jobs_url: row.jobs_url },
          select: { id: true },
        });
        if (existing) {
          duplicates++;
          report.duplicateOfId = existing.id;
          report.warnings?.push('Duplicate (base_url+jobs_url) already exists; skipped.');
          continue;
        }
        const validated = row as ValidatedSourceRow;
        const verification = options.skipLiveHttp
          ? {
              score: 0,
              suggestedReviewStatus: 'PENDING' as SourceReviewStatusValue,
              suggestedEnabled: false,
              notes: [
                '[skip-http] Live HTTP verification skipped via --skip-http; please run validate-source later',
              ],
              validationErrors: [],
              breakdown: {
                companyNameMatch: false,
                domainMatch: false,
                addressMatch: false,
                contactMatch: false,
                jobsPagePresent: false,
                robotsAllowed: false,
                recentUpdate: false,
              },
              robotsStatus: 'UNCHECKED',
            }
          : await this.quickVerifyFromLiveHttp(validated);
        report.verification_score = verification.score;
        report.review_status = verification.suggestedReviewStatus;
        const payload: Prisma.source_registryCreateInput = {
          name: row.name,
          base_url: row.base_url,
          jobs_url: row.jobs_url,
          source_type: row.source_type,
          parser_type: row.parser_type,
          city: row.city ?? null,
          industry: row.industry ?? null,
          discovery_method: row.discovery_method ?? options.discoveryMethodFallback ?? 'csv_import',
          review_status: verification.suggestedReviewStatus,
          enabled: false,
          robots_status: verification.robotsStatus,
          verification_score: verification.score,
          verification_notes: verification.notes.join(' | ').slice(0, 2000) || null,
          last_validation_at: now,
          validation_error:
            verification.validationErrors.length > 0
              ? verification.validationErrors.join(' | ').slice(0, 1024)
              : null,
          crawl_interval_minutes: 360,
        };
        if (dryRun) {
          report.imported = false;
          report.warnings?.push(
            `dry-run enabled; would insert with review_status=${verification.suggestedReviewStatus} score=${verification.score}`,
          );
          continue;
        }
        const created = await this.prisma.source_registry.create({ data: payload });
        report.insertedId = created.id;
        report.imported = true;
        inserted++;
        await this.audit.record({
          action: AuditActionEnum.SOURCE_IMPORTED,
          objectType: 'source_registry',
          objectId: created.id,
          actorId: options.actorId ?? undefined,
          metadata: {
            base_url: row.base_url,
            jobs_url: row.jobs_url,
            source_type: row.source_type,
            city: row.city ?? null,
            industry: row.industry ?? null,
            review_status: verification.suggestedReviewStatus,
            verification_score: verification.score,
            dry_run: false,
          },
          now,
        });
        if (created.review_status === 'PENDING') {
          await this.notifier?.notifySource(created.id);
        }
      } catch (e) {
        failed++;
        report.errors?.push(
          e instanceof AppError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
        );
      } finally {
        reports.push(report);
      }
    }

    return {
      totalRows: parsed.rows.length + parsed.parseErrors.length,
      parseErrors: parsed.parseErrors,
      importReports: reports,
      inserted,
      duplicates,
      failed,
      dryRun,
    };
  }

  async quickVerifyFromLiveHttp(row: ValidatedSourceRow) {
    const validationErrors: string[] = [];
    const notes: string[] = [];
    let robotsStatus = 'UNCHECKED' as 'ALLOWED' | 'DISALLOWED' | 'UNCHECKED';
    let title: string | null = null;
    let body: string | null = null;
    let copyright: string | null = null;
    let address: string | null = null;
    let phone: string | null = null;
    let email: string | null = null;
    let lastModified: number | null = null;
    try {
      const robots = await this.crawler.checkRobots(row.base_url);
      robotsStatus = robots.allowed ? 'ALLOWED' : 'DISALLOWED';
      if (!robots.allowed) notes.push(`robots.txt blocked: ${robots.reason ?? ''}`);
    } catch (e) {
      validationErrors.push(
        `robots check failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300),
      );
    }
    try {
      const base = await this.crawler.fetchPage({
        sourceId: BigInt(-1),
        url: row.base_url,
        skipSnapshot: true,
      });
      if (base.body) {
        const domLike = extractLightweightTextFields(base.body);
        title = domLike.title;
        body = domLike.body;
        copyright = domLike.copyright;
        address = domLike.address;
        phone = domLike.phone;
        email = domLike.email;
      }
      if (base.headers?.has?.('last-modified')) {
        lastModified = new Date(base.headers.get('last-modified') as string).getTime();
      }
    } catch (e) {
      validationErrors.push(
        `base_url fetch failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300),
      );
    }
    try {
      const jobs = await this.crawler.fetchPage({
        sourceId: BigInt(-1),
        url: row.jobs_url,
        skipSnapshot: true,
      });
      if (jobs.body) {
        const domLike = extractLightweightTextFields(jobs.body);
        if (!title) title = domLike.title;
        body = (body ?? '') + '\n' + (domLike.body ?? '');
        if (!copyright) copyright = domLike.copyright;
        if (!address) address = domLike.address;
        if (!phone) phone = domLike.phone;
        if (!email) email = domLike.email;
      }
    } catch (e) {
      validationErrors.push(
        `jobs_url fetch failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300),
      );
    }
    const heur = runSourceVerificationHeuristics({
      declaredCompanyName: row.name,
      baseUrl: new URL(row.base_url),
      jobsUrl: new URL(row.jobs_url),
      pageTitle: title,
      pageBody: body,
      pageCopyright: copyright,
      pageAddress: address,
      pagePhone: phone,
      pageEmail: email,
      pageLastModifiedMs: lastModified,
      robotsAllowed: robotsStatus === 'ALLOWED',
    });
    if (heur.companyIdentityMatches < 2) {
      notes.push(`Company identity only ${heur.companyIdentityMatches}/2 matches (need >=2)`);
    }
    const suggestion = suggestSourceReviewStatus({
      score: heur.score,
      companyIdentityMatches: heur.companyIdentityMatches,
      termsExplicitlyForbidCrawling:
        /(prohibit|forbid|disallow|严禁|禁止|不得).*(automated|scrap|crawl|爬取|爬虫|抓取)/i.test(
          body ?? '',
        ),
      jobsDisallowedByRobots: robotsStatus === 'DISALLOWED',
    });
    if (suggestion.notes.length) notes.push(...suggestion.notes);
    return {
      score: heur.score,
      breakdown: heur.breakdown,
      robotsStatus,
      suggestedReviewStatus: suggestion.status,
      suggestedEnabled: suggestion.enabled,
      notes,
      validationErrors,
    };
  }
}

export interface TextFieldsLite {
  title: string | null;
  body: string | null;
  copyright: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
}

export function extractLightweightTextFields(rawHtml: string): TextFieldsLite {
  const noScript = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const titleMatch = noScript.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? (titleMatch[1] as string).trim() : null;
  const text = noScript
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const copyrightMatch = text.match(/©[\s\S]{0,200}/i) ?? text.match(/copyright[\s\S]{0,200}/i);
  const copyright = copyrightMatch ? copyrightMatch[0].trim().slice(0, 400) : null;
  const addressMatch =
    text.match(/(?:address|អាសយដ្ឋាន|地址|location|place)\s*[:：]?\s*([^\n]{10,200})/i) ??
    text.match(
      /(?:phnom penh|sihanouk|siem reap|暹粒|金边|西哈努克|#\d+[^\n,]{0,200}(?:street|blvd|road|ផ្លូវ))/i,
    );
  const address = addressMatch ? (addressMatch[1] ?? addressMatch[0]).trim().slice(0, 400) : null;
  const phoneMatch =
    text.match(/(?:tel|phone|电话|ទូរស័ព្ទ)\s*[:：]?\s*([+\-\d()\s]{7,30})/i) ??
    text.match(/(?:\+?855|0)[1-9][0-9\-\s]{7,20}/);
  const phone = phoneMatch ? (phoneMatch[1] ?? phoneMatch[0]).trim().slice(0, 60) : null;
  const emailMatch = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const email = emailMatch ? emailMatch[0] : null;
  return { title, body: text.slice(0, 10000), copyright, address, phone, email };
}

@Injectable()
export class SourceReviewService {
  private readonly logger = new Logger(SourceReviewService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async approve(sourceId: bigint, actorId: bigint | null, reason?: string | null) {
    const row = await this.loadOrThrow(sourceId);
    assertSourceReviewTransition(row.review_status, 'APPROVED');
    const now = this.clock.now();
    const updated = await this.prisma.source_registry.update({
      where: { id: sourceId },
      data: {
        review_status: 'APPROVED',
        enabled: true,
        verified_at: now,
        verified_by: actorId ? String(actorId) : 'cli',
        last_validation_at: now,
        validation_error: null,
      },
    });
    await this.audit.record({
      action: AuditActionEnum.SOURCE_APPROVED,
      objectType: 'source_registry',
      objectId: sourceId,
      actorId: actorId ?? undefined,
      metadata: { review_status: 'APPROVED', reason: reason ?? null, source_id: String(sourceId) },
      now,
    });
    return updated;
  }

  async reject(sourceId: bigint, actorId: bigint | null, reason: string) {
    const row = await this.loadOrThrow(sourceId);
    assertSourceReviewTransition(row.review_status, 'REJECTED');
    const now = this.clock.now();
    const updated = await this.prisma.source_registry.update({
      where: { id: sourceId },
      data: {
        review_status: 'REJECTED',
        enabled: false,
        last_validation_at: now,
        validation_error: reason.slice(0, 1024),
      },
    });
    await this.audit.record({
      action: AuditActionEnum.SOURCE_REJECTED,
      objectType: 'source_registry',
      objectId: sourceId,
      actorId: actorId ?? undefined,
      metadata: {
        review_status: 'REJECTED',
        reason: reason.slice(0, 512),
        source_id: String(sourceId),
      },
      now,
    });
    return updated;
  }

  async suspend(sourceId: bigint, actorId: bigint | null, reason?: string | null) {
    const row = await this.loadOrThrow(sourceId);
    assertSourceReviewTransition(row.review_status, 'SUSPENDED');
    const now = this.clock.now();
    const updated = await this.prisma.source_registry.update({
      where: { id: sourceId },
      data: {
        review_status: 'SUSPENDED',
        enabled: false,
        suspended_at: now,
        disable_reason: (reason ?? 'suspended').slice(0, 1024),
        last_validation_at: now,
        validation_error: (reason ?? 'suspended').slice(0, 1024),
      },
    });
    await this.audit.record({
      action: AuditActionEnum.SOURCE_SUSPENDED,
      objectType: 'source_registry',
      objectId: sourceId,
      actorId: actorId ?? undefined,
      metadata: { review_status: 'SUSPENDED', reason: reason ?? null, source_id: String(sourceId) },
      now,
    });
    return updated;
  }

  async defer(sourceId: bigint, actorId: bigint | null, reason?: string | null): Promise<boolean> {
    const row = await this.loadOrThrow(sourceId);
    assertSourceReviewTransition(row.review_status, 'DEFERRED');
    const now = this.clock.now();
    const old = row.review_status;
    const updated = await this.prisma.source_registry.update({
      where: { id: sourceId },
      data: { review_status: 'DEFERRED', last_validation_at: now, source_notified_at: null },
    });
    await this.audit.record({
      action: AuditActionEnum.SOURCE_DEFERRED,
      objectType: 'source_registry',
      objectId: sourceId,
      actorId: actorId ?? undefined,
      metadata: {
        old_status: old,
        new_status: 'DEFERRED',
        defer_reason: reason ?? null,
        source_id: String(sourceId),
      },
      now,
    });
    return Boolean(updated);
  }

  private async loadOrThrow(sourceId: bigint) {
    const r = await this.prisma.source_registry.findUnique({ where: { id: sourceId } });
    if (!r) {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_NOT_FOUND,
        message: `source_registry #${String(sourceId)} not found`,
      });
    }
    return r;
  }
}

@Injectable()
export class SourceValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    private readonly importer: SourceImportService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async validate(sourceId: bigint, actorId: bigint | null) {
    const row = await this.prisma.source_registry.findUnique({ where: { id: sourceId } });
    if (!row) {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_NOT_FOUND,
        message: `source #${String(sourceId)} not found`,
      });
    }
    const validated = await this.importer.quickVerifyFromLiveHttp({
      name: row.name,
      base_url: row.base_url,
      jobs_url: row.jobs_url,
      source_type: row.source_type as SourceType,
      parser_type: row.parser_type,
      baseHost: new URL(row.base_url).hostname,
      jobsHost: new URL(row.jobs_url).hostname,
      city: row.city,
      industry: row.industry,
    });
    const now = this.clock.now();
    const updated = await this.prisma.source_registry.update({
      where: { id: sourceId },
      data: {
        verification_score: validated.score,
        verification_notes: validated.notes.join(' | ').slice(0, 2000) || null,
        robots_status: validated.robotsStatus,
        last_validation_at: now,
        validation_error:
          validated.validationErrors.length > 0
            ? validated.validationErrors.join(' | ').slice(0, 1024)
            : null,
        review_status: validated.suggestedReviewStatus,
      },
    });
    await this.audit.record({
      action: AuditActionEnum.SOURCE_VALIDATED,
      objectType: 'source_registry',
      objectId: sourceId,
      actorId: actorId ?? undefined,
      metadata: {
        verification_score: validated.score,
        review_status: validated.suggestedReviewStatus,
        robots_status: validated.robotsStatus,
        validation_error:
          validated.validationErrors.length > 0
            ? validated.validationErrors.join(' | ').slice(0, 512)
            : null,
      },
      now,
    });
    return updated;
  }
}
