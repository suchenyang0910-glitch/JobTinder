import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { SourceValidationService } from './source-import.service';
import {
  normalizeSourceUrl,
  parseAndValidateSourceUrl,
  validateSameHost,
  normalizeSourceType,
} from '@src/infrastructure/crawler/source-verifier';
import { CrawlerReviewNotifierService } from './crawler-review-notifier.service';
import { type SourceType } from '@src/domain/crawler/source-review-status-machine';
import { APP_ENV } from '@src/shared/env/app-env';

export interface DiscoveredCompanyInput {
  name: string;
  base_url: string;
  jobs_url?: string | null;
  city?: string | null;
  industry?: string | null;
  discovery_method: string;
  source_type?: SourceType | null;
  discovery_url?: string | null;
}

export interface DiscoverResult {
  discovered: bigint[];
  duplicates: number;
  validationErrors: number;
  notified: number;
}

const CANONICAL_JOBS_SUFFIXES = [
  '/careers',
  '/career',
  '/jobs',
  '/job',
  '/vacancies',
  '/vacancy',
  '/work-with-us',
  '/recruitment',
  '/employment',
  '/opportunities',
];

function canonicalizeBaseHost(url: URL): string {
  return url.hostname.replace(/^www\./, '').toLowerCase();
}
void canonicalizeBaseHost;

@Injectable()
export class SourceDiscoveryService {
  private readonly logger = new Logger(SourceDiscoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    private readonly validation: SourceValidationService,
    private readonly notifier: CrawlerReviewNotifierService,
  ) {}

  suggestJobsSuffix(baseUrl: URL): string {
    const clean = baseUrl.toString().replace(/\/+$/, '');
    return `${clean}${CANONICAL_JOBS_SUFFIXES[0] ?? '/careers'}`;
  }

  async discoverFromCandidates(
    candidates: DiscoveredCompanyInput[],
    opts: { actorId?: bigint | null; notifyAdmin?: boolean; validateLive?: boolean } = {},
  ): Promise<DiscoverResult> {
    const notifyAdmin = opts.notifyAdmin ?? true;
    const validateLive = opts.validateLive ?? true;
    const result: DiscoverResult = {
      discovered: [],
      duplicates: 0,
      validationErrors: 0,
      notified: 0,
    };
    const now = this.clock.now();
    const knownBaseJobsPairs = new Set<string>();
    const allRows = await this.prisma.source_registry.findMany({
      select: { base_url: true, jobs_url: true },
    });
    for (const r of allRows) {
      const k = `${r.base_url.trim().toLowerCase()}#${r.jobs_url.trim().toLowerCase()}`;
      knownBaseJobsPairs.add(k);
    }

    for (const c of candidates) {
      try {
        const name = c.name.trim();
        if (!name) {
          result.validationErrors++;
          continue;
        }
        const baseNorm = normalizeSourceUrl(c.base_url);
        const baseUrl = parseAndValidateSourceUrl(baseNorm, APP_ENV.ALLOW_NON_HTTPS_SOURCES);

        let jobsNorm: string;
        let jobsUrl: URL;
        if (c.jobs_url && String(c.jobs_url).trim()) {
          jobsNorm = normalizeSourceUrl(String(c.jobs_url));
          jobsUrl = parseAndValidateSourceUrl(jobsNorm, APP_ENV.ALLOW_NON_HTTPS_SOURCES);
          validateSameHost(baseUrl, jobsUrl);
        } else {
          const suggested = this.suggestJobsSuffix(baseUrl);
          jobsNorm = normalizeSourceUrl(suggested);
          jobsUrl = parseAndValidateSourceUrl(jobsNorm, APP_ENV.ALLOW_NON_HTTPS_SOURCES);
        }

        const baseCanon = baseUrl.toString().replace(/\/+$/, '');
        const jobsCanon = jobsUrl.toString().replace(/\/+$/, '');
        const pairKey = `${baseCanon.toLowerCase()}#${jobsCanon.toLowerCase()}`;
        if (knownBaseJobsPairs.has(pairKey)) {
          result.duplicates++;
          continue;
        }

        const source_type = c.source_type
          ? normalizeSourceType(String(c.source_type))
          : ('OFFICIAL_COMPANY_WEBSITE' as SourceType);
        const city = c.city?.trim() || null;
        const industry = c.industry?.trim() || null;
        const discovery_method = c.discovery_method?.trim() || 'directory_feed';

        const found = await this.prisma.source_registry.create({
          data: {
            name,
            base_url: baseCanon,
            jobs_url: jobsCanon,
            source_type,
            parser_type: 'STATIC_HTML',
            enabled: false,
            review_status: 'PENDING',
            city,
            industry,
            discovery_method,
            robots_status: 'UNCHECKED',
            crawl_interval_minutes: 360,
            verification_notes: c.discovery_url
              ? `Discovered via: ${String(c.discovery_url)}`
              : null,
          },
        });
        knownBaseJobsPairs.add(pairKey);
        result.discovered.push(found.id);

        this.audit
          .record({
            actorId: opts.actorId ?? undefined,
            action: AuditActionEnum.SOURCE_DISCOVERED,
            objectType: 'source_registry',
            objectId: found.id,
            metadata: {
              base_url: baseCanon,
              jobs_url: jobsCanon,
              source_type,
              discovery_method,
              city: city ?? undefined,
              industry: industry ?? undefined,
              discovery_url: c.discovery_url ?? undefined,
            },
            now,
          })
          .catch((e) => this.logger.warn(`Audit SOURCE_DISCOVERED write failed: ${String(e)}`));

        if (validateLive) {
          try {
            const validated = await this.validation.validate(found.id, opts.actorId ?? null);
            this.audit
              .record({
                actorId: opts.actorId ?? undefined,
                action: AuditActionEnum.SOURCE_VALIDATED,
                objectType: 'source_registry',
                objectId: found.id,
                metadata: {
                  verification_score: validated.verification_score,
                  robots_status: validated.robots_status,
                  review_status: validated.review_status,
                  validation_error: validated.validation_error ?? undefined,
                },
                now: this.clock.now(),
              })
              .catch((e) => this.logger.warn(`Audit SOURCE_VALIDATED write failed: ${String(e)}`));
            void validated;
          } catch (e) {
            this.logger.warn(
              `Source #${String(found.id)} live validation failed: ${e instanceof Error ? e.message : String(e)}`,
            );
            result.validationErrors++;
          }
        }
      } catch (e) {
        this.logger.warn(
          `Discovered candidate skipped invalid: ${e instanceof Error ? e.message : String(e)}`,
        );
        result.validationErrors++;
      }
    }

    if (notifyAdmin) {
      for (const id of result.discovered) {
        try {
          const row = await this.prisma.source_registry.findUnique({ where: { id } });
          if (!row || row.source_notified_at) continue;
          if (row.review_status !== 'PENDING') continue;
          const ok = await this.notifier.notifySource(id);
          if (ok) {
            await this.prisma.source_registry.update({
              where: { id },
              data: { source_notified_at: new Date() },
            });
            result.notified++;
          }
        } catch (e) {
          this.logger.warn(
            `notifySource #${String(id)} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    return result;
  }
}
