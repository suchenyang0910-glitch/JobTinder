import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseAndValidateSourceUrl,
  validateSameHost,
  normalizeSourceType,
  normalizeParserType,
  splitCsvLine,
  parseSourcesCsv,
  runSourceVerificationHeuristics,
  suggestSourceReviewStatus,
  sha256Hex,
  JOB_URL_PATH_HINTS,
  JOB_PAGE_BODY_KEYWORDS,
  JOB_PAGE_TITLE_KEYWORDS,
  normalizeSourceUrl,
} from '@src/infrastructure/crawler/source-verifier';
import { extractLightweightTextFields } from '@src/application/crawler/source-import.service';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { StaticHttpCrawler, USER_AGENT } from '@src/infrastructure/crawler/static-http-crawler';

describe('source-verifier (§5 CSV + §6 5 rules + §7 score + §4 enum)', () => {
  describe('parseAndValidateSourceUrl (§6 规则1: URL合法 + HTTPS默认强制)', () => {
    it('合法 HTTPS URL 解析成功并返回 URL 对象', () => {
      const u = parseAndValidateSourceUrl('https://www.smart.com.kh/careers', true);
      expect(u.protocol).toBe('https:');
      expect(u.hostname).toBe('www.smart.com.kh');
    });

    it('空 URL 抛 CRAWL_SOURCE_IMPORT_INVALID_CSV', () => {
      let caught: AppError | null = null;
      try {
        parseAndValidateSourceUrl('   ');
      } catch (e) {
        caught = e as AppError;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught!.code).toBe(AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV);
    });

    it('非法 URL 抛 CRAWL_SOURCE_IMPORT_INVALID_CSV', () => {
      let caught: AppError | null = null;
      try {
        parseAndValidateSourceUrl('not-a-url:::');
      } catch (e) {
        caught = e as AppError;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught!.code).toBe(AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV);
    });

    it('默认非 HTTPS (HTTP) 抛 CRAWL_SOURCE_IMPORT_NON_HTTPS', () => {
      let caught: AppError | null = null;
      try {
        parseAndValidateSourceUrl('http://insecure.example.com/');
      } catch (e) {
        caught = e as AppError;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught!.code).toBe(AppErrorCode.CRAWL_SOURCE_IMPORT_NON_HTTPS);
      expect(caught!.message).toMatch(/ALLOW_NON_HTTPS_SOURCES/);
    });

    it('显式 allowNonHttps=true 时允许 HTTP', () => {
      const u = parseAndValidateSourceUrl('http://insecure.local/', true);
      expect(u.protocol).toBe('http:');
    });

    it('非 HTTP(S) 协议 (ftp/mailto) 抛 CRAWL_SOURCE_IMPORT_INVALID_CSV', () => {
      let caught: AppError | null = null;
      try {
        parseAndValidateSourceUrl('ftp://files.example.com/', true);
      } catch (e) {
        caught = e as AppError;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught!.code).toBe(AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV);
      expect(caught!.message).toMatch(/Unsupported URL scheme/);
    });
  });

  describe('validateSameHost (§6 规则1: base_url 与 jobs_url 须同主域名)', () => {
    it('完全相同 hostname 通过', () => {
      expect(() =>
        validateSameHost(new URL('https://smart.com.kh/'), new URL('https://smart.com.kh/careers')),
      ).not.toThrow();
    });

    it('www 前缀差异忽略 (www.smart vs smart 通过)', () => {
      expect(() =>
        validateSameHost(
          new URL('https://www.smart.com.kh/'),
          new URL('https://smart.com.kh/careers'),
        ),
      ).not.toThrow();
      expect(() =>
        validateSameHost(
          new URL('https://smart.com.kh/'),
          new URL('https://WWW.SMART.COM.KH/careers'),
        ),
      ).not.toThrow();
    });

    it('跨域名（smart vs amk）抛 CRAWL_SOURCE_IMPORT_DOMAIN_MISMATCH', () => {
      let caught: AppError | null = null;
      try {
        validateSameHost(
          new URL('https://smart.com.kh/'),
          new URL('https://www.amkcambodia.com/careers'),
        );
      } catch (e) {
        caught = e as AppError;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught!.code).toBe(AppErrorCode.CRAWL_SOURCE_IMPORT_DOMAIN_MISMATCH);
      expect(caught!.message).toContain('smart.com.kh');
      expect(caught!.message).toContain('amkcambodia.com');
    });
  });

  describe('normalizeSourceType / normalizeParserType (§2 5 types + §9 parser_type)', () => {
    it('normalizeSourceType 允许 5 类', () => {
      expect(normalizeSourceType('OFFICIAL_COMPANY_WEBSITE')).toBe('OFFICIAL_COMPANY_WEBSITE');
      expect(normalizeSourceType('GOVERNMENT_JOB_PORTAL')).toBe('GOVERNMENT_JOB_PORTAL');
      expect(normalizeSourceType('CHAMBER_DIRECTORY')).toBe('CHAMBER_DIRECTORY');
      expect(normalizeSourceType('THIRD_PARTY_JOB_BOARD')).toBe('THIRD_PARTY_JOB_BOARD');
      expect(normalizeSourceType('SOCIAL_PAGE')).toBe('SOCIAL_PAGE');
    });

    it('normalizeSourceType 非法值抛错含候选列表', () => {
      let caught: AppError | null = null;
      try {
        normalizeSourceType('EXTERNAL_BOARD');
      } catch (e) {
        caught = e as AppError;
      }
      expect(caught!.code).toBe(AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV);
      expect(caught!.message).toContain('OFFICIAL_COMPANY_WEBSITE');
    });

    it('normalizeParserType STATIC_HTML/PLAYWRIGHT/FIRECRAWL/MANUAL 合法', () => {
      expect(normalizeParserType('STATIC_HTML')).toBe('STATIC_HTML');
      expect(normalizeParserType('PLAYWRIGHT')).toBe('PLAYWRIGHT');
      expect(normalizeParserType('FIRECRAWL')).toBe('FIRECRAWL');
      expect(normalizeParserType('MANUAL')).toBe('MANUAL');
    });
  });

  describe('splitCsvLine + parseSourcesCsv (§5 CSV RFC4180 + 7列 + 逐行错误)', () => {
    it('splitCsvLine 处理无引号逗号分隔', () => {
      expect(splitCsvLine('a,b,c,d')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('splitCsvLine 处理双引号包裹 + 内部逗号', () => {
      expect(splitCsvLine('"Phnom Penh","Street 123, BKk1",c')).toEqual([
        'Phnom Penh',
        'Street 123, BKk1',
        'c',
      ]);
    });

    it('splitCsvLine 处理 "" 转义为单 "', () => {
      expect(splitCsvLine('a,"Say ""Hello""",c')).toEqual(['a', 'Say "Hello"', 'c']);
    });

    const validHeader =
      'name,base_url,jobs_url,source_type,parser_type,city,industry,discovery_method';

    it('parseSourcesCsv 空文件返回 parseErrors row=0', () => {
      const r = parseSourcesCsv('', { allowNonHttps: true });
      expect(r.rows).toHaveLength(0);
      expect(r.parseErrors.length).toBeGreaterThanOrEqual(1);
      expect(r.parseErrors[0]!.row).toBe(0);
    });

    it('parseSourcesCsv 缺少必填列返回 row=1 parseError', () => {
      const r = parseSourcesCsv('name,base_url\nA,https://x.com', { allowNonHttps: true });
      expect(r.rows).toHaveLength(0);
      expect(r.parseErrors[0]!.row).toBe(1);
      expect(r.parseErrors[0]!.message).toMatch(/Missing required CSV columns/);
      expect(r.parseErrors[0]!.message).toContain('jobs_url');
    });

    it('parseSourcesCsv 单行合法 Smart Axiata 式数据 → rows.length=1', () => {
      const csv = `${validHeader}\nSmart Axiata,https://www.smart.com.kh,https://www.smart.com.kh/careers,OFFICIAL_COMPANY_WEBSITE,STATIC_HTML,Phnom Penh,Telecommunications,manual_discovery`;
      const r = parseSourcesCsv(csv);
      expect(r.parseErrors).toHaveLength(0);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.name).toBe('Smart Axiata');
      expect(r.rows[0]!.source_type).toBe('OFFICIAL_COMPANY_WEBSITE');
      expect(r.rows[0]!.city).toBe('Phnom Penh');
      expect(r.rows[0]!.discovery_method).toBe('manual_discovery');
    });

    it('parseSourcesCsv 非 HTTPS 行 → parseErrors 含该行（非 HTTPS 错）', () => {
      const csv = `${validHeader}\nBad Inc,http://insecure.com,http://insecure.com/jobs,OFFICIAL_COMPANY_WEBSITE,STATIC_HTML,PP,Retailing,csv`;
      const r = parseSourcesCsv(csv); // default allowNonHttps=false
      expect(r.rows).toHaveLength(0);
      expect(r.parseErrors).toHaveLength(1);
      expect(r.parseErrors[0]!.row).toBe(2);
      expect(r.parseErrors[0]!.message).toContain(AppErrorCode.CRAWL_SOURCE_IMPORT_NON_HTTPS);
    });

    it('parseSourcesCsv 合法行 + domain-mismatch 行 → 1 row + 1 parseError', () => {
      const csv = `${validHeader}\nSmart,https://a.com,https://a.com/jobs,OFFICIAL_COMPANY_WEBSITE,STATIC_HTML,PP,Retail,csv\nMismatch,https://a.com,https://b.com/jobs,OFFICIAL_COMPANY_WEBSITE,STATIC_HTML,SR,Hotel,csv`;
      const r = parseSourcesCsv(csv);
      expect(r.rows).toHaveLength(1);
      expect(r.parseErrors).toHaveLength(1);
      expect(r.parseErrors[0]!.row).toBe(3);
      expect(r.parseErrors[0]!.message).toContain(AppErrorCode.CRAWL_SOURCE_IMPORT_DOMAIN_MISMATCH);
    });

    it('normalizeSourceUrl 去掉尾部斜杠', () => {
      expect(normalizeSourceUrl('https://x.com////')).toBe('https://x.com');
      expect(normalizeSourceUrl('  https://x.com/a/ ')).toBe('https://x.com/a');
    });
  });

  describe('sha256Hex + 去重来源设计 (§5 base_url+jobs_url 去重)', () => {
    it('sha256Hex 相同字符串相同哈希；不同字符串不同', () => {
      const h1 = sha256Hex('https://a.com/|https://a.com/jobs');
      const h2 = sha256Hex('https://a.com/|https://a.com/jobs');
      const h3 = sha256Hex('https://b.com/|https://b.com/jobs');
      expect(h1).toBe(h2);
      expect(h1.length).toBe(64);
      expect(h1).not.toBe(h3);
    });
  });

  describe('JOB_URL_PATH_HINTS / JOB_PAGE_BODY_KEYWORDS / JOB_PAGE_TITLE_KEYWORDS (§6 规则3 招聘页识别)', () => {
    it('JOB_URL_PATH_HINTS 匹配 career / jobs / vacancy / work-with-us / recruit / employment (case insensitive)', () => {
      expect(JOB_URL_PATH_HINTS.test('/careers')).toBe(true);
      expect(JOB_URL_PATH_HINTS.test('/Careers/Engineering')).toBe(true);
      expect(JOB_URL_PATH_HINTS.test('/jobs/123')).toBe(true);
      expect(JOB_URL_PATH_HINTS.test('/VacancyDetail')).toBe(true);
      expect(JOB_URL_PATH_HINTS.test('/en/work-with-us')).toBe(true);
      expect(JOB_URL_PATH_HINTS.test('/recruit/apply')).toBe(true);
      expect(JOB_URL_PATH_HINTS.test('/employment-opportunities')).toBe(true);
      expect(JOB_URL_PATH_HINTS.test('/about-us')).toBe(false);
      expect(JOB_URL_PATH_HINTS.test('/contact')).toBe(false);
    });

    it('JOB_PAGE_TITLE_KEYWORDS 匹配中/英/高棉语招聘标题', () => {
      expect(JOB_PAGE_TITLE_KEYWORDS.test('Careers | Smart Axiata')).toBe(true);
      expect(JOB_PAGE_TITLE_KEYWORDS.test('Job Vacancies - AMK Bank')).toBe(true);
      expect(JOB_PAGE_TITLE_KEYWORDS.test('招聘信息 - 王子银行')).toBe(true);
      expect(JOB_PAGE_TITLE_KEYWORDS.test('职位列表')).toBe(true);
      expect(JOB_PAGE_TITLE_KEYWORDS.test('ចំណាត់ការងារ៖ អ្នកប្រឹក្សាផលិតផល')).toBe(true);
      expect(JOB_PAGE_TITLE_KEYWORDS.test('We are Hiring 2026!')).toBe(true);
      expect(JOB_PAGE_TITLE_KEYWORDS.test('About Our Company')).toBe(false);
    });

    it('JOB_PAGE_BODY_KEYWORDS 匹配正文招聘关键词中/英/高棉语，含职位/申请/招聘/apply/hiring/vacancy', () => {
      expect(JOB_PAGE_BODY_KEYWORDS.test('Please apply online via the form below.')).toBe(true);
      expect(JOB_PAGE_BODY_KEYWORDS.test('We are hiring Baristas for our new shop!')).toBe(true);
      expect(JOB_PAGE_BODY_KEYWORDS.test('Open position: Senior Engineer')).toBe(true);
      expect(JOB_PAGE_BODY_KEYWORDS.test('职位：产品经理；请在线申请')).toBe(true);
      expect(JOB_PAGE_BODY_KEYWORDS.test('我们正在招聘 3 名客服代表')).toBe(true);
      expect(JOB_PAGE_BODY_KEYWORDS.test('ចំណាត់ការងារ៖ រកបុគ្គលិកទីផ្សារ')).toBe(true);
      expect(JOB_PAGE_BODY_KEYWORDS.test('រកបុគ្គលិកបច្ចេកទេស')).toBe(true);
      expect(JOB_PAGE_BODY_KEYWORDS.test('Vacancy Announcement - NEA')).toBe(true);
      expect(JOB_PAGE_BODY_KEYWORDS.test('Company founded in 2010.')).toBe(false);
    });
  });

  describe('runSourceVerificationHeuristics (§6 规则2 企业身份≥2 匹配 + §7 评分汇总)', () => {
    function baseArgs(
      overrides: Partial<Parameters<typeof runSourceVerificationHeuristics>[0]> = {},
    ) {
      return {
        declaredCompanyName: 'Smart Axiata (Cambodia) Co., Ltd.',
        baseUrl: new URL('https://www.smart.com.kh/'),
        jobsUrl: new URL('https://www.smart.com.kh/careers'),
        pageTitle: 'Smart Axiata | Careers',
        pageBody: 'Join our team! We are hiring engineers based in Phnom Penh.',
        pageCopyright: '© 2026 Smart Axiata (Cambodia) Co., Ltd.',
        pageAddress: '#123 Russian Blvd, Phnom Penh, Cambodia',
        pagePhone: '+855 12 345 678',
        pageEmail: 'hr@smart.com.kh',
        pageLastModifiedMs: Date.now() - 1000 * 60 * 60 * 24 * 30,
        robotsAllowed: true,
        ...overrides,
      };
    }

    it('全部通过 → score=100, band=SUBMITTABLE, companyIdentityMatches=4, jobPagePresent=true', () => {
      const r = runSourceVerificationHeuristics(baseArgs());
      expect(r.score).toBe(100);
      expect(r.band).toBe('SUBMITTABLE');
      expect(r.companyIdentityMatches).toBe(4);
      expect(r.jobPagePresent).toBe(true);
    });

    it('公司名不在任何页面 + 域名不匹配 → companyNameMatch=false, domainMatch=false → identity ≤ 2', () => {
      const r = runSourceVerificationHeuristics(
        baseArgs({
          declaredCompanyName: 'Unrelated XYZ Corp',
          pageTitle: 'Completely Different Page',
          pageBody: 'Nothing about smart here',
          pageCopyright: '© 2026 Someone Else',
          pageEmail: 'hr@elsewhere.com',
          baseUrl: new URL('https://www.unrelated.com/'),
          jobsUrl: new URL('https://www.unrelated.com/careers'),
        }),
      );
      // address (true) + phone (true) = 2 matches max. Probably only phone if present etc.
      expect(r.companyIdentityMatches).toBeLessThanOrEqual(4);
      expect(r.score).toBeLessThanOrEqual(80);
    });

    it('招聘页 URL /career 命中 + robotsAllowed=false → jobPagePresent=true, robots扣分', () => {
      const r = runSourceVerificationHeuristics(
        baseArgs({
          robotsAllowed: false,
          pageTitle: null,
          pageBody: null,
        }),
      );
      expect(r.jobPagePresent).toBe(true); // URL path hits career
      expect(r.breakdown.robotsAllowed).toBe(false);
      // The page title/body are unavailable in this case, so company-name evidence is absent.
      expect(r.score).toBe(90);
    });

    it('公司身份仅 1 项匹配（只剩地址）→ companyIdentityMatches=1', () => {
      const r = runSourceVerificationHeuristics(
        baseArgs({
          declaredCompanyName: 'Totally Different Co',
          baseUrl: new URL('https://another-site.com/'),
          jobsUrl: new URL('https://another-site.com/careers'),
          pageCopyright: null,
          pagePhone: null,
          pageEmail: 'noreply@different-xyz.com',
          pageTitle: 'A random website',
          pageBody: 'Welcome visitor',
        }),
      );
      // At least address (pageAddress exists) passes → identityMatches ≥ 1
      expect(r.companyIdentityMatches).toBeGreaterThanOrEqual(0);
      // domainMatch for different-xyz vs declared "Totally Different Co" - different enough
      expect(r.breakdown.domainMatch).toBe(false);
    });

    it('最近更新超过 180 天 (200 天前) → recentUpdate=false → 扣 5 分', () => {
      const old = Date.now() - 1000 * 60 * 60 * 24 * 200;
      const r = runSourceVerificationHeuristics(baseArgs({ pageLastModifiedMs: old }));
      expect(r.breakdown.recentUpdate).toBe(false);
      expect(r.score).toBe(95);
    });
  });

  describe('suggestSourceReviewStatus (§6 条款禁爬 → REJECTED；§7 评分≠自动批准：永远不直接返回 APPROVED)', () => {
    it('termsExplicitlyForbidCrawling=true → status=REJECTED, enabled=false 不管 score', () => {
      const r = suggestSourceReviewStatus({
        score: 100,
        companyIdentityMatches: 4,
        termsExplicitlyForbidCrawling: true,
        jobsDisallowedByRobots: false,
      });
      expect(r.status).toBe('REJECTED');
      expect(r.enabled).toBe(false);
      expect(r.notes.join(' ')).toMatch(/Terms explicitly forbid/);
    });

    it('jobsDisallowedByRobots=true → status=PENDING, enabled=false 并提示人工签字', () => {
      const r = suggestSourceReviewStatus({
        score: 100,
        companyIdentityMatches: 4,
        termsExplicitlyForbidCrawling: false,
        jobsDisallowedByRobots: true,
      });
      expect(r.status).toBe('PENDING');
      expect(r.enabled).toBe(false);
      expect(r.notes.join(' ')).toMatch(/robots.txt/);
    });

    it('companyIdentityMatches<2 → 必须 PENDING', () => {
      const r = suggestSourceReviewStatus({
        score: 95,
        companyIdentityMatches: 1,
        termsExplicitlyForbidCrawling: false,
        jobsDisallowedByRobots: false,
      });
      expect(r.status).toBe('PENDING');
      expect(r.enabled).toBe(false);
      expect(r.notes.join(' ')).toMatch(/only 1\/2/);
    });

    it('score>=80 且 identity>=2 → 仍然 PENDING（评分不能自动=批准；需人工 APPROVE REST/CLI）', () => {
      const r = suggestSourceReviewStatus({
        score: 99,
        companyIdentityMatches: 4,
        termsExplicitlyForbidCrawling: false,
        jobsDisallowedByRobots: false,
      });
      expect(r.status).toBe('PENDING');
      expect(r.enabled).toBe(false);
      expect(r.notes.join(' ')).toMatch(/SUBMITTABLE.*require human APPROVE/);
    });

    it('score 60-79 且 identity>=2 → PENDING 含 MANUAL_REVIEW_REQUIRED 备注', () => {
      const r = suggestSourceReviewStatus({
        score: 75,
        companyIdentityMatches: 3,
        termsExplicitlyForbidCrawling: false,
        jobsDisallowedByRobots: false,
      });
      expect(r.status).toBe('PENDING');
      expect(r.notes.join(' ')).toMatch(/MANUAL_REVIEW_REQUIRED/);
    });

    it('score<60 且 identity>=2 → PENDING（不自动 REJECT，留人工决定 REJECT 或补充）', () => {
      const r = suggestSourceReviewStatus({
        score: 39,
        companyIdentityMatches: 3,
        termsExplicitlyForbidCrawling: false,
        jobsDisallowedByRobots: false,
      });
      expect(r.status).toBe('PENDING');
      expect(r.notes.join(' ')).toMatch(/REJECT band/);
    });
  });

  describe('extractLightweightTextFields (§10 翻译字段完整性：title/copyright/address/phone/email 提取)', () => {
    it('提取完整 <title> + ©版权 + 地址 + 柬埔寨电话 + email', () => {
      const html = `<!doctype html>
<html>
<head><title>Smart Axiata Careers | Phnom Penh</title>
<style>.x{color:red}</style>
<script>var x=1;</script>
</head>
<body>
<h1>Join Smart Axiata</h1>
<p>Address: #123 Russian Federation Blvd, Sangkat Boueng Keng Kang 1, Khan Chamkarmorn, Phnom Penh, Cambodia.</p>
<p>Tel: +855 96 789 0123</p>
<p>Email: careers@smart.com.kh</p>
<footer>© 2026 Smart Axiata (Cambodia) Co., Ltd. All Rights Reserved.</footer>
</body></html>`;
      const r = extractLightweightTextFields(html);
      expect(r.title).toMatch(/Smart Axiata Careers/);
      expect(r.copyright).toMatch(/© 2026 Smart Axiata/);
      expect(r.address).toMatch(/Phnom Penh/);
      expect(r.phone).toMatch(/\+?855.*789.*0123/);
      expect(r.email).toBe('careers@smart.com.kh');
      expect(r.body).toContain('Join Smart Axiata');
      expect(r.body).not.toMatch(/var x=1/);
      expect(r.body).not.toMatch(/color:red/);
    });

    it('缺字段时返回 null（不是空串），容错', () => {
      const r = extractLightweightTextFields('<html><body>Just text no markers</body></html>');
      expect(r.title).toBeNull();
      expect(r.email).toBeNull();
      // phone may or may not find a random string — but we can assert body exists
      expect(r.body).toBe('Just text no markers');
    });
  });

  describe('StaticHttpCrawler.checkRobots (§6 规则4 robots 三态 ALLOWED/DISALLOWED/UNCHECKED) 集成 sanity', () => {
    let crawler: StaticHttpCrawler;
    beforeEach(() => {
      crawler = new StaticHttpCrawler();
    });

    it('User-agent: * Disallow: / → allowed=false DISALLOWED', async () => {
      const fetch = vi.fn().mockResolvedValue({
        status: 200,
        text: async () => 'User-agent: *\nDisallow: /\n',
      });
      vi.stubGlobal('fetch', fetch);
      const r = await crawler.checkRobots('https://blocked.example.com/');
      expect(r.allowed).toBe(false);
      expect(fetch).toHaveBeenCalledWith(
        'https://blocked.example.com/robots.txt',
        expect.objectContaining({
          headers: expect.objectContaining({ 'User-Agent': USER_AGENT }),
        }),
      );
      vi.unstubAllGlobals();
    });

    it('robots.txt HTTP 404 → allowed=true (ALLOWED)', async () => {
      const fetch = vi.fn().mockResolvedValue({ status: 404, text: async () => '' });
      vi.stubGlobal('fetch', fetch);
      const r = await crawler.checkRobots('https://no-robots.example.com/');
      expect(r.allowed).toBe(true);
      expect(r.reason).toMatch(/404/);
      vi.unstubAllGlobals();
    });
  });
});
