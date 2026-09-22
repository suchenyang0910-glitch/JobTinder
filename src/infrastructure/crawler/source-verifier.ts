import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { APP_ENV } from '@src/shared/env/app-env';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import type { SourceParserType } from '@prisma/client';
import {
  type SourceReviewStatusValue,
  type SourceType,
  type SourceVerificationBreakdown,
  VALID_SOURCE_TYPES,
  bandForSourceVerificationScore,
  computeSourceVerificationScore,
} from '@src/domain/crawler/source-review-status-machine';

export interface SourceCsvRowInput {
  name: string;
  base_url: string;
  jobs_url: string;
  source_type: SourceType;
  parser_type: SourceParserType;
  city?: string | null;
  industry?: string | null;
  discovery_method?: string | null;
}

export interface ValidatedSourceRow extends SourceCsvRowInput {
  baseHost: string;
  jobsHost: string;
}

export interface ParseSourceCsvOptions {
  allowNonHttps?: boolean;
}

export interface ParseCsvResult {
  rows: SourceCsvRowInput[];
  parseErrors: { row: number; message: string }[];
}

export const JOB_URL_PATH_HINTS = /career|job|vacanc|work-with-us|recruit|employment|opportunit/i;
export const JOB_PAGE_BODY_KEYWORDS =
  /职位|申请|招聘|apply|career|open position|hiring|ចំណាត់ការងារ|រកបុគ្គលិក|vacancy/i;
export const JOB_PAGE_TITLE_KEYWORDS = /career|job|vacanc|招聘|职位|ចំណាត់ការងារ|hiring/i;
export const RECENT_UPDATE_ALLOWED_MS = 1000 * 60 * 60 * 24 * 180;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function normalizeSourceUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function parseAndValidateSourceUrl(raw: string, allowNonHttpsOverride?: boolean): URL {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AppError({
      code: AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV,
      message: `URL is empty`,
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    throw new AppError({
      code: AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV,
      message: `Invalid URL: ${trimmed}`,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError({
      code: AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV,
      message: `Unsupported URL scheme: ${parsed.protocol}`,
    });
  }
  const allowNonHttps = Boolean(allowNonHttpsOverride ?? APP_ENV.ALLOW_NON_HTTPS_SOURCES);
  if (!allowNonHttps && parsed.protocol !== 'https:') {
    throw new AppError({
      code: AppErrorCode.CRAWL_SOURCE_IMPORT_NON_HTTPS,
      message: `Non-HTTPS URL (${parsed.protocol}) is forbidden unless ALLOW_NON_HTTPS_SOURCES=true`,
    });
  }
  return parsed;
}

export function validateSameHost(baseUrl: URL, jobsUrl: URL): void {
  const baseHost = baseUrl.hostname.replace(/^www\./, '').toLowerCase();
  const jobsHost = jobsUrl.hostname.replace(/^www\./, '').toLowerCase();
  if (baseHost !== jobsHost) {
    throw new AppError({
      code: AppErrorCode.CRAWL_SOURCE_IMPORT_DOMAIN_MISMATCH,
      message: `base_url host (${baseHost}) != jobs_url host (${jobsHost})`,
    });
  }
}

export function normalizeSourceType(raw: string): SourceType {
  const trimmed = raw.trim();
  if (!VALID_SOURCE_TYPES.has(trimmed as SourceType)) {
    throw new AppError({
      code: AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV,
      message: `Invalid source_type: ${trimmed}. Expected one of: ${Array.from(VALID_SOURCE_TYPES).join(', ')}`,
    });
  }
  return trimmed as SourceType;
}

export function normalizeParserType(raw: string): SourceParserType {
  const trimmed = raw.trim();
  if (
    trimmed !== 'STATIC_HTML' &&
    trimmed !== 'PLAYWRIGHT' &&
    trimmed !== 'FIRECRAWL' &&
    trimmed !== 'MANUAL'
  ) {
    throw new AppError({
      code: AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV,
      message: `Invalid parser_type: ${trimmed}`,
    });
  }
  return trimmed;
}

export function parseSourcesCsv(text: string, options: ParseSourceCsvOptions = {}): ParseCsvResult {
  const allowNonHttps = Boolean(options.allowNonHttps);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trim().startsWith('#'));
  if (lines.length === 0) {
    return { rows: [], parseErrors: [{ row: 0, message: 'CSV is empty' }] };
  }
  const header = splitCsvLine(lines[0] as string).map((h) => h.trim().toLowerCase());
  const expected = [
    'name',
    'base_url',
    'jobs_url',
    'source_type',
    'parser_type',
    'city',
    'industry',
  ];
  const missing = expected.filter((k) => !header.includes(k));
  if (missing.length > 0) {
    return {
      rows: [],
      parseErrors: [{ row: 1, message: `Missing required CSV columns: ${missing.join(', ')}` }],
    };
  }
  const rows: SourceCsvRowInput[] = [];
  const parseErrors: { row: number; message: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const rawRowNo = i + 1;
    try {
      const cols = splitCsvLine(lines[i] as string);
      if (cols.length < 4) {
        parseErrors.push({
          row: rawRowNo,
          message: `Row has only ${cols.length} columns, need >=4`,
        });
        continue;
      }
      const record: Record<string, string> = {};
      header.forEach((h, idx) => {
        record[h] = (cols[idx] ?? '').trim();
      });
      const name = record.name ?? '';
      if (!name || name.length < 2) {
        parseErrors.push({ row: rawRowNo, message: 'name is required (>=2 chars)' });
        continue;
      }
      const baseUrl = parseAndValidateSourceUrl(record.base_url ?? '', allowNonHttps);
      const jobsUrl = parseAndValidateSourceUrl(record.jobs_url ?? '', allowNonHttps);
      validateSameHost(baseUrl, jobsUrl);
      const sourceType = normalizeSourceType(record.source_type ?? '');
      const parserType = normalizeParserType(record.parser_type ?? 'STATIC_HTML');
      rows.push({
        name,
        base_url: normalizeSourceUrl(baseUrl.toString()),
        jobs_url: normalizeSourceUrl(jobsUrl.toString()),
        source_type: sourceType,
        parser_type: parserType,
        city: record.city ?? null,
        industry: record.industry ?? null,
        discovery_method: record.discovery_method ?? 'csv_import',
      });
    } catch (e) {
      const message =
        e instanceof AppError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      parseErrors.push({ row: rawRowNo, message });
    }
  }
  return { rows, parseErrors };
}

export function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

export interface SourceVerificationHeuristicInput {
  declaredCompanyName: string;
  baseUrl: URL;
  jobsUrl: URL;
  pageTitle?: string | null;
  pageBody?: string | null;
  pageCopyright?: string | null;
  pageAddress?: string | null;
  pagePhone?: string | null;
  pageEmail?: string | null;
  pageLastModifiedMs?: number | null;
  robotsAllowed: boolean;
}

export function runSourceVerificationHeuristics(input: SourceVerificationHeuristicInput): {
  breakdown: SourceVerificationBreakdown;
  score: number;
  band: 'SUBMITTABLE' | 'MANUAL_REVIEW_REQUIRED' | 'REJECT';
  jobPagePresent: boolean;
  companyIdentityMatches: number;
} {
  const { declaredCompanyName, baseUrl, jobsUrl } = input;
  const nameTokens = declaredCompanyName
    .toLowerCase()
    .replace(/[^a-z0-9\u1780-\u17ff\u4e00-\u9fff\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const textBag = [input.pageTitle, input.pageBody, input.pageCopyright, input.pageAddress]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const companyNameMatch =
    nameTokens.filter((tok) => textBag.includes(tok)).length >=
    Math.max(1, Math.min(2, nameTokens.length));
  const baseHost = baseUrl.hostname.replace(/^www\./, '').toLowerCase();
  const hostTokens = nameTokens.filter(
    (token) =>
      !['company', 'corporation', 'corp', 'limited', 'ltd', 'co', 'cambodia'].includes(token),
  );
  const domainMatch =
    hostTokens.some((token) => token.length >= 4 && baseHost.includes(token)) ||
    Boolean(
      input.pageCopyright &&
      baseHost.replace(/\.[^.]+$/, '').length > 3 &&
      input.pageCopyright
        .toLowerCase()
        .includes(baseHost.replace(/^www\./, '').replace(/\.[^.]+$/, '')),
    );
  const addressMatch =
    Boolean(input.pageAddress) && (input.pageAddress as string).trim().length > 0;
  const contactMatch =
    Boolean(input.pagePhone && input.pagePhone.trim().length >= 6) ||
    Boolean(
      input.pageEmail &&
      /@/.test(input.pageEmail) &&
      input.pageEmail.split('@')[1] &&
      baseHost.endsWith(
        (input.pageEmail.split('@')[1] as string).replace(/^www\./, '').toLowerCase(),
      ),
    );
  const jobPagePresent =
    JOB_URL_PATH_HINTS.test(jobsUrl.pathname) ||
    (input.pageTitle ? JOB_PAGE_TITLE_KEYWORDS.test(input.pageTitle) : false) ||
    (input.pageBody ? JOB_PAGE_BODY_KEYWORDS.test(input.pageBody) : false);
  const recentUpdate =
    input.pageLastModifiedMs != null &&
    Date.now() - input.pageLastModifiedMs <= RECENT_UPDATE_ALLOWED_MS;
  const breakdown: SourceVerificationBreakdown = {
    companyNameMatch,
    domainMatch,
    addressMatch,
    contactMatch,
    jobPagePresent,
    robotsAllowed: input.robotsAllowed,
    recentUpdate,
  };
  const companyIdentityMatches = [companyNameMatch, domainMatch, addressMatch, contactMatch].filter(
    Boolean,
  ).length;
  const { score } = computeSourceVerificationScore(breakdown);
  const band = bandForSourceVerificationScore(score);
  return { breakdown, score, band, jobPagePresent, companyIdentityMatches };
}

export interface FinalizeSourceReviewSuggestionInput {
  score: number;
  companyIdentityMatches: number;
  termsExplicitlyForbidCrawling: boolean;
  jobsDisallowedByRobots: boolean;
}

export function suggestSourceReviewStatus(input: FinalizeSourceReviewSuggestionInput): {
  status: SourceReviewStatusValue;
  enabled: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  if (input.termsExplicitlyForbidCrawling) {
    notes.push('Terms explicitly forbid automated crawling.');
    return { status: 'REJECTED', enabled: false, notes };
  }
  if (input.jobsDisallowedByRobots) {
    notes.push('robots.txt blocks job page for our UA; keep as PENDING for manual signoff.');
    return { status: 'PENDING', enabled: false, notes };
  }
  if (input.companyIdentityMatches < 2) {
    notes.push(`Company identity matched only ${input.companyIdentityMatches}/2 required fields.`);
    return { status: 'PENDING', enabled: false, notes };
  }
  if (input.score >= 80) {
    notes.push(
      `Score ${input.score} >=80, auto SUBMITTABLE but still require human APPROVE to enable.`,
    );
    return { status: 'PENDING', enabled: false, notes };
  }
  if (input.score >= 60) {
    notes.push(`Score ${input.score} 60-79 MANUAL_REVIEW_REQUIRED.`);
    return { status: 'PENDING', enabled: false, notes };
  }
  notes.push(
    `Score ${input.score} <60, REJECT band; keep PENDING for operator to review-supplement or reject explicitly.`,
  );
  return { status: 'PENDING', enabled: false, notes };
}
