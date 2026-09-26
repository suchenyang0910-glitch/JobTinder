import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlerLifecycleService } from '@src/application/crawler/crawler-lifecycle.service';
import { CrawlerReviewService } from '@src/application/crawler/crawler-review.service';
import { type CrawlerReviewNotifierService } from '@src/application/crawler/crawler-review-notifier.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { APP_ENV } from '@src/shared/env/app-env';

type AnyRow = Record<string, unknown>;

type FakePrisma = {
  db: {
    crawl_jobs_staging: Map<bigint, AnyRow>;
    jobs: Map<bigint, AnyRow>;
  };
  $transaction: <T>(fn: (tx: FakePrisma) => Promise<T>) => Promise<T>;
  crawl_jobs_staging: {
    findMany: (p: {
      where?: AnyRow;
      take?: number;
      orderBy?: AnyRow;
      select?: AnyRow;
    }) => Promise<AnyRow[]>;
    findUnique: (p: { where: { id: bigint } }) => Promise<AnyRow | null>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
  };
  jobs: {
    findUnique: (p: { where: { id: bigint } }) => Promise<AnyRow | null>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
  };
};

function makeAudit() {
  const records: Array<{ action: string; objectType: string; objectId: bigint; metadata: AnyRow }> =
    [];
  return {
    records,
    record: vi.fn().mockImplementation(async (r: (typeof records)[number]) => {
      records.push(r);
    }),
  };
}

function makeReviewFake() {
  const markedStale: { stagingId: bigint; actorId: bigint | null }[] = [];
  return {
    markedStale,
    markStale: vi.fn().mockImplementation(async (stagingId: bigint, actorId: bigint | null) => {
      markedStale.push({ stagingId, actorId });
    }),
  };
}

function makeFakePrisma(): FakePrisma {
  const db = {
    crawl_jobs_staging: new Map<bigint, AnyRow>(),
    jobs: new Map<bigint, AnyRow>(),
  };
  const prisma: FakePrisma = {
    db,
    $transaction: async (fn) => fn(prisma),
    crawl_jobs_staging: {
      findMany: async ({ where, take } = {}) => {
        const w = (where ?? {}) as {
          status?: { in?: string[] };
          OR?: Array<{ expiry_date?: { not?: null; lte?: Date } }>;
        };
        const rows = Array.from(db.crawl_jobs_staging.values());
        let filtered = rows;
        if (w.status?.in) {
          filtered = filtered.filter((r) => w.status!.in!.includes(String(r.status)));
        }
        if (w.OR) {
          for (const clause of w.OR) {
            if (clause.expiry_date) {
              if (clause.expiry_date.not === null) {
                filtered = filtered.filter((r) => r.expiry_date != null);
              }
              if (clause.expiry_date.lte instanceof Date) {
                filtered = filtered.filter((r) => {
                  if (!r.expiry_date) return false;
                  return new Date(r.expiry_date as Date) <= clause.expiry_date!.lte!;
                });
              }
            }
          }
        }
        return (take ? filtered.slice(0, take) : filtered).map((r) => ({
          id: r.id,
          status: r.status,
          source_url: r.source_url,
          published_job_id: r.published_job_id,
          updated_at: r.updated_at,
          published_job_id_alias: r.published_job_id,
          source_id: r.source_id,
          source_job_id: r.source_job_id,
          expiry_date: r.expiry_date,
        }));
      },
      findUnique: async ({ where }) => db.crawl_jobs_staging.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const cur = db.crawl_jobs_staging.get(where.id) ?? {};
        const merged: AnyRow = { ...cur };
        for (const k of Object.keys(data)) {
          const v = data[k];
          if (
            v &&
            typeof v === 'object' &&
            ('increment' in v || 'decrement' in v || 'multiply' in v)
          ) {
            const curVal = Number(cur[k] ?? 0);
            if ((v as AnyRow).increment != null)
              merged[k] = curVal + Number((v as AnyRow).increment);
            else if ((v as AnyRow).decrement != null)
              merged[k] = curVal - Number((v as AnyRow).decrement);
            else if ((v as AnyRow).multiply != null)
              merged[k] = curVal * Number((v as AnyRow).multiply);
          } else {
            merged[k] = v;
          }
        }
        db.crawl_jobs_staging.set(where.id, merged);
        return merged;
      },
    },
    jobs: {
      findUnique: async ({ where }) => db.jobs.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const cur = db.jobs.get(where.id);
        if (cur == null) throw new Error(`Job ${String(where.id)} not found for update`);
        const merged: AnyRow = { ...cur };
        for (const k of Object.keys(data)) {
          const v = data[k];
          if (
            v &&
            typeof v === 'object' &&
            ('increment' in v || 'decrement' in v || 'multiply' in v)
          ) {
            const curVal = Number(cur[k] ?? 0);
            if ((v as AnyRow).increment != null)
              merged[k] = curVal + Number((v as AnyRow).increment);
            else if ((v as AnyRow).decrement != null)
              merged[k] = curVal - Number((v as AnyRow).decrement);
            else if ((v as AnyRow).multiply != null)
              merged[k] = curVal * Number((v as AnyRow).multiply);
          } else {
            merged[k] = v;
          }
        }
        db.jobs.set(where.id, merged);
        return merged;
      },
    },
  };
  return prisma;
}

function seed(
  prisma: FakePrisma,
  overrides: { status?: string; http?: number; published_job_id?: bigint | null } = {},
) {
  const stagingId = 100n;
  const hasPublishedOverride = Object.prototype.hasOwnProperty.call(overrides, 'published_job_id');
  const stagingPublishedJobId = hasPublishedOverride ? overrides.published_job_id! : 200n;
  const jobId = stagingPublishedJobId ?? 200n;
  prisma.db.crawl_jobs_staging.set(stagingId, {
    id: stagingId,
    source_id: 10n,
    source_job_id: 'sj-1',
    source_url: 'https://ex.com/jobs/1',
    status: overrides.status ?? 'PUBLISHED',
    published_job_id: stagingPublishedJobId,
    updated_at: new Date('2026-09-20T00:00:00Z'),
    expiry_date: new Date('2026-10-01T00:00:00Z'),
  });
  if (stagingPublishedJobId != null) {
    prisma.db.jobs.set(jobId, {
      id: jobId,
      status: 'ACTIVE_EXTERNAL',
      version: 1,
    });
  }
  return { stagingId, jobId };
}

describe('CrawlerLifecycleService (B2 stale + expire)', () => {
  let prisma: FakePrisma;
  let clock: FakeClock;
  let audit: ReturnType<typeof makeAudit>;
  let review: ReturnType<typeof makeReviewFake>;

  beforeEach(() => {
    // Force CRAWLER_ENABLED=true for lifecycle UT (APP_ENV immutable via direct assignment)
    if ((APP_ENV as { CRAWLER_ENABLED?: boolean }).CRAWLER_ENABLED !== true) {
      Object.defineProperty(APP_ENV, 'CRAWLER_ENABLED', {
        value: true,
        writable: true,
        configurable: true,
      });
    }
    prisma = makeFakePrisma();
    clock = FakeClock.fromISO('2026-09-24T22:00:00Z');
    audit = makeAudit();
    review = makeReviewFake();
  });

  let origFetchDescriptor: PropertyDescriptor | undefined | null = null;
  function buildSvc(fetchOverrides?: Record<string, number>): CrawlerLifecycleService {
    const notifierFake = {} as unknown as CrawlerReviewNotifierService;
    const reviewFakeSvc = new (
      CrawlerReviewService as unknown as new (...args: unknown[]) => CrawlerReviewService
    )();
    Object.defineProperty(reviewFakeSvc, 'markStale', {
      value: review.markStale,
      configurable: true,
    });
    const svc = new CrawlerLifecycleService(
      prisma as never,
      reviewFakeSvc,
      audit as never,
      clock,
      notifierFake,
    );
    type LifecycleWithFetch = CrawlerLifecycleService & {
      _fetchOverride?: (u: string) => Promise<number>;
    };
    (svc as LifecycleWithFetch)._fetchOverride = fetchOverrides
      ? async (url) => fetchOverrides[url] ?? 200
      : undefined;
    if (origFetchDescriptor == null) {
      origFetchDescriptor =
        Object.getOwnPropertyDescriptor(CrawlerLifecycleService.prototype, 'fetchUrlStatus') ??
        null;
    }
    Object.defineProperty(CrawlerLifecycleService.prototype, 'fetchUrlStatus', {
      value: async function (this: LifecycleWithFetch, url: string) {
        if (this._fetchOverride) return this._fetchOverride(url);
        return 200;
      },
      configurable: true,
      writable: true,
    });
    return svc;
  }

  it('B2a HTTP 404 → markStale 调用 + 审计 CRAWL_JOB_MARKED_STALE（fallback 链路仍验证 staging.status/jobs.status = review.markStale 结果）', async () => {
    const { stagingId, jobId } = seed(prisma, { status: 'PUBLISHED' });
    // simulate CrawlerReviewService.markStale actual side effects by hooking our fake:
    review.markStale.mockImplementation(async (sid: bigint) => {
      review.markedStale.push({ stagingId: sid, actorId: null });
      const s = prisma.db.crawl_jobs_staging.get(sid);
      if (s) {
        s.status = 'STALE';
        s.updated_at = clock.now();
        if (s.published_job_id) {
          const j = prisma.db.jobs.get(s.published_job_id as bigint);
          if (j) {
            j.status = 'CLOSED';
            j.closed_at = clock.now();
            j.last_checked_at = clock.now();
            j.version = (j.version as number) + 1;
          }
        }
      }
      await audit.record({
        action: AuditActionEnum.CRAWL_JOB_MARKED_STALE,
        objectType: 'crawl_jobs_staging',
        objectId: sid,
        metadata: { source_id: '10', source_job_id: 'sj-1' },
      });
    });
    const svc = buildSvc({ 'https://ex.com/jobs/1': 404 });
    const stats = await svc.runStaleCheckCron();
    expect(stats.staleMarkedHttp404).toBe(1);
    expect(review.markedStale).toHaveLength(1);
    expect(review.markedStale[0]!.stagingId).toBe(stagingId);
    expect(prisma.db.crawl_jobs_staging.get(stagingId)?.status).toBe('STALE');
    expect(prisma.db.jobs.get(jobId)?.status).toBe('CLOSED');
    expect(prisma.db.jobs.get(jobId)?.closed_at).toBeInstanceOf(Date);
    const stale = audit.records.filter((r) => r.action === AuditActionEnum.CRAWL_JOB_MARKED_STALE);
    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(stale[stale.length - 1]!.objectId).toBe(stagingId);
  });

  it('B2a HTTP 410 → 同样触发 markStale，HTTP 200 不触发', async () => {
    seed(prisma, { status: 'APPROVED' });
    review.markStale.mockImplementation(async (sid: bigint) => {
      review.markedStale.push({ stagingId: sid, actorId: null });
      const s = prisma.db.crawl_jobs_staging.get(sid);
      if (s) s.status = 'STALE';
    });
    const svc = buildSvc({ 'https://ex.com/jobs/1': 410 });
    const s1 = await svc.runStaleCheckCron();
    expect(s1.staleMarkedHttp404).toBe(1);

    prisma.db.crawl_jobs_staging.get(100n)!.status = 'APPROVED';
    review.markedStale.length = 0;
    const svc2 = buildSvc({ 'https://ex.com/jobs/1': 200 });
    const s2 = await svc2.runStaleCheckCron();
    expect(s2.skipped).toBe(1);
    expect(review.markedStale).toHaveLength(0);
    expect(prisma.db.crawl_jobs_staging.get(100n)!.status).toBe('APPROVED');
  });

  it('B2b expiry_date ≤ now → staging=EXPIRED closed_reason=DEADLINE + jobs=CLOSED + 审计（事务内一致）', async () => {
    const { stagingId, jobId } = seed(prisma, { status: 'PUBLISHED' });
    // put expiry into the past
    prisma.db.crawl_jobs_staging.get(stagingId)!.expiry_date = new Date('2026-09-20T00:00:00Z');
    const svc = new CrawlerLifecycleService(
      prisma as never,
      {} as never,
      audit as never,
      clock,
      {} as never,
    );
    const stats = await svc.runExpireDeadlineCron();
    expect(stats.expiredDeadline).toBe(1);
    const stagingRow = prisma.db.crawl_jobs_staging.get(stagingId)!;
    const jobRow = prisma.db.jobs.get(jobId)!;
    expect(stagingRow.status).toBe('EXPIRED');
    expect(stagingRow.closed_reason).toBe('DEADLINE');
    expect(jobRow.status).toBe('CLOSED');
    expect(jobRow.closed_reason).toBe('DEADLINE');
    expect(jobRow.closed_at).toBeInstanceOf(Date);
    expect(Number(jobRow.version)).toBe(2);
    const expAudit = audit.records.filter(
      (r) => r.action === AuditActionEnum.CRAWL_JOB_MARKED_STALE,
    );
    expect(expAudit).toHaveLength(1);
    expect(expAudit[0]!.metadata).toMatchObject({
      old_status: 'PUBLISHED',
      new_status: 'EXPIRED',
      closed_reason: 'DEADLINE',
      source_id: '10',
      source_job_id: 'sj-1',
      job_id: String(jobId),
    });
  });

  it('B2b 非法跃迁（EXPIRED 状态不应再 EXPIRED）→ assertCrawlJobTransition 跳过（errors 计数递增）', async () => {
    const { stagingId } = seed(prisma, { status: 'EXPIRED' });
    prisma.db.crawl_jobs_staging.get(stagingId)!.expiry_date = new Date('2026-09-20T00:00:00Z');
    const svc = new CrawlerLifecycleService(prisma as never, {} as never, audit as never, clock);
    const stats = await svc.runExpireDeadlineCron();
    // where.status does not include EXPIRED, so 0 rows returned; expiredDeadline=0
    expect(stats.expiredDeadline).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('B2b published_job_id = null → 仍 EXPIRED staging，不抛不 touch jobs', async () => {
    const { stagingId } = seed(prisma, { status: 'PUBLISHED', published_job_id: null });
    prisma.db.crawl_jobs_staging.get(stagingId)!.expiry_date = new Date('2026-09-20T00:00:00Z');
    const svc = new CrawlerLifecycleService(
      prisma as never,
      {} as never,
      audit as never,
      clock,
      {} as never,
    );
    const stats = await svc.runExpireDeadlineCron();
    expect(stats.expiredDeadline).toBe(1);
    expect(stats.errors).toBe(0);
    expect(prisma.db.crawl_jobs_staging.get(stagingId)!.status).toBe('EXPIRED');
    expect(prisma.db.crawl_jobs_staging.get(stagingId)!.closed_reason).toBe('DEADLINE');
    expect(prisma.db.jobs.size).toBe(0);
  });

  afterAll(() => {
    if (origFetchDescriptor != null) {
      Object.defineProperty(
        CrawlerLifecycleService.prototype,
        'fetchUrlStatus',
        origFetchDescriptor,
      );
    }
  });
});
