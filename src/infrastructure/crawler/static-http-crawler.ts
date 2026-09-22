import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import { APP_ENV } from '@src/shared/env/app-env';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';

export interface FetchResult {
  url: string;
  httpStatus: number;
  contentType: string | null;
  body: string;
  contentHash: string;
  fetchedAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
  isDuplicate: boolean;
}

export interface RobotsStatus {
  allowed: boolean;
  reason?: string;
  crawlDelayMs?: number;
}

export const USER_AGENT =
  'JobTinderCrawler/1.0 (+https://jobtinder.local/bot-info; contact:bot@jobtinder.local)';
export const PARSER_VERSION = 'static-1.0';

@Injectable()
export class StaticHttpCrawler {
  private readonly logger = new Logger(StaticHttpCrawler.name);
  private lastRequestAtBySource: Map<bigint, number> = new Map();

  private get timeoutMs(): number {
    return APP_ENV.CRAWLER_REQUEST_TIMEOUT_MS;
  }
  private get maxRetries(): number {
    return APP_ENV.CRAWLER_MAX_RETRIES;
  }
  private get minIntervalMs(): number {
    return APP_ENV.CRAWLER_MIN_INTERVAL_MS;
  }
  private get maxIntervalMs(): number {
    return APP_ENV.CRAWLER_MAX_INTERVAL_MS;
  }

  static sha256Hex(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  async checkRobots(baseUrl: string): Promise<RobotsStatus> {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch (e) {
      return { allowed: false, reason: `Invalid base URL: ${String(e)}` };
    }
    const robotsUrl = `${url.protocol}//${url.host}/robots.txt`;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), Math.min(this.timeoutMs, 8000));
      const resp = await fetch(robotsUrl, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain,*/*' },
        signal: ac.signal,
        redirect: 'follow',
      });
      clearTimeout(t);
      if (resp.status === 404)
        return {
          allowed: true,
          reason: 'robots.txt HTTP 404 not found — conservatively allow all',
        };
      // Use the numeric status as the source of truth. Some Fetch-compatible
      // clients (and our test doubles) omit the convenience `ok` property.
      if (resp.status < 200 || resp.status >= 300) {
        return { allowed: true, reason: `robots.txt HTTP ${resp.status} — conservatively allow` };
      }
      const text = await resp.text();
      return this.parseRobotsForUserAgent(text, USER_AGENT, url.pathname || '/jobs');
    } catch (e) {
      return {
        allowed: true,
        reason: `robots.txt unreachable — conservatively allow: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  private parseRobotsForUserAgent(body: string, ua: string, _path: string): RobotsStatus {
    const lines = body.split(/\r?\n/);
    let inOurAgent = false;
    let ourDisallowAll = false;
    let crawlDelayMs: number | undefined;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'user-agent') {
        const normalized = value.toLowerCase();
        inOurAgent =
          normalized === '*' || (normalized.length > 0 && ua.toLowerCase().includes(normalized));
        continue;
      }
      if (key === 'disallow') {
        if (!value || value === '/') {
          if (inOurAgent) ourDisallowAll = true;
        }
        continue;
      }
      if (key === 'allow' && inOurAgent) continue;
      if (key === 'crawl-delay' && inOurAgent) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) crawlDelayMs = Math.round(parsed * 1000);
      }
    }
    if (ourDisallowAll) {
      return { allowed: false, reason: `robots.txt disallows ${ua}`, crawlDelayMs };
    }
    return { allowed: true, crawlDelayMs };
  }

  private async rateLimitFor(sourceId: bigint, crawlDelayMs?: number): Promise<void> {
    const now = Date.now();
    const last = this.lastRequestAtBySource.get(sourceId) ?? 0;
    const baseMin = crawlDelayMs ?? this.minIntervalMs;
    const jitter = randomInt(0, Math.max(1, this.maxIntervalMs - baseMin));
    const next = last + baseMin + jitter;
    if (next > now) {
      const wait = next - now;
      await new Promise<void>((r) => setTimeout(r, wait));
    }
    this.lastRequestAtBySource.set(sourceId, Date.now());
  }

  async fetchPage(params: {
    sourceId: bigint;
    url: string;
    knownHashes?: Set<string>;
    crawlDelayMs?: number;
  }): Promise<FetchResult> {
    const { sourceId, url, knownHashes, crawlDelayMs } = params;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.rateLimitFor(sourceId, crawlDelayMs);
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const resp = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml,*/*',
          },
          signal: ac.signal,
          redirect: 'follow',
        });
        clearTimeout(t);
        const status = resp.status;
        const contentType = resp.headers.get('content-type');
        if (status === 429 || status === 403) {
          const code = status === 429 ? 'HTTP_429' : 'HTTP_403';
          if (attempt < this.maxRetries && status === 429) {
            await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
            continue;
          }
          const err = new AppError({
            code: AppErrorCode.CRAWL_RATE_LIMITED,
            message: `Crawling blocked: HTTP ${status} for ${url}`,
            metadata: { url, status },
          });
          return this.buildErrorResult(url, status, contentType ?? null, code, err.message);
        }
        if (status >= 500) {
          if (attempt < this.maxRetries) {
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
            continue;
          }
          return this.buildErrorResult(
            url,
            status,
            contentType || null,
            `HTTP_${status}`,
            `Server error HTTP ${status}`,
          );
        }
        if (status >= 400) {
          return this.buildErrorResult(
            url,
            status,
            contentType || null,
            `HTTP_${status}`,
            `Client error HTTP ${status}`,
          );
        }
        const body = await resp.text();
        const hash = StaticHttpCrawler.sha256Hex(body);
        const isDuplicate = !!knownHashes?.has(hash);
        return {
          url,
          httpStatus: status,
          contentType: contentType || null,
          body,
          contentHash: hash,
          fetchedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          isDuplicate,
        };
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        const code = e instanceof Error && e.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_ERROR';
        return this.buildErrorResult(url, 0, null, code, msg);
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : 'Unknown fetch error';
    return this.buildErrorResult(url, 0, null, 'FETCH_ERROR', msg);
  }

  private buildErrorResult(
    url: string,
    httpStatus: number,
    contentType: string | null,
    errorCode: string,
    errorMessage: string,
  ): FetchResult {
    return {
      url,
      httpStatus,
      contentType,
      body: '',
      contentHash: StaticHttpCrawler.sha256Hex(`${httpStatus}|${errorCode}|${errorMessage}|EMPTY`),
      fetchedAt: new Date(),
      errorCode,
      errorMessage,
      isDuplicate: false,
    };
  }

  extractTextFromHtml(html: string): string {
    if (!html) return '';
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(0, 20000);
  }

  discoverJobLinks(html: string, baseUrl: string): string[] {
    const anchors = html.match(/<a[^>]+href=["']([^"']+)["']/gi) ?? [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const a of anchors) {
      const m = /href=["']([^"']+)["']/i.exec(a);
      if (!m) continue;
      const raw = (m[1] ?? '').trim();
      if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:'))
        continue;
      let resolved: string;
      try {
        resolved = new URL(raw, baseUrl).toString();
      } catch {
        continue;
      }
      if (
        !/(jobs?|careers?|vacanc\w*|position|kh|en|zh)[/?-]/i.test(resolved) &&
        !/\/p\d+\.html/i.test(resolved)
      )
        continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push(resolved);
    }
    return out.slice(0, APP_ENV.CRAWLER_DAILY_PAGE_LIMIT_PER_SOURCE);
  }
}
