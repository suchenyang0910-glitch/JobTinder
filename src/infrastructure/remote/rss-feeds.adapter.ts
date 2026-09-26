import {
  REMOTE_SOURCE_PLATFORM,
  type RemoteRawJob,
  type RemoteSourcePlatform,
} from '@src/domain/remote/remote-entities';
import { safeHttpFetch } from '@src/infrastructure/remote/remote-http-client';

export const DEFAULT_REMOTIVE_RSS_URL = 'https://remotive.com/remote-jobs/feed';
export const DEFAULT_REMOTE_OK_RSS_URL = 'https://remoteok.com/remote-jobs.rss';
export const DEFAULT_REMOTE_OK_API_URL = 'https://remoteok.com/api';

function findText(el: Element | null | undefined, names: string[]): string | null {
  if (!el) return null;
  for (const n of names) {
    const lower = n.toLowerCase();
    const found =
      el.querySelector(`:scope > ${n}`) ||
      Array.from(el.children).find((c) => c.tagName.toLowerCase() === lower);
    if (found && found.textContent) return found.textContent.trim();
  }
  return null;
}

function findAll(el: Element | null | undefined, names: string[]): string[] {
  if (!el) return [];
  const out: string[] = [];
  for (const n of names) {
    const lower = n.toLowerCase();
    const nodes = Array.from(el.querySelectorAll(`:scope > ${n}`)).concat(
      Array.from(el.children).filter((c) => c.tagName.toLowerCase() === lower),
    );
    for (const node of nodes) {
      if (node.textContent && node.textContent.trim()) out.push(node.textContent.trim());
    }
  }
  return Array.from(new Set(out));
}

function findAttr(el: Element | null | undefined, tagNames: string[], attr: string): string | null {
  if (!el) return null;
  for (const n of tagNames) {
    const lower = n.toLowerCase();
    const nodes = Array.from(el.querySelectorAll(`:scope > ${n}`)).concat(
      Array.from(el.children).filter((c) => c.tagName.toLowerCase() === lower),
    );
    for (const node of nodes) {
      const a = node.getAttribute(attr);
      if (a && a.trim()) return a.trim();
    }
  }
  return null;
}

export interface RssItem {
  title: string | null;
  link: string | null;
  guid: string | null;
  pubDate: string | null;
  description: string | null;
  categories: string[];
  extra: Record<string, string | string[]>;
}

export function parseRssItems(xmlText: string): RssItem[] {
  const items: RssItem[] = [];
  // Node.js does not provide DOMParser. Keep the RSS adapter dependency-free
  // and parse the small, trusted RSS envelope while preserving CDATA content.
  const decode = (value: string): string =>
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&amp;/gi, '&')
      .trim();
  const read = (body: string, names: string[]): string | null => {
    for (const name of names) {
      const tag = name.replace(/^.*:/, '');
      const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(body)
        ?? new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(body);
      if (m?.[1]) return decode(m[1]);
    }
    return null;
  };
  const readAll = (body: string, name: string): string[] => {
    const tag = name.replace(/^.*:/, '');
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi');
    const fallback = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
    const values: string[] = [];
    for (const source of [re, fallback]) {
      let m: RegExpExecArray | null;
      while ((m = source.exec(body))) values.push(decode(m[1] ?? ''));
    }
    return Array.from(new Set(values.filter(Boolean)));
  };
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemRe.exec(xmlText))) {
    const body = itemMatch[1] ?? '';
    const extra: Record<string, string | string[]> = {};
    const childRe = /<([\w:-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    let child: RegExpExecArray | null;
    while ((child = childRe.exec(body))) {
      const key = (child[1] ?? '').toLowerCase();
      if (!key || ['title', 'link', 'guid', 'pubdate', 'description', 'category', 'content:encoded'].includes(key)) continue;
      const value = decode(child[2] ?? '');
      if (!value) continue;
      const old = extra[key];
      extra[key] = old == null ? value : Array.isArray(old) ? [...old, value] : [old, value];
    }
    items.push({
      title: read(body, ['title']),
      link: read(body, ['link']) ?? read(body, ['atom:link']),
      guid: read(body, ['guid']),
      pubDate: read(body, ['pubDate', 'pubdate', 'published']),
      description: read(body, ['description', 'content:encoded', 'content']),
      categories: readAll(body, 'category'),
      extra,
    });
  }
  return items;
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function stripHtml(s: string | null): string | null {
  if (!s) return null;
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function rssItemToRaw(
  item: RssItem,
  opts: {
    sourcePlatform: RemoteSourcePlatform;
    feedUrl: string;
    fetchedAt: Date;
    sourceParserType: 'RSS';
    sourceJobIdPrefix: string;
  },
): RemoteRawJob {
  const sourceJobId =
    (item.guid && item.guid.trim()) ||
    (item.link && item.link.trim()) ||
    Math.random().toString(36).slice(2);
  const link = item.link && item.link.trim() ? item.link : opts.feedUrl;
  const description = stripHtml(item.description);
  const publishedAt = parseDate(item.pubDate);
  return {
    sourcePlatform: opts.sourcePlatform,
    sourceParserType: opts.sourceParserType,
    sourceJobId: `${opts.sourceJobIdPrefix}:${sourceJobId}`,
    sourceUrl: link,
    applicationUrl: link,
    title: item.title ? item.title.trim() : null,
    companyName: null,
    descriptionRaw: description,
    salaryMinRaw: null,
    salaryMaxRaw: null,
    salaryCurrency: null,
    salaryTextRaw: null,
    tags: item.categories,
    categories: item.categories,
    locations: [],
    regions: [],
    eligibleCountriesRaw: null,
    allowedCountries: [],
    excludedCountries: [],
    employerCountry: null,
    timezoneRequired: null,
    timezoneOverlapHours: null,
    workAuthRaw: null,
    employmentTypeRaw: null,
    paymentMethodRaw: null,
    remoteScopeRaw: null,
    publishedAt,
    deadlineAt: null,
    lastSeenAt: opts.fetchedAt,
    fetchedAt: opts.fetchedAt,
    rawPayload: item,
  };
}

export async function fetchRssJobs(opts: {
  feedUrl: string;
  sourcePlatform: RemoteSourcePlatform;
  sourceJobIdPrefix: string;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number;
  jobs: RemoteRawJob[];
  xml: string | null;
}> {
  const res = await safeHttpFetch(opts.feedUrl, {
    method: 'GET',
    timeoutMs: opts.timeoutMs ?? 30000,
    accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
  });
  const fetchedAt = new Date();
  if (!res.ok || !res.text) {
    return {
      ok: false,
      errorCode: res.errorCode ?? `HTTP_${res.status}`,
      errorMessage: res.errorMessage ?? `HTTP ${res.status}`,
      httpStatus: res.status,
      jobs: [],
      xml: null,
    };
  }
  const items = parseRssItems(res.text);
  return {
    ok: true,
    errorCode: null,
    errorMessage: null,
    httpStatus: res.status,
    jobs: items.map((it) =>
      rssItemToRaw(it, {
        sourcePlatform: opts.sourcePlatform,
        feedUrl: opts.feedUrl,
        fetchedAt,
        sourceParserType: 'RSS',
        sourceJobIdPrefix: opts.sourceJobIdPrefix,
      }),
    ),
    xml: res.text,
  };
}

export function fetchRemotiveRssJobs(opts?: { feedUrl?: string; timeoutMs?: number }) {
  return fetchRssJobs({
    feedUrl: opts?.feedUrl ?? DEFAULT_REMOTIVE_RSS_URL,
    sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTIVE_RSS,
    sourceJobIdPrefix: 'remotive-rss',
    timeoutMs: opts?.timeoutMs,
  });
}

export function fetchRemoteOkRssJobs(opts?: { feedUrl?: string; timeoutMs?: number }) {
  const rssPromise = fetchRssJobs({
    feedUrl: opts?.feedUrl ?? DEFAULT_REMOTE_OK_RSS_URL,
    sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTE_OK_RSS,
    sourceJobIdPrefix: 'remoteok-rss',
    timeoutMs: opts?.timeoutMs,
  });
  return rssPromise.then(async (rss) => {
    if (rss.ok || rss.httpStatus !== 410) return rss;
    const api = await safeHttpFetch(DEFAULT_REMOTE_OK_API_URL, {
      method: 'GET',
      timeoutMs: opts?.timeoutMs ?? 30000,
      accept: 'application/json, text/plain;q=0.9,*/*;q=0.8',
    });
    if (!api.ok || !api.text) return rss;
    try {
      const rows = JSON.parse(api.text) as Array<Record<string, unknown>>;
      const fetchedAt = new Date();
      const jobs = rows
        .filter((row) => (typeof row.id === 'number' || typeof row.id === 'string') && typeof row.position === 'string')
        .map((row) => {
          const url = typeof row.url === 'string' ? row.url : `https://remoteok.com/remote-jobs/${String(row.id)}`;
          const tags = Array.isArray(row.tags) ? row.tags.map(String) : [];
          const location = typeof row.location === 'string' ? row.location : null;
          return {
            sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTE_OK_RSS,
            sourceParserType: 'API' as const,
            sourceJobId: `remoteok-api:${String(row.id)}`,
            sourceUrl: url,
            applicationUrl: url,
            title: String(row.position),
            companyName: typeof row.company === 'string' ? row.company : null,
            descriptionRaw: typeof row.description === 'string' ? row.description : null,
            salaryMinRaw: null,
            salaryMaxRaw: null,
            salaryCurrency: null,
            salaryTextRaw: typeof row.salary_min === 'number' || typeof row.salary_max === 'number'
              ? `${String(row.salary_min ?? '')}-${String(row.salary_max ?? '')}`
              : null,
            tags,
            categories: tags,
            locations: location ? [location] : [],
            regions: location ? [location] : [],
            eligibleCountriesRaw: location,
            allowedCountries: [],
            excludedCountries: [],
            employerCountry: null,
            timezoneRequired: null,
            timezoneOverlapHours: null,
            workAuthRaw: null,
            employmentTypeRaw: typeof row.job_type === 'string' ? row.job_type : null,
            paymentMethodRaw: null,
            remoteScopeRaw: location,
            publishedAt: typeof row.date === 'string' ? new Date(row.date) : null,
            deadlineAt: null,
            lastSeenAt: fetchedAt,
            fetchedAt,
            rawPayload: row,
          } satisfies RemoteRawJob;
        });
      return { ...rss, ok: true, errorCode: null, errorMessage: null, httpStatus: api.status, jobs, xml: null };
    } catch {
      return rss;
    }
  });
}
