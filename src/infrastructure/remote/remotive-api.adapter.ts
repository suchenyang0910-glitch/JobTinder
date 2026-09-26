import { REMOTE_SOURCE_PLATFORM, type RemoteRawJob } from '@src/domain/remote/remote-entities';
import { safeHttpFetch } from '@src/infrastructure/remote/remote-http-client';

export const DEFAULT_REMOTIVE_API_BASE_URL = 'https://remotive.com/api/remote-jobs';

export function remotiveCategoryToIndustry(cat: string | null | undefined): string | null {
  if (!cat) return null;
  const c = String(cat).trim().toLowerCase();
  if (c.includes('software') || c.includes('dev') || c.includes('engineer')) return 'Technology';
  if (c.includes('customer') || c.includes('support')) return 'Customer Service';
  if (c.includes('marketing') || c.includes('sales')) return 'Marketing & Sales';
  if (c.includes('design')) return 'Design';
  if (c.includes('product')) return 'Product';
  if (c.includes('hr') || c.includes('human')) return 'HR & Recruiting';
  if (c.includes('finance') || c.includes('accounting')) return 'Finance';
  if (c.includes('writing') || c.includes('content')) return 'Content & Writing';
  if (c.includes('data')) return 'Data & Analytics';
  return String(cat);
}

export interface RemotiveApiJob {
  id: number;
  url?: string | null;
  title?: string | null;
  company_name?: string | null;
  category?: string | null;
  tags?: (string | null)[] | null;
  job_type?: string | null;
  publication_date?: string | null;
  expiration_date?: string | null;
  candidate_required_location?: string | null;
  salary?: string | null;
  description?: string | null;
  company_logo?: string | null;
  region_restrictions?: (string | null)[] | string | null;
  languages?: (string | null)[] | string | null;
  [k: string]: unknown;
}

export interface RemotiveApiResponse {
  job_count?: number | null;
  jobs?: RemotiveApiJob[] | null;
  [k: string]: unknown;
}

function asList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x))).filter(Boolean);
  if (typeof v === 'string') {
    if (!v.trim()) return [];
    return v
      .split(/[,;|\/]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function remotiveApiJobToRaw(j: RemotiveApiJob, fetchedAt: Date): RemoteRawJob {
  const jobId = String(j.id);
  const jobUrl = j.url ? String(j.url) : `https://remotive.com/remote-jobs/${jobId}`;
  const regions = asList(j.region_restrictions ?? j.candidate_required_location ?? []);
  const tags = asList(j.tags);
  const languages = asList(j.languages);
  const salaryTextRaw = typeof j.salary === 'string' && j.salary.trim() ? j.salary : null;
  const locationHint = j.candidate_required_location
    ? String(j.candidate_required_location).trim()
    : null;
  const allowed: string[] = [];
  const excluded: string[] = [];
  for (const r of regions) {
    const low = r.toLowerCase();
    if (
      low.startsWith('no ') ||
      (low.includes('only') &&
        (low.includes('europe') || low.includes('us only') || low.includes('usa only')))
    ) {
      excluded.push(r);
    } else {
      allowed.push(r);
    }
  }
  if (locationHint && allowed.length === 0) allowed.push(locationHint);
  return {
    sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTIVE_API,
    sourceParserType: 'API',
    sourceJobId: `remotive:${jobId}`,
    sourceUrl: jobUrl,
    applicationUrl: jobUrl,
    title: j.title ? String(j.title) : null,
    companyName: j.company_name ? String(j.company_name) : null,
    descriptionRaw: j.description ? String(j.description) : null,
    salaryMinRaw: null,
    salaryMaxRaw: null,
    salaryCurrency: salaryTextRaw
      ? salaryTextRaw.includes('$') || salaryTextRaw.includes('USD')
        ? 'USD'
        : null
      : null,
    salaryTextRaw,
    tags,
    categories: j.category ? [String(j.category)] : [],
    locations: locationHint ? [locationHint] : [],
    regions,
    eligibleCountriesRaw: j.candidate_required_location
      ? String(j.candidate_required_location)
      : null,
    allowedCountries: allowed,
    excludedCountries: excluded,
    employerCountry: null,
    timezoneRequired: null,
    timezoneOverlapHours: null,
    workAuthRaw: null,
    employmentTypeRaw: j.job_type ? String(j.job_type) : null,
    paymentMethodRaw: null,
    remoteScopeRaw: j.candidate_required_location ? String(j.candidate_required_location) : null,
    publishedAt: parseDate(j.publication_date),
    deadlineAt: parseDate(j.expiration_date),
    lastSeenAt: fetchedAt,
    fetchedAt,
    rawPayload: j,
  };
}

export async function fetchRemotiveApiJobs(opts?: {
  baseUrl?: string;
  timeoutMs?: number;
  limit?: number;
}): Promise<{
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number;
  jobs: RemoteRawJob[];
  rawResponse: RemotiveApiResponse | null;
}> {
  const base = opts?.baseUrl ?? DEFAULT_REMOTIVE_API_BASE_URL;
  const url = opts?.limit ? `${base}?limit=${encodeURIComponent(String(opts.limit))}` : base;
  const res = await safeHttpFetch(url, {
    method: 'GET',
    timeoutMs: opts?.timeoutMs ?? 30000,
    accept: 'application/json, text/plain;q=0.9,*/*;q=0.8',
  });
  const fetchedAt = new Date();
  if (!res.ok || !res.text) {
    return {
      ok: false,
      errorCode: res.errorCode ?? `HTTP_${res.status}`,
      errorMessage: res.errorMessage ?? `HTTP ${res.status}`,
      httpStatus: res.status,
      jobs: [],
      rawResponse: null,
    };
  }
  let parsed: RemotiveApiResponse | null = null;
  try {
    parsed = JSON.parse(res.text) as RemotiveApiResponse;
  } catch (err: any) {
    return {
      ok: false,
      errorCode: 'PARSE_ERROR',
      errorMessage: (err && err.message) || String(err),
      httpStatus: res.status,
      jobs: [],
      rawResponse: null,
    };
  }
  const list = parsed?.jobs ?? [];
  return {
    ok: true,
    errorCode: null,
    errorMessage: null,
    httpStatus: res.status,
    jobs: list.map((j) => remotiveApiJobToRaw(j, fetchedAt)),
    rawResponse: parsed,
  };
}
