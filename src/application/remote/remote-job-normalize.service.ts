import { Injectable } from '@nestjs/common';
import {
  type EmploymentType,
  type RemoteScope,
  type WorkAuthorization,
  type WorkMode,
} from '@prisma/client';
import { type NormalizedRemoteJob, type RemoteRawJob } from '@src/domain/remote/remote-entities';
import { createHash } from 'node:crypto';

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function normalizeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    x.hash = '';
    x.searchParams.sort();
    return x.toString().toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

function mapEmploymentType(raw: string | null | undefined): EmploymentType | null {
  if (!raw) return null;
  const r = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_');
  if (r.includes('full_time') || r.includes('fulltime') || r === 'full' || r.includes('permanent'))
    return 'FULL_TIME';
  if (r.includes('part_time') || r.includes('parttime') || r === 'part') return 'PART_TIME';
  if (r.includes('contract') || r.includes('contractor')) return 'CONTRACT';
  if (r.includes('freelance') || r.includes('freelancer')) return 'FREELANCE';
  if (r.includes('intern') || r.includes('internship')) return 'INTERNSHIP';
  return null;
}

function mapRemoteScope(raw: RemoteRawJob): RemoteScope | null {
  const regionHint = (
    raw.eligibleCountriesRaw ||
    raw.remoteScopeRaw ||
    (raw.candidate_required_location as string) ||
    ''
  )
    .trim()
    .toLowerCase();
  const allowed = raw.allowedCountries.map((c) => c.toLowerCase());
  if (!regionHint && allowed.length === 0) return null;
  if (
    regionHint.includes('worldwide') ||
    regionHint.includes('global') ||
    regionHint.includes('any country') ||
    regionHint.includes('anywhere') ||
    allowed.some((c) => c.includes('worldwide') || c.includes('global'))
  )
    return 'WORLDWIDE';
  if (
    regionHint.includes('asean') ||
    allowed.some((c) => /^(asean|southeast asia|se asia)/.test(c))
  )
    return 'ASEAN';
  if (regionHint.includes('asia') || allowed.some((c) => /asia/.test(c))) return 'ASIA';
  const kh =
    /cambodia|khmer|kampuchea|khm|phnom/.test(regionHint) ||
    allowed.some((c) => /cambodia|khmer|kampuchea/.test(c));
  if (kh && allowed.length <= 2) return 'CAMBODIA_ONLY';
  if (
    allowed.length > 0 ||
    regionHint.includes('only eu') ||
    regionHint.includes('europe only') ||
    regionHint.includes('us only')
  )
    return 'COUNTRY_LIMITED';
  return null;
}

function mapWorkAuthorization(raw: RemoteRawJob): WorkAuthorization {
  const w = (raw.workAuthRaw || '').trim().toLowerCase();
  if (!w) return 'UNKNOWN';
  if (
    w.includes('not required') ||
    w.includes('no sponsorship') ||
    w.includes('any citizenship') ||
    w.includes('independent contractor welcome') ||
    w.includes('contractors welcome')
  )
    return 'NOT_REQUIRED';
  if (
    w.includes('required') ||
    w.includes('must be') ||
    w.includes('only resident') ||
    w.includes('only citizen') ||
    w.includes('work permit required') ||
    w.includes('w-2') ||
    w.includes('eu resident only') ||
    w.includes('us resident only')
  )
    return 'REQUIRED';
  return 'UNKNOWN';
}

function mapSalaryStatus(raw: RemoteRawJob): 'PROVIDED' | 'NOT_PROVIDED' | 'NEGOTIABLE' {
  const s = (raw.salaryTextRaw || '').trim().toLowerCase();
  if (!s) return 'NOT_PROVIDED';
  if (s.includes('negotiable') || s.includes('competitive') || s.includes('based on'))
    return 'NEGOTIABLE';
  if (/\d/.test(s)) return 'PROVIDED';
  return 'NOT_PROVIDED';
}

function extractSkillsFromTags(tags: string[], categories: string[]): string[] {
  const merged = tags
    .concat(categories)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const t of merged) {
    if (t.length < 2 || t.length > 64) continue;
    const low = t.toLowerCase();
    if (low.match(/^[a-z0-9 .+\-#/]+$/i)) out.push(t);
  }
  return Array.from(new Set(out)).slice(0, 40);
}

function companyNormalized(c: string | null | undefined): string {
  if (!c) return '';
  return String(c)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleNormalized(t: string | null | undefined): string {
  if (!t) return '';
  return String(t)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeRemoteJob(raw: RemoteRawJob): NormalizedRemoteJob {
  const applicationUrl = normalizeUrl(raw.applicationUrl ?? raw.sourceUrl);
  const urlKey = applicationUrl ? sha1(applicationUrl) : null;
  const companyTitleKey =
    raw.companyName && raw.title
      ? sha1(`${companyNormalized(raw.companyName)}|${titleNormalized(raw.title)}`)
      : null;
  return {
    raw,
    workMode: 'REMOTE',
    remoteScope: mapRemoteScope(raw),
    eligibleCountries: Array.from(new Set(raw.allowedCountries)),
    employerCountry: raw.employerCountry ?? null,
    timezoneRequired: raw.timezoneRequired ?? null,
    timezoneOverlapHours: raw.timezoneOverlapHours ?? null,
    workAuthorization: mapWorkAuthorization(raw),
    employmentType: mapEmploymentType(raw.employmentTypeRaw),
    paymentMethod: raw.paymentMethodRaw ?? null,
    salaryCurrency: raw.salaryCurrency ?? null,
    applicationUrl,
    sourcePlatform: raw.sourcePlatform,
    sourceLastSeenAt: raw.lastSeenAt,
    title: raw.title ? raw.title.trim() : null,
    industry: raw.categories[0] ?? null,
    skills: extractSkillsFromTags(raw.tags, raw.categories),
    tasks: [],
    locations: Array.from(new Set(raw.locations.concat(raw.regions)).values()).slice(0, 20),
    languagesRequired: [],
    salaryStatus: mapSalaryStatus(raw),
    salaryText: raw.salaryTextRaw ?? null,
    shifts: [],
    idempotencyUrlKey: urlKey ? `remote:url:${urlKey}` : null,
    idempotencyPlatformJobKey: `remote:platform:${raw.sourcePlatform}:${raw.sourceJobId}`,
    idempotencyCompanyTitleKey: companyTitleKey ? `remote:ct:${companyTitleKey}` : null,
    originalPublishedAt: raw.publishedAt ?? null,
    originalDeadlineAt: raw.deadlineAt ?? null,
  };
}

export interface DedupeResult {
  kept: NormalizedRemoteJob[];
  duplicatesByUrl: number;
  duplicatesByPlatformJob: number;
  duplicatesByCompanyTitle: number;
}

export function dedupeNormalizedRemoteJobs(list: NormalizedRemoteJob[]): DedupeResult {
  const byUrl = new Map<string, NormalizedRemoteJob>();
  const byPlatformJob = new Map<string, NormalizedRemoteJob>();
  const byCompanyTitle = new Map<string, NormalizedRemoteJob>();
  const kept = new Map<string, NormalizedRemoteJob>();

  let dupUrl = 0;
  let dupPlatform = 0;
  let dupCT = 0;

  const sorted = list.slice().sort((a, b) => {
    const ta = a.raw.lastSeenAt.getTime();
    const tb = b.raw.lastSeenAt.getTime();
    return tb - ta;
  });

  for (const job of sorted) {
    let duplicate = false;
    if (job.idempotencyUrlKey) {
      if (byUrl.has(job.idempotencyUrlKey)) {
        dupUrl++;
        duplicate = true;
      } else byUrl.set(job.idempotencyUrlKey, job);
    }
    if (!duplicate) {
      if (byPlatformJob.has(job.idempotencyPlatformJobKey)) {
        dupPlatform++;
        duplicate = true;
      } else byPlatformJob.set(job.idempotencyPlatformJobKey, job);
    }
    if (!duplicate && job.idempotencyCompanyTitleKey) {
      if (byCompanyTitle.has(job.idempotencyCompanyTitleKey)) {
        dupCT++;
        duplicate = true;
      } else byCompanyTitle.set(job.idempotencyCompanyTitleKey, job);
    }
    if (!duplicate) {
      kept.set(job.idempotencyPlatformJobKey, job);
    }
  }

  return {
    kept: Array.from(kept.values()),
    duplicatesByUrl: dupUrl,
    duplicatesByPlatformJob: dupPlatform,
    duplicatesByCompanyTitle: dupCT,
  };
}

export type { WorkMode, WorkAuthorization, EmploymentType, RemoteScope };

@Injectable()
export class RemoteJobNormalizeService {
  normalize(raw: RemoteRawJob): NormalizedRemoteJob {
    return normalizeRemoteJob(raw);
  }

  dedupe(list: NormalizedRemoteJob[]): DedupeResult {
    return dedupeNormalizedRemoteJobs(list);
  }
}
