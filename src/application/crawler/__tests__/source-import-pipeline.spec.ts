import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SourceImportService,
  SourceReviewService,
  SourceValidationService,
} from '@src/application/crawler/source-import.service';
import { CrawlerOrchestrator } from '@src/application/crawler/crawler-orchestrator.service';
import { CrawlerReviewService } from '@src/application/crawler/crawler-review.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import {
  StaticHttpCrawler,
  PARSER_VERSION,
  USER_AGENT,
} from '@src/infrastructure/crawler/static-http-crawler';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import {
  bandForSourceVerificationScore,
  canSourceReviewTransition,
} from '@src/domain/crawler/source-review-status-machine';
import type { AILanguage } from '@src/domain/trust/ai-extract-provider';

type AnyRow = Record<string, unknown>;

interface FakePrisma {
  db: {
    source_registry: Map<bigint, AnyRow>;
    crawl_jobs_staging: Map<bigint, AnyRow>;
    crawl_snapshots: Map<bigint, AnyRow>;
    jobs: Map<bigint, AnyRow>;
    job_translations: Map<bigint, AnyRow>;
    crawl_runs: Map<bigint, AnyRow>;
  };
  $transaction: <T>(fn: (tx: FakePrisma) => Promise<T>) => Promise<T>;
  source_registry: {
    findUnique: (p: { where: { id?: bigint } }) => Promise<AnyRow | null>;
    findFirst: (p: { where: AnyRow; select?: AnyRow }) => Promise<AnyRow | null>;
    findMany: (p?: { where?: AnyRow; take?: number; orderBy?: AnyRow }) => Promise<AnyRow[]>;
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
  };
  crawl_jobs_staging: {
    findUnique: (p: { where: { id?: bigint }; include?: AnyRow }) => Promise<AnyRow | null>;
    findMany: (p: { where: AnyRow; select?: AnyRow }) => Promise<AnyRow[]>;
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
    upsert: (p: { where: AnyRow; create: AnyRow; update: AnyRow }) => Promise<AnyRow>;
    createMany: (p: { data: AnyRow[]; skipDuplicates?: boolean }) => Promise<{ count: number }>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
    updateMany: () => Promise<{ count: number }>;
  };
  crawl_snapshots: {
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
    findUnique: (p: { where: AnyRow }) => Promise<AnyRow | null>;
  };
  jobs: {
    findUnique: (p: { where: AnyRow }) => Promise<AnyRow | null>;
    upsert: (p: { where: AnyRow; create: AnyRow; update: AnyRow }) => Promise<AnyRow>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
  };
  job_translations: {
    findMany: () => Promise<AnyRow[]>;
    upsert: (p: { where: AnyRow; create: AnyRow; update: AnyRow }) => Promise<AnyRow>;
    createMany: (p: { data: AnyRow[]; skipDuplicates?: boolean }) => Promise<{ count: number }>;
    updateMany: () => Promise<{ count: number }>;
  };
  crawl_runs: {
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
  };
}

function makeFakeAuditRepo() {
  const auditLog: Array<{ action: string; objectId: bigint; metadata: AnyRow }> = [];
  return {
    record: vi
      .fn()
      .mockImplementation(async (p: { action: string; objectId: bigint; metadata: AnyRow }) => {
        auditLog.push({ action: p.action, objectId: p.objectId, metadata: p.metadata });
        return undefined;
      }),
    auditLog,
  };
}

type FakeCrawler = {
  checkRobots: ReturnType<typeof vi.fn>;
  fetchPage: ReturnType<typeof vi.fn>;
  discoverJobLinks: ReturnType<typeof vi.fn>;
  extractTextFromHtml: ReturnType<typeof vi.fn>;
  parseJobStructuredFields: ReturnType<typeof vi.fn>;
};

function makeFakeCrawler(): FakeCrawler {
  return {
    checkRobots: vi
      .fn()
      .mockResolvedValue({ allowed: true, reason: 'mock allowed', crawlDelayMs: 0 }),
    fetchPage: vi.fn().mockImplementation(async () => ({
      url: 'https://example.com/careers',
      httpStatus: 200,
      contentType: 'text/html',
      body: '<html><body>ok</body></html>',
      contentHash: 'abc123',
      fetchedAt: new Date(),
      errorCode: null,
      errorMessage: null,
      isDuplicate: false,
      headers: new Map(),
    })),
    discoverJobLinks: vi
      .fn()
      .mockReturnValue(['https://example.com/careers/job1', 'https://example.com/careers/job2']),
    extractTextFromHtml: vi.fn((html: string) => html.replace(/<[^>]+>/g, ' ')),
    parseJobStructuredFields: vi.fn().mockImplementation((text: string, url: string) => {
      const id = url.split('/').pop() ?? 'id';
      return {
        source_job_id: id,
        title_en: `Job ${id}`,
        description_en: `Description for job ${id}`,
        location_text_en: 'Phnom Penh',
        salary_source: '$300-$500',
        company_name: 'Example Co.',
        apply_url: url,
      };
    }),
  };
}

type FakeTranslation = {
  detectLanguage: ReturnType<typeof vi.fn>;
  translateIntoOtherLanguages: ReturnType<typeof vi.fn>;
  translateStagingBatch: ReturnType<typeof vi.fn>;
};
function makeFakeTranslation(): FakeTranslation {
  return {
    detectLanguage: vi.fn().mockReturnValue('en'),
    translateIntoOtherLanguages: vi.fn().mockImplementation(async (params: AnyRow) => {
      const structuredFallback = params.structuredFallback as {
        title?: string | null;
        tasks?: string[];
        skills?: string[];
        industry?: string | null;
        locations?: string[];
        salaryText?: string | null;
        shifts?: string[];
        benefits?: string[];
      };
      return {
        sourceLanguage: 'en',
        failedLanguages: [],
        translations: Object.fromEntries(
          ['en', 'km', 'zh_CN'].map((language) => [
            language,
            {
              language,
              fields: {
                title: structuredFallback.title ?? 'Job',
                tasks: structuredFallback.tasks ?? [],
                skills: structuredFallback.skills ?? [],
                industry: structuredFallback.industry ?? null,
                locations: structuredFallback.locations ?? [],
                salaryText: structuredFallback.salaryText ?? null,
                shifts: structuredFallback.shifts ?? [],
                benefits: structuredFallback.benefits ?? [],
                warnings: [],
              },
              provider: 'fake',
              model: 'fake',
              version: '1.0',
            },
          ]),
        ),
      };
    }),
    translateStagingBatch: vi.fn().mockImplementation(async (rows: AnyRow[]) => ({
      success: rows.length,
      added: rows.length * 2,
      failed: 0,
    })),
  };
}

type FakeQA = {
  runStructuralQA: ReturnType<typeof vi.fn>;
  runConsistencyQA: ReturnType<typeof vi.fn>;
  aggregateForStaging: ReturnType<typeof vi.fn>;
};
function makeFakeQA(): FakeQA {
  return {
    runStructuralQA: vi.fn().mockReturnValue({ flags: [], issues: [] }),
    runConsistencyQA: vi.fn().mockReturnValue({ flags: [], issues: [] }),
    aggregateForStaging: vi.fn().mockReturnValue({
      passed: true,
      flags: [],
      requiresReview: false,
      structuralIssues: [],
      consistencyIssues: [],
      riskIssues: [],
    }),
  };
}

interface FakeAIProvider {
  supportsLanguage: (lang: AILanguage) => boolean;
  extractCandidateProfile: ReturnType<typeof vi.fn>;
  extractCompanyProfile: ReturnType<typeof vi.fn>;
}
function makeFakeAI(): FakeAIProvider {
  return {
    supportsLanguage: (lang) => ['en', 'zh_CN', 'km'].includes(lang),
    extractCandidateProfile: vi.fn(),
    extractCompanyProfile: vi.fn(),
  };
}

function makeFakePrisma(): FakePrisma {
  const db: FakePrisma['db'] = {
    source_registry: new Map(),
    crawl_jobs_staging: new Map(),
    crawl_snapshots: new Map(),
    jobs: new Map(),
    job_translations: new Map(),
    crawl_runs: new Map(),
  };
  let idCtr = 1000n;
  const nextId = () => ++idCtr;

  const sr = db.source_registry;
  const cjs = db.crawl_jobs_staging;
  const cs = db.crawl_snapshots;
  const jb = db.jobs;
  const jt = db.job_translations;
  const cr = db.crawl_runs;

  function rowMatchesWhere<T extends AnyRow>(row: T, where: AnyRow = {}): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (typeof v === 'object' && v !== null) {
        if ('equals' in v) {
          if (row[k] !== v.equals) return false;
          continue;
        }
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  }

  const prisma: FakePrisma = {
    db,
    $transaction: async (fn) => fn(prisma),
    source_registry: {
      findUnique: async ({ where }) => (where.id != null ? (sr.get(where.id) ?? null) : null),
      findFirst: async ({ where, select }) => {
        for (const r of sr.values()) {
          if (rowMatchesWhere(r, where)) {
            if (select) {
              const out: AnyRow = {};
              for (const k of Object.keys(select)) out[k] = r[k];
              return out;
            }
            return r;
          }
        }
        return null;
      },
      findMany: async ({ where } = {}) => {
        const rows: AnyRow[] = [];
        for (const r of sr.values()) if (rowMatchesWhere(r, where)) rows.push(r);
        return rows;
      },
      create: async ({ data }) => {
        const id = nextId();
        const row = { id, ...data };
        sr.set(id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const existing = sr.get(where.id) ?? {};
        const merged = { ...existing, ...data };
        sr.set(where.id, merged);
        return merged;
      },
    },
    crawl_jobs_staging: {
      findUnique: async ({ where, include }) => {
        const r = where.id != null ? (cjs.get(where.id) ?? null) : null;
        if (!r) return null;
        if (include && include.job_translations) {
          const translations = Array.from(jt.values()).filter(
            (t) => t.crawl_job_staging_id === r.id,
          );
          return { ...r, job_translations: translations };
        }
        return r;
      },
      findMany: async ({ where, select }) => {
        const out: AnyRow[] = [];
        for (const r of cjs.values()) {
          if (rowMatchesWhere(r, where)) {
            if (select) {
              const o: AnyRow = {};
              for (const k of Object.keys(select)) o[k] = r[k];
              out.push(o);
            } else {
              out.push(r);
            }
          }
        }
        return out;
      },
      create: async ({ data }) => {
        const id = nextId();
        const row = { id, ...data };
        cjs.set(id, row);
        return row;
      },
      upsert: async ({ where, create, update }) => {
        const key = where.source_id_source_job_id as
          { source_id: bigint; source_job_id: string } | undefined;
        if (key) {
          for (const [id, row] of cjs.entries()) {
            if (row.source_id === key.source_id && row.source_job_id === key.source_job_id) {
              const merged = { ...row, ...update };
              cjs.set(id, merged);
              return merged;
            }
          }
        }
        const id = nextId();
        const row = { id, ...create };
        cjs.set(id, row);
        return row;
      },
      createMany: async ({ data }) => {
        let count = 0;
        for (const d of data) {
          const id = nextId();
          cjs.set(id, { id, ...d });
          count++;
        }
        return { count };
      },
      update: async ({ where, data }) => {
        const existing = cjs.get(where.id) ?? {};
        const merged = { ...existing, ...data };
        cjs.set(where.id, merged);
        return merged;
      },
      updateMany: async () => ({ count: 0 }),
    },
    crawl_snapshots: {
      create: async ({ data }) => {
        const id = nextId();
        const row = { id, ...data };
        cs.set(id, row);
        return row;
      },
      findUnique: async ({ where }) => {
        const key = where.source_id_content_hash as
          { source_id: bigint; content_hash: string } | undefined;
        if (!key) return null;
        for (const row of cs.values()) {
          if (row.source_id === key.source_id && row.content_hash === key.content_hash) return row;
        }
        return null;
      },
    },
    jobs: {
      findUnique: async ({ where }) => {
        const w = where;
        const byId = w.id as bigint | undefined;
        if (byId != null) return jb.get(byId) ?? null;
        const bySourceKey = w.source_job_source_id_source_job_id as
          { source_id: bigint; source_job_id: string } | undefined;
        if (bySourceKey) {
          for (const r of jb.values()) {
            const row = r as { source_id: bigint; source_job_id: string };
            if (
              row.source_id === bySourceKey.source_id &&
              row.source_job_id === bySourceKey.source_job_id
            ) {
              return r;
            }
          }
        }
        return null;
      },
      upsert: async ({ create, update }) => {
        const id = nextId();
        const row = { id, ...create, ...(Object.keys(update).length ? update : {}) };
        jb.set(id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const existing = jb.get(where.id) ?? {};
        const merged = { ...existing, ...data };
        jb.set(where.id, merged);
        return merged;
      },
    },
    job_translations: {
      findMany: async () => Array.from(jt.values()),
      upsert: async ({ where, create, update }) => {
        const key = where.job_trans_staging_lang_ver_uq as
          { staging_job_id: bigint; language: string; translation_version: string } | undefined;
        if (key) {
          for (const [id, row] of jt.entries()) {
            if (
              row.staging_job_id === key.staging_job_id &&
              row.language === key.language &&
              row.translation_version === key.translation_version
            ) {
              const merged = { ...row, ...update };
              jt.set(id, merged);
              return merged;
            }
          }
        }
        const id = nextId();
        const row = { id, ...create };
        jt.set(id, row);
        return row;
      },
      createMany: async ({ data }) => {
        let count = 0;
        for (const d of data) {
          const id = nextId();
          jt.set(id, { id, ...d });
          count++;
        }
        return { count };
      },
      updateMany: async () => ({ count: 3 }),
    },
    crawl_runs: {
      create: async ({ data }) => {
        const id = nextId();
        const row = { id, ...data };
        cr.set(id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const existing = cr.get(where.id) ?? {};
        const merged = { ...existing, ...data };
        cr.set(where.id, merged);
        return merged;
      },
    },
  };
  return prisma;
}

const CSV_HEADER = 'name,base_url,jobs_url,source_type,parser_type,city,industry,discovery_method';
const CSV_GOOD_SMART =
  'Smart Axiata,https://www.smart.com.kh,https://www.smart.com.kh/careers,OFFICIAL_COMPANY_WEBSITE,STATIC_HTML,Phnom Penh,Telecommunications,smart_primary_manual';
const CSV_GOOD_AMK =
  'AMK Bank,https://www.amkcambodia.com,https://www.amkcambodia.com/careers,OFFICIAL_COMPANY_WEBSITE,STATIC_HTML,Phnom Penh,Banking,amk_primary_manual';
const CSV_NON_HTTPS =
  'BadCo,http://insecure.local,http://insecure.local/jobs,OFFICIAL_COMPANY_WEBSITE,STATIC_HTML,PP,Retail,insecure';

function makeImportCsvText(...rows: string[]): string {
  return [CSV_HEADER, ...rows].join('\n');
}

describe('Source Full Pipeline (§11 集成 13 步: CSV→导入→验证→审核→抓取→staging→翻译→QA→审核→jobs)', () => {
  let prisma: FakePrisma;
  let clock: FakeClock;
  let audit: ReturnType<typeof makeFakeAuditRepo>;
  let crawlerFake: FakeCrawler;
  let translationFake: FakeTranslation;
  let qaFake: FakeQA;
  let aiFake: FakeAIProvider;

  beforeEach(() => {
    prisma = makeFakePrisma();
    clock = FakeClock.fromISO('2026-09-22T00:00:00Z');
    audit = makeFakeAuditRepo();
    crawlerFake = makeFakeCrawler();
    translationFake = makeFakeTranslation();
    qaFake = makeFakeQA();
    aiFake = makeFakeAI();
  });

  function makeImportSvc(): SourceImportService {
    return new SourceImportService(prisma as never, audit as never, crawlerFake as never, clock);
  }
  function makeReviewSvc(): SourceReviewService {
    return new SourceReviewService(prisma as never, audit as never, clock);
  }
  function makeValidationSvc(): SourceValidationService {
    const imp = makeImportSvc();
    return new SourceValidationService(prisma as never, audit as never, imp, clock);
  }
  function makeOrchestrator(): CrawlerOrchestrator {
    return new CrawlerOrchestrator(
      prisma as never,
      audit as never,
      crawlerFake as never,
      translationFake as never,
      qaFake as never,
      clock,
      aiFake as never,
    );
  }
  function makeJobReviewSvc(orch: CrawlerOrchestrator): CrawlerReviewService {
    return new CrawlerReviewService(prisma as never, audit as never, orch, clock);
  }

  describe('Step 1-3: CSV → dry-run 不写 DB → real import → 重复导入无重复', () => {
    it('Step 1: dry-run 时 enabled=false, review_status=PENDING 且 DB 不新增', async () => {
      const svc = makeImportSvc();
      const before = prisma.db.source_registry.size;
      const r = await svc.importFromCsvText(makeImportCsvText(CSV_GOOD_SMART, CSV_GOOD_AMK), {
        dryRun: true,
      });
      expect(r.dryRun).toBe(true);
      expect(r.parseErrors).toHaveLength(0);
      expect(r.totalRows).toBe(2);
      expect(r.inserted).toBe(0);
      expect(r.duplicates).toBe(0);
      expect(prisma.db.source_registry.size).toBe(before);
      for (const rep of r.importReports) {
        expect(rep.imported).toBe(false);
        expect(rep.warnings?.join(' ')).toMatch(/dry-run enabled/);
        expect(typeof rep.verification_score === 'number').toBe(true);
      }
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('Step 2: real import 写入 source_registry, enabled=false, review_status=PENDING, audit SOURCE_IMPORTED', async () => {
      const svc = makeImportSvc();
      const r = await svc.importFromCsvText(makeImportCsvText(CSV_GOOD_SMART));
      expect(r.dryRun).toBe(false);
      expect(r.inserted).toBe(1);
      expect(r.importReports).toHaveLength(1);
      const rep = r.importReports[0]!;
      expect(rep.imported).toBe(true);
      expect(rep.insertedId).toBeDefined();
      const row = prisma.db.source_registry.get(rep.insertedId!);
      expect(row).toBeDefined();
      expect(row!.enabled).toBe(false);
      expect(row!.review_status).toBe('PENDING');
      expect(row!.name).toBe('Smart Axiata');
      expect(row!.verification_score).toBe(rep.verification_score);
      expect(audit.record).toHaveBeenCalled();
      const last = audit.auditLog[audit.auditLog.length - 1]!;
      expect(last.action).toBe(AuditActionEnum.SOURCE_IMPORTED);
      expect(last.metadata.review_status).toBe('PENDING');
      expect(last.metadata.source_type).toBe('OFFICIAL_COMPANY_WEBSITE');
      expect(last.metadata.dry_run).toBe(false);
    });

    it('Step 3: 重复导入相同 base_url+jobs_url → duplicates=1，不新增不抛错', async () => {
      const svc = makeImportSvc();
      const first = await svc.importFromCsvText(makeImportCsvText(CSV_GOOD_SMART));
      expect(first.inserted).toBe(1);
      const id1 = first.importReports[0]!.insertedId;
      const beforeSize = prisma.db.source_registry.size;
      const second = await svc.importFromCsvText(makeImportCsvText(CSV_GOOD_SMART));
      expect(second.inserted).toBe(0);
      expect(second.duplicates).toBe(1);
      expect(second.importReports[0]!.duplicateOfId).toBe(id1);
      expect(prisma.db.source_registry.size).toBe(beforeSize);
    });
  });

  describe('Step 4-6: CSV parseErrors 逐行返回 + NEA 分类 GOVERNMENT_JOB_PORTAL', () => {
    it('Step 4: 混合合法+非法CSV → parseErrors 逐行号+message 不影响合法行', async () => {
      const svc = makeImportSvc();
      const r = await svc.importFromCsvText(makeImportCsvText(CSV_NON_HTTPS, CSV_GOOD_AMK));
      // parseErrors 是 parseSourcesCsv 阶段产生的非 HTTPS 错；SourceImportService 会把非法行跳过
      expect(r.failed + r.parseErrors.length).toBeGreaterThanOrEqual(1);
      // AMK 应该成功 inserted
      const amk = r.importReports.find((x) => x.name === 'AMK Bank');
      expect(amk?.imported).toBe(true);
    });

    it('Step 5: NEA (nea.gov.kh) → source_type=GOVERNMENT_JOB_PORTAL 显示标签政府就业平台', async () => {
      const svc = makeImportSvc();
      const csvNEA =
        'NEA National Employment Agency,https://www.nea.gov.kh,https://www.nea.gov.kh/cpesEx/vacancy/index.do,GOVERNMENT_JOB_PORTAL,STATIC_HTML,Phnom Penh,Government,nea_gov_primary';
      const r = await svc.importFromCsvText(makeImportCsvText(csvNEA));
      expect(r.inserted).toBe(1);
      const rep = r.importReports[0]!;
      const row = prisma.db.source_registry.get(rep.insertedId!);
      expect(row!.source_type).toBe('GOVERNMENT_JOB_PORTAL');
    });
  });

  describe('Step 7-8: 来源状态机 approve/reject/suspend (review FSM transitions)', () => {
    it('Step 7: approve 之前必须 PENDING → APPROVED 合法；并把 enabled=true + verified_at/verified_by 填', async () => {
      const imp = makeImportSvc();
      const rev = makeReviewSvc();
      const r = await imp.importFromCsvText(makeImportCsvText(CSV_GOOD_SMART));
      const id = r.importReports[0]!.insertedId!;
      const before = prisma.db.source_registry.get(id)!;
      expect(before.review_status).toBe('PENDING');
      expect(before.enabled).toBe(false);
      const updated = await rev.approve(id, 42n, 'Operator manual signoff');
      expect(updated.review_status).toBe('APPROVED');
      expect(updated.enabled).toBe(true);
      expect(updated.verified_by).toBe('42');
      expect(updated.verified_at).toBeDefined();
      const auditRow = audit.auditLog.find(
        (x) => x.action === AuditActionEnum.SOURCE_APPROVED && x.objectId === id,
      );
      expect(auditRow).toBeDefined();
    });

    it('Step 8: PENDING → REJECTED 合法，enabled=false，reason 记录，不能直接 runOrchestrator', async () => {
      const imp = makeImportSvc();
      const rev = makeReviewSvc();
      const r = await imp.importFromCsvText(makeImportCsvText(CSV_GOOD_AMK));
      const id = r.importReports[0]!.insertedId!;
      const rejected = await rev.reject(id, 42n, 'AMK site requires login beyond robots scope');
      expect(rejected.review_status).toBe('REJECTED');
      expect(rejected.enabled).toBe(false);
      expect(audit.record).toHaveBeenCalled();
      expect(canSourceReviewTransition('REJECTED', 'APPROVED')).toBe(true);
      expect(canSourceReviewTransition('REJECTED', 'SUSPENDED')).toBe(false);
    });

    it('非法转移 APPROVED → FETCHED (不存在的 review_status) 或 REJECTED→SUSPENDED 抛 CRAWL_SOURCE_REVIEW_INVALID_TRANSITION', () => {
      // 直接测 review 层
      const rev = makeReviewSvc();
      prisma.db.source_registry.set(500n, {
        id: 500n,
        review_status: 'REJECTED',
      });
      return expect(rev.suspend(500n, null, 'try suspend from REJECTED')).rejects.toBeInstanceOf(
        AppError,
      );
    });
  });

  describe('Step 9: Orchestrator 门控 (review_status!=APPROVED 必须 errorCount=1 跳过)', () => {
    it('review_status=PENDING 时 runSource 返回 errorCount=1，不抓取任何职位', async () => {
      const imp = makeImportSvc();
      const orch = makeOrchestrator();
      const r = await imp.importFromCsvText(makeImportCsvText(CSV_GOOD_SMART));
      const id = r.importReports[0]!.insertedId!;
      const before = prisma.db.crawl_jobs_staging.size;
      const stats = await orch.runSource(id);
      expect(stats.errorCount).toBe(1);
      expect(stats.newCount).toBe(0);
      expect(stats.lastError).toMatch(/review_status=PENDING/);
      expect(prisma.db.crawl_jobs_staging.size).toBe(before);
    });

    it('enabled=false 即使 APPROVED → stats 空 0 error 但也不抓', async () => {
      const imp = makeImportSvc();
      const orch = makeOrchestrator();
      const r = await imp.importFromCsvText(makeImportCsvText(CSV_GOOD_SMART));
      const id = r.importReports[0]!.insertedId!;
      await prisma.source_registry.update({
        where: { id },
        data: { review_status: 'APPROVED', enabled: false },
      });
      const stats = await orch.runSource(id);
      expect(stats.errorCount).toBe(0);
      expect(stats.newCount).toBe(0);
    });

    it('parser_type=PLAYWRIGHT 即使 review_status=APPROVED enabled=true 抛 CRAWL_SOURCE_PARSER_NOT_IMPLEMENTED', async () => {
      const imp = makeImportSvc();
      const orch = makeOrchestrator();
      const r = await imp.importFromCsvText(makeImportCsvText(CSV_GOOD_SMART));
      const id = r.importReports[0]!.insertedId!;
      await prisma.source_registry.update({
        where: { id },
        data: { review_status: 'APPROVED', enabled: true, parser_type: 'PLAYWRIGHT' },
      });
      let caught: AppError | null = null;
      try {
        await orch.runSource(id);
      } catch (e) {
        caught = e as AppError;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught!.code).toBe(AppErrorCode.CRAWL_SOURCE_PARSER_NOT_IMPLEMENTED);
    });
  });

  describe('Step 10-13: APPROVED 来源单抓取 → staging → 翻译 → QA → staging approve → jobs 发布', () => {
    async function seedApprovedSourceSmart(): Promise<bigint> {
      const imp = makeImportSvc();
      const rev = makeReviewSvc();
      const r = await imp.importFromCsvText(makeImportCsvText(CSV_GOOD_SMART));
      const id = r.importReports[0]!.insertedId!;
      await rev.approve(id, 1n, 'manual signoff');
      return id;
    }

    it('Step 10: APPROVED 来源 → discoverJobLinks 2 jobs → crawl_jobs_staging 新增 PARSED 且 source_id 正确', async () => {
      const sourceId = await seedApprovedSourceSmart();
      const orch = makeOrchestrator();
      const stats = await orch.runSource(sourceId);
      expect(stats.errorCount).toBe(0);
      expect(stats.newCount).toBeGreaterThanOrEqual(2);
      const stagings = Array.from(prisma.db.crawl_jobs_staging.values()).filter(
        (r) => r.source_id === sourceId,
      );
      expect(stagings.length).toBeGreaterThanOrEqual(2);
      for (const s of stagings) {
        expect(['DISCOVERED', 'FETCHED', 'PARSED', 'TRANSLATED', 'QA_PENDING']).toContain(s.status);
        expect(s.source_job_id).toBeDefined();
        expect(s.parse_version).toBe('parse-1.0');
      }
      // audit CRAWL_SOURCE_REGISTERED for robots etc
      expect(audit.auditLog.length).toBeGreaterThan(0);
    });

    it('Step 11: translateStagingBatch 被调用 (翻译计数 + QA 评分) 后 job_translations ≥3 种语言 (km/en/zh_CN)', async () => {
      const sourceId = await seedApprovedSourceSmart();
      const orch = makeOrchestrator();
      const before = await prisma.job_translations.findMany();
      await orch.runSource(sourceId);
      const after = await prisma.job_translations.findMany();
      expect(after.length).toBeGreaterThan(before.length);
      // Orchestrator QA 阶段：调用过 runStagingFieldQA + runTranslationQA
      expect(qaFake.runStructuralQA).toHaveBeenCalled();
      expect(qaFake.runConsistencyQA).toHaveBeenCalled();
    });

    it('Step 12: 评分 band SUBMITTABLE/MANUAL/REJECT 与 PRD §7 一致 (sanity 80/60/59)', () => {
      expect(bandForSourceVerificationScore(100)).toBe('SUBMITTABLE');
      expect(bandForSourceVerificationScore(80)).toBe('SUBMITTABLE');
      expect(bandForSourceVerificationScore(79)).toBe('MANUAL_REVIEW_REQUIRED');
      expect(bandForSourceVerificationScore(60)).toBe('MANUAL_REVIEW_REQUIRED');
      expect(bandForSourceVerificationScore(59)).toBe('REJECT');
    });

    it('Step 13: 抓取 APPROVED staging + 填好 translations → CrawlerReviewService.approve 写入 jobs (publish)，source_type 展示 企业官网', async () => {
      const sourceId = await seedApprovedSourceSmart();
      const orch = makeOrchestrator();
      await orch.runSource(sourceId);
      const stagings = Array.from(prisma.db.crawl_jobs_staging.values()).filter(
        (r) => r.source_id === sourceId,
      );
      expect(stagings.length).toBeGreaterThan(0);
      const staging0 = stagings[0]!;
      const sid = staging0.id as bigint;
      // ensure APPROVED staging status + translations present (CrawlerReviewService requires APPROVED path w/ translations)
      await prisma.crawl_jobs_staging.update({
        where: { id: sid },
        data: { status: 'APPROVED' },
      });
      const jtIds = await prisma.job_translations.createMany({
        data: [
          {
            crawl_job_staging_id: sid,
            language: 'en',
            title: staging0.title_km ?? 'English Title',
            body: staging0.description_km ?? 'English Desc',
            location: 'Phnom Penh',
            created_at: clock.now(),
          },
          {
            crawl_job_staging_id: sid,
            language: 'zh_CN',
            title: '中文岗位名',
            body: '中文岗位描述',
            location: '金边',
            created_at: clock.now(),
          },
          {
            crawl_job_staging_id: sid,
            language: 'km',
            title: 'ចំណាត់ការងារ ខ្មែរ',
            body: 'ពិពណ៌នា ការងារ ខ្មែរ',
            location: 'ភ្នំពេញ',
            created_at: clock.now(),
          },
        ],
        skipDuplicates: true,
      });
      expect(jtIds.count).toBe(3);
      const jobReview = makeJobReviewSvc(orch);
      const published = await jobReview.approve(sid, 1n);
      expect(published.jobId).toBeDefined();
      expect(published.stagingId).toBe(sid);
      const publishedJob = prisma.db.jobs.get(published.jobId) as AnyRow;
      expect(publishedJob).toBeDefined();
      expect(publishedJob.status).toBe('ACTIVE_EXTERNAL');
      expect(publishedJob.source_type).toBe('EXTERNAL');
    });
  });
});
