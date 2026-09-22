import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlerReviewService } from '@src/application/crawler/crawler-review.service';
import { CrawlerSchedulerService } from '@src/application/crawler/crawler-scheduler.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import {
  isVisibleToMatches,
  canTransitionCrawlJob,
} from '@src/domain/crawler/crawl-job-status-machine';

type AnyRow = Record<string, unknown>;

interface FakePrisma {
  db: {
    crawl_jobs_staging: Map<bigint, AnyRow>;
    source_registry: Map<bigint, AnyRow>;
    jobs: Map<bigint, AnyRow>;
    job_translations: Map<bigint, AnyRow>;
    crawl_runs: Map<bigint, AnyRow>;
  };
  $transaction: <T>(fn: (tx: FakePrisma) => Promise<T>) => Promise<T>;
  crawl_jobs_staging: {
    findUnique: (p: { where: { id?: bigint } }) => Promise<AnyRow | null>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
    updateMany: () => Promise<{ count: number }>;
  };
  jobs: {
    upsert: (p: { where: unknown; create: AnyRow; update: AnyRow }) => Promise<AnyRow>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
  };
  job_translations: {
    updateMany: () => Promise<{ count: number }>;
  };
  source_registry: {
    findMany: () => Promise<AnyRow[]>;
    findUnique: (p: { where: { id: bigint } }) => Promise<AnyRow | null>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
  };
  crawl_runs: {
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
  };
}

function makeAuditRepoFake() {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

type OrchFake = ReturnType<typeof makeOrchestratorFake>;
function makeOrchestratorFake() {
  return {
    translateStaging: vi
      .fn()
      .mockResolvedValue({ row: { id: 1n, status: 'TRANSLATED' }, added: 2 }),
    runSource: vi.fn().mockResolvedValue({
      newCount: 0,
      changedCount: 0,
      closedCount: 0,
      translatedCount: 0,
      reviewRequiredCount: 0,
      errorCount: 0,
      lastError: null,
    }),
  };
}

function makeFakePrisma(): FakePrisma {
  const db: FakePrisma['db'] = {
    crawl_jobs_staging: new Map(),
    source_registry: new Map(),
    jobs: new Map(),
    job_translations: new Map(),
    crawl_runs: new Map(),
  };
  let idCtr = 1n;
  const nextId = () => ++idCtr;

  const cjs = db.crawl_jobs_staging;
  const jb = db.jobs;
  const sr = db.source_registry;
  const cr = db.crawl_runs;

  const prisma: FakePrisma = {
    db,
    $transaction: async (fn) => fn(prisma),
    crawl_jobs_staging: {
      findUnique: async ({ where }) => {
        if (where.id != null) return cjs.get(where.id) ?? null;
        return null;
      },
      update: async ({ where, data }) => {
        const existing = cjs.get(where.id) ?? {};
        const merged = { ...existing, ...data };
        cjs.set(where.id, merged);
        return merged;
      },
      updateMany: async () => ({ count: 0 }),
    },
    jobs: {
      upsert: async ({ create, update }) => {
        const id = nextId();
        const row: AnyRow = { id, ...create, ...(Object.keys(update).length ? update : {}) };
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
    job_translations: { updateMany: async () => ({ count: 3 }) },
    source_registry: {
      findMany: async () => Array.from(sr.values()),
      findUnique: async ({ where }) => sr.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const existing = sr.get(where.id) ?? {};
        const merged = { ...existing, ...data };
        sr.set(where.id, merged);
        return merged;
      },
    },
    crawl_runs: {
      create: async ({ data }) => {
        const id = nextId();
        const r: AnyRow = { id, ...data };
        cr.set(id, r);
        return r;
      },
      update: async ({ where, data }) => {
        const existing = cr.get(where.id) ?? {};
        const merged: AnyRow = { ...existing, ...data };
        cr.set(where.id, merged);
        return merged;
      },
    },
  };
  return prisma;
}

type FakePrismaT = FakePrisma;

describe('CrawlerReviewService + Scheduler (§16 approve writes jobs / §17 schedule idempotent / §18 full pipeline)', () => {
  let prisma: FakePrismaT;
  let clock: FakeClock;
  let audit: ReturnType<typeof makeAuditRepoFake>;
  let orch: OrchFake;

  beforeEach(() => {
    prisma = makeFakePrisma();
    clock = FakeClock.fromISO('2026-09-22T00:00:00Z');
    audit = makeAuditRepoFake();
    orch = makeOrchestratorFake();
  });

  function reviewSvc(): CrawlerReviewService {
    return new CrawlerReviewService(prisma as never, audit as never, orch as never, clock);
  }
  function schedulerSvc(): CrawlerSchedulerService {
    return new CrawlerSchedulerService(prisma as never, orch as never, audit as never, clock);
  }

  function seedStaging(overrides: Record<string, unknown> = {}) {
    const sid = 100n;
    const sourceId = 10n;
    prisma.db.source_registry.set(sourceId, {
      id: sourceId,
      name: 's',
      company_id: 5n,
      base_url: 'https://ex.com/',
      jobs_url: 'https://ex.com/jobs',
      parser_type: 'STATIC_HTML',
      enabled: true,
      crawl_interval_minutes: 15,
    });
    prisma.db.crawl_jobs_staging.set(sid, {
      id: sid,
      source_id: sourceId,
      snapshot_id: 50n,
      source_job_id: 'src123',
      source_url: 'https://ex.com/jobs/123',
      status: overrides.status ?? 'QA_PENDING',
      qa_status: 'PASSED',
      translation_status: 'DONE',
      qa_flags: [],
      detected_language: overrides.detected_language ?? 'en',
      title_source: 'title_source' in overrides ? overrides.title_source : 'Barista',
      tasks_source: 'tasks_source' in overrides ? overrides.tasks_source : 'Make coffee',
      skills_source: 'skills_source' in overrides ? overrides.skills_source : 'Latte art',
      industry_source: 'industry_source' in overrides ? overrides.industry_source : 'F&B',
      locations_source: 'locations_source' in overrides ? overrides.locations_source : 'Phnom Penh',
      salary_source: 'salary_source' in overrides ? overrides.salary_source : '$250-$350',
      shift_source: 'shift_source' in overrides ? overrides.shift_source : 'Day',
      benefits_source: 'benefits_source' in overrides ? overrides.benefits_source : 'Meal',
      parse_version: 'parse-1.0',
      published_job_id: null,
      reject_reason: null,
      job_translations: [
        {
          language: 'en',
          title: 'Barista',
          tasks: ['Make coffee'],
          skills: [],
          industry: 'F&B',
          locations: ['PP'],
          salary_text: '$250-$350',
          shifts: [],
          benefits: [],
        },
        {
          language: 'zh_CN',
          title: '咖啡师',
          tasks: ['做咖啡'],
          skills: [],
          industry: '餐饮',
          locations: ['金边'],
          salary_text: '$250-$350',
          shifts: [],
          benefits: [],
        },
        {
          language: 'km',
          title: 'បារីស្តា',
          tasks: ['ធ្វើកាហ្វេ'],
          skills: [],
          industry: 'ម្ហូប',
          locations: ['រាជធានីភ្នំពេញ'],
          salary_text: '$250-$350',
          shifts: [],
          benefits: [],
        },
      ],
      source: { id: sourceId, name: 's', company_id: 5n },
    });
    return sid;
  }

  it('§15 isVisibleToMatches is false for non-PUBLISHED (QA_PENDING/APPROVED/REJECTED/STALE)', () => {
    for (const s of [
      'DISCOVERED',
      'FETCHED',
      'PARSED',
      'TRANSLATED',
      'QA_PENDING',
      'REVIEW_REQUIRED',
      'APPROVED',
      'REJECTED',
      'STALE',
    ]) {
      expect(isVisibleToMatches(s as never)).toBe(false);
    }
    expect(isVisibleToMatches('PUBLISHED')).toBe(true);
  });

  it('§16 approve (QA_PENDING → APPROVED → PUBLISHED) creates ACTIVE_EXTERNAL job row + published_job_id + audit records', async () => {
    const sid = seedStaging({ status: 'QA_PENDING' });
    const svc = reviewSvc();
    const { jobId } = await svc.approve(sid, 42n);

    const job = prisma.db.jobs.get(jobId)!;
    expect(job).toBeDefined();
    expect(job.status).toBe('ACTIVE_EXTERNAL');
    expect(job.source_type).toBe('EXTERNAL');
    expect(job.source_url).toBe('https://ex.com/jobs/123');
    expect(job.source_job_id).toBe('src123');
    expect(job.company_id).toBe(5n);
    expect(job.title).toBeTruthy();
    expect(job.salary_status).toBe('PROVIDED');
    expect(job.last_checked_at).toBeDefined();

    const staging = prisma.db.crawl_jobs_staging.get(sid)!;
    expect(staging.status).toBe('PUBLISHED');
    expect(staging.published_job_id).toBe(jobId);

    expect(audit.record).toHaveBeenCalledTimes(2);
    const actions = audit.record.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toEqual(
      expect.arrayContaining(['CRAWL_REVIEW_APPROVED', 'CRAWL_JOB_PUBLISHED']),
    );
  });

  it('§16 reject writes reject_reason + staging.status=REJECTED + audit CRAWL_REVIEW_REJECTED', async () => {
    const sid = seedStaging({ status: 'REVIEW_REQUIRED' });
    const svc = reviewSvc();
    await svc.reject(sid, 7n, 'Expired job posting content date 2024', 'EXPIRED_POST');
    const staging = prisma.db.crawl_jobs_staging.get(sid)!;
    expect(staging.status).toBe('REJECTED');
    expect(staging.reject_reason).toBe('Expired job posting content date 2024');
    const actions = audit.record.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toEqual(['CRAWL_REVIEW_REJECTED']);
  });

  it('§16 NOT_PROVIDED salary becomes salary_status NOT_PROVIDED (no guess)', async () => {
    const sid = seedStaging({ status: 'QA_PENDING', salary_source: null });
    const svc = reviewSvc();
    const { jobId } = await svc.approve(sid, null);
    const job = prisma.db.jobs.get(jobId)!;
    expect(job.salary_status).toBe('NOT_PROVIDED');
    expect(job.salary_text).toBeNull();
  });

  it('§16 approve on illegal transition (PUBLISHED → APPROVED) throws CRAWL_INVALID_STATUS_TRANSITION', async () => {
    const sid = seedStaging({ status: 'PUBLISHED' });
    const svc = reviewSvc();
    await expect(() => svc.approve(sid, null)).rejects.toThrow();
    expect(prisma.db.jobs.size).toBe(0);
  });

  it('§17 scheduler lastRunLock prevents double-run on concurrent tick', async () => {
    const svc = schedulerSvc();
    (svc as unknown as { lastRunLock: boolean }).lastRunLock = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loggerWarn = vi
      .spyOn((svc as unknown as { logger: { warn: (s: string) => void } }).logger, 'warn')
      .mockImplementation(() => {});
    await svc.handleCron();
    expect(orch.translateStaging).not.toHaveBeenCalled();
    expect(prisma.db.crawl_runs.size).toBe(0);
    warn.mockRestore();
    loggerWarn.mockRestore();
  });

  it('§17 scheduler can run source and writes crawl_runs PROCESSING → SUCCEEDED with 7 stats', async () => {
    seedStaging({});
    orch.runSource = vi.fn().mockResolvedValue({
      newCount: 3,
      changedCount: 1,
      closedCount: 0,
      translatedCount: 2,
      reviewRequiredCount: 1,
      errorCount: 0,
      lastError: null,
    });
    const svc = schedulerSvc();
    const stats = await svc.runSourceWithRunRecord(10n);
    expect(stats.newCount).toBe(3);
    expect(prisma.db.crawl_runs.size).toBe(1);
    const run = Array.from(prisma.db.crawl_runs.values())[0] as Record<string, unknown>;
    expect(run.status).toBe('SUCCEEDED');
    expect(run.finished_at).toBeDefined();
    expect(run.new_count).toBe(3);
    expect(run.changed_count).toBe(1);
    expect(run.closed_count).toBe(0);
    expect(run.translated_count).toBe(2);
    expect(run.review_required_count).toBe(1);
    expect(run.error_count).toBe(0);
    expect(run.last_error).toBeNull();
    const actions = audit.record.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain('CRAWL_RUN_STARTED');
    expect(actions).toContain('CRAWL_RUN_FINISHED');
  });

  it('§18 full pipeline: staging state transitions sequence (DISCOVERED → FETCHED → PARSED → TRANSLATED → QA_PENDING → APPROVED → PUBLISHED) all legal', () => {
    const seq: Array<
      [Parameters<typeof canTransitionCrawlJob>[0], Parameters<typeof canTransitionCrawlJob>[1]]
    > = [
      ['DISCOVERED', 'FETCHED'],
      ['FETCHED', 'PARSED'],
      ['PARSED', 'TRANSLATED'],
      ['TRANSLATED', 'QA_PENDING'],
      ['QA_PENDING', 'APPROVED'],
      ['APPROVED', 'PUBLISHED'],
    ];
    for (const [from, to] of seq) {
      const ok = canTransitionCrawlJob(from, to);
      expect(ok).toBe(true);
      if (!ok) throw new Error(`transition ${from}→${to} should be legal`);
    }
    expect(isVisibleToMatches('PUBLISHED')).toBe(true);
  });
});
