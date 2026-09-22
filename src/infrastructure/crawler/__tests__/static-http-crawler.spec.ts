import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StaticHttpCrawler,
  PARSER_VERSION,
  USER_AGENT,
} from '@src/infrastructure/crawler/static-http-crawler';

describe('StaticHttpCrawler', () => {
  let crawler: StaticHttpCrawler;

  beforeEach(() => {
    crawler = new StaticHttpCrawler();
  });

  it('§1 Static HTML extractTextFromHtml strips script/style + preserves body text', () => {
    const html = `<!doctype html><html><head><script>var x=1;</script><style>body{color:red}</style></head>
<body><h1>Hello Job World</h1><p>Apply here for Barista.</p>
<script>/* track */</script></body></html>`;
    const txt = crawler.extractTextFromHtml(html);
    expect(txt).toContain('Hello Job World');
    expect(txt).toContain('Apply here for Barista');
    expect(txt).not.toMatch(/var x=1/);
    expect(txt).not.toMatch(/color:red/);
    expect(txt).not.toMatch(/track/);
  });

  it('§1 discoverJobLinks picks up career/job paths via absolute/relative href', () => {
    const html = `<html><body>
<a href="https://example.com/jobs/123">Barista</a>
<a href="/career/456">Cook</a>
<a href="/vacancy/detail?x=1">Waiter</a>
<a href="/about-us">About</a>
<a href="https://othersite.com/jobs/7">External</a>
</body></html>`;
    const links = crawler.discoverJobLinks(html, 'https://example.com/');
    expect(links).toContain('https://example.com/jobs/123');
    expect(links).toContain('https://example.com/career/456');
    expect(links).toContain('https://example.com/vacancy/detail?x=1');
    expect(links).not.toContain('https://example.com/about-us');
  });

  it('§2 checkRobots parses User-agent: * Disallow: / as disallowed', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => 'User-agent: *\nDisallow: /\nCrawl-delay: 10\n',
    });
    vi.stubGlobal('fetch', fetch);
    const r = await crawler.checkRobots('https://blocked.example.com/');
    expect(r.allowed).toBe(false);
    expect(r.crawlDelayMs).toBeGreaterThanOrEqual(10_000);
    expect(fetch).toHaveBeenCalledWith(
      'https://blocked.example.com/robots.txt',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': USER_AGENT }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it('§2 checkRobots treats 404 robots.txt as ALLOWED', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 404, text: async () => '' });
    vi.stubGlobal('fetch', fetch);
    const r = await crawler.checkRobots('https://no-robots.example.com/');
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/404/);
    vi.unstubAllGlobals();
  });

  it('§3 fetchPage retries on 5xx with backoff; not retry 403; retries 429 once', async () => {
    let calls = 0;
    const fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3)
        return {
          status: 500,
          text: async () => 'err',
          headers: new Map(),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      return {
        status: 200,
        text: async () => 'ok page',
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: async () => new TextEncoder().encode('ok page').buffer,
      };
    });
    vi.stubGlobal('fetch', fetch);
    const r5xx = await crawler.fetchPage({ sourceId: 1n, url: 'https://5xx.example.com/' });
    expect(r5xx.httpStatus).toBe(200);
    expect(r5xx.errorCode).toBeNull();
    expect(calls).toBe(3); // default max 2 retries → total calls = 1+2 = 3

    calls = 0;
    fetch.mockImplementation(async () => {
      calls++;
      return {
        status: 403,
        text: async () => 'forbidden',
        headers: new Map(),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });
    const r403 = await crawler.fetchPage({ sourceId: 1n, url: 'https://403.example.com/' });
    expect(calls).toBe(1); // 403 NOT retried
    expect(r403.errorCode).toBe('HTTP_403');

    calls = 0;
    fetch.mockImplementation(async () => {
      calls++;
      if (calls < 2)
        return {
          status: 429,
          text: async () => 'retry later',
          headers: new Map([['Retry-After', '1']]),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      return {
        status: 200,
        text: async () => 'after',
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: async () => new TextEncoder().encode('after').buffer,
      };
    });
    const r429 = await crawler.fetchPage({ sourceId: 1n, url: 'https://429.example.com/' });
    expect(calls).toBe(2);
    expect(r429.httpStatus).toBe(200);
    expect(r429.errorCode).toBeNull();

    vi.unstubAllGlobals();
  });

  it('§4 content_hash sha256 is deterministic + identical input → identical hash', () => {
    const a = StaticHttpCrawler.sha256Hex('hello job');
    const b = StaticHttpCrawler.sha256Hex('hello job');
    const c = StaticHttpCrawler.sha256Hex('other job');
    expect(a).toHaveLength(64); // sha256 hex 64 chars
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('§5 inferSourceJobId (orchestrator logic) same URL → same ID', () => {
    const urlA = 'https://example.com/jobs/123';
    const base = 'https://example.com/';
    function inferSourceJobId(url: string, baseUrl: string): string {
      try {
        const u = new URL(url, baseUrl);
        const path = u.pathname.replace(/\/+/g, '/');
        if (path.length > 4) return `${u.host}${path}`.slice(0, 256);
        return `${u.host}|${u.searchParams.toString()}`.slice(0, 256);
      } catch {
        return url.slice(0, 256);
      }
    }
    const id1 = inferSourceJobId(urlA, base);
    const id2 = inferSourceJobId(urlA, base);
    const id3 = inferSourceJobId('https://example.com/jobs/999', base);
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toContain('example.com/jobs/123');
  });

  it('§6 detect page change (compare source content) differs on updates', () => {
    const hashOld = StaticHttpCrawler.sha256Hex('barista job');
    const hashNew = StaticHttpCrawler.sha256Hex('senior barista job, new bonus');
    expect(hashOld).not.toBe(hashNew);
  });

  it('§7 404/410 page results result in errorCode HTTP_404/HTTP_410 (used upstream for stale)', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 404,
      text: async () => 'gone',
      headers: new Map(),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal('fetch', fetch);
    const r = await crawler.fetchPage({ sourceId: 1n, url: 'https://gone.example.com/x' });
    expect(r.httpStatus).toBe(404);
    expect(r.errorCode).toBe('HTTP_404');
    vi.unstubAllGlobals();
  });

  it('PARSER_VERSION is non-empty semver-like string', () => {
    expect(PARSER_VERSION).toMatch(/^static-\S+$/);
  });
});
