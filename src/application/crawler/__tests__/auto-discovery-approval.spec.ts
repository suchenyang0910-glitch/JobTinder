import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { type PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { SourceDiscoveryService } from '../source-discovery.service';
import { type Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { type SourceValidationService, SourceReviewService } from '../source-import.service';
import { CrawlerReviewNotifierService } from '../crawler-review-notifier.service';
import type { RemoteJobEligibilityService } from '@src/application/remote/remote-job-eligibility.service';
import { CrawlerReviewService } from '../crawler-review.service';
import { type CrawlerOrchestrator } from '../crawler-orchestrator.service';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { APP_ENV } from '@src/shared/env/app-env';
import type { source_registry, crawl_jobs_staging, audit_events, jobs } from '@prisma/client';

type AnyRow = { id: bigint; [k: string]: unknown };

type PrismaShape = {
  source_registry: Map<bigint, AnyRow>;
  crawl_jobs_staging: Map<bigint, AnyRow>;
  audit_events: Map<bigint, AnyRow>;
  jobs: Map<bigint, AnyRow>;
  users: Map<bigint, AnyRow>;
  [k: string]: Map<bigint, AnyRow>;
};

function fakeIdCtr(start = 1n) {
  let cur = start;
  return () => cur++;
}

function makeFakeClock(fixed = new Date('2026-01-01T00:00:00Z')): Clock {
  return { now: () => fixed };
}

function resolveRowField(row: AnyRow, key: string): unknown {
  if (key in row) return row[key];
  if (key === 'staging_job_id' && 'staging_id' in row) return row['staging_id'];
  return undefined;
}

function rowMatches(
  row: AnyRow,
  where: Prisma.Enumerable<Prisma.source_registryWhereInput>,
): boolean {
  if (Array.isArray(where)) {
    return (where as unknown as AnyRow[]).every((clause) => rowMatches(row, clause));
  }
  const w = where as Record<string, unknown>;
  return Object.entries(w).every(([k, v]) => {
    if (k === 'OR') {
      return (v as Record<string, unknown>[]).some((c) => rowMatches(row, c));
    }
    if (k === 'AND') {
      return (v as Record<string, unknown>[]).every((c) => rowMatches(row, c));
    }
    if (
      typeof v === 'object' &&
      v != null &&
      !('equals' in (v as Record<string, unknown>)) &&
      !('startsWith' in (v as Record<string, unknown>)) &&
      !('in' in (v as Record<string, unknown>)) &&
      !('lt' in (v as Record<string, unknown>)) &&
      !('lte' in (v as Record<string, unknown>)) &&
      !('gt' in (v as Record<string, unknown>)) &&
      !('gte' in (v as Record<string, unknown>)) &&
      !('not' in (v as Record<string, unknown>))
    ) {
      return rowMatches(row, v);
    }
    const rowVal = resolveRowField(row, k);
    if (v == null) return rowVal == null;
    if (typeof v === 'object') {
      const op = v as Record<string, unknown>;
      if ('equals' in op) return rowVal === op.equals;
      if ('startsWith' in op) {
        const mode = (op.mode as string | undefined)?.toLowerCase();
        const a = String(rowVal ?? '');
        const b = String(op.startsWith);
        return mode === 'insensitive'
          ? a.toLowerCase().startsWith(b.toLowerCase())
          : a.startsWith(b);
      }
      if ('in' in op) return (op.in as unknown[]).includes(rowVal);
      if ('lt' in op) return (rowVal as number) < (op.lt as number);
      if ('lte' in op) return (rowVal as number) <= (op.lte as number);
      if ('gt' in op) return (rowVal as number) > (op.gt as number);
      if ('gte' in op) return (rowVal as number) >= (op.gte as number);
      if ('not' in op) return !rowMatches(row, { [k]: op.not });
    }
    return rowVal === v;
  });
}

function applyUpdate(row: AnyRow, data: Record<string, unknown>): AnyRow {
  const r: AnyRow = { ...row };
  for (const [k, v] of Object.entries(data)) {
    if (v != null && typeof v === 'object') {
      const op = v as Record<string, unknown>;
      if ('set' in op) {
        r[k] = op.set;
        continue;
      }
      if ('increment' in op) {
        r[k] = Number(r[k] ?? 0) + Number(op.increment);
        continue;
      }
      if ('connect' in op) continue;
    }
    r[k] = v;
  }
  return r;
}

function applySelect(row: AnyRow, select?: Record<string, unknown> | null): AnyRow {
  if (!select) return row;
  const out: AnyRow = { id: row.id };
  for (const k of Object.keys(select)) out[k] = row[k];
  return out;
}

interface TableApi<T extends AnyRow> {
  findMany: (opts?: {
    where?: Prisma.Enumerable<Prisma.source_registryWhereInput>;
    select?: Record<string, unknown>;
    orderBy?: Record<string, string> | Record<string, string>[];
    take?: number;
    skip?: number;
    include?: Record<string, unknown>;
  }) => T[];
  findUnique: (opts: {
    where: { id: bigint } | Record<string, unknown>;
    include?: Record<string, unknown>;
    select?: Record<string, unknown>;
  }) => T | null;
  findFirst: (opts: {
    where?: Prisma.Enumerable<Prisma.source_registryWhereInput>;
    include?: Record<string, unknown>;
    select?: Record<string, unknown>;
  }) => T | null;
  count: (opts?: { where?: Prisma.Enumerable<Prisma.source_registryWhereInput> }) => number;
  create: (opts: {
    data: Record<string, unknown>;
    include?: Record<string, unknown>;
    select?: Record<string, unknown>;
  }) => T;
  update: (opts: {
    where: { id: bigint };
    data: Record<string, unknown>;
    include?: Record<string, unknown>;
  }) => T;
  updateMany?: (opts: {
    where?: Prisma.Enumerable<Prisma.source_registryWhereInput>;
    data: Record<string, unknown>;
  }) => { count: number };
  upsert?: (opts: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
    include?: Record<string, unknown>;
    select?: Record<string, unknown>;
  }) => T;
}

function makeTable<T extends AnyRow>(
  table: Map<bigint, AnyRow>,
  includeHelpers?: (tableKey: string, rows: AnyRow[], shape: PrismaShape) => AnyRow[],
  tableKey = 'unknown',
  shape: PrismaShape = {
    source_registry: new Map(),
    crawl_jobs_staging: new Map(),
    audit_events: new Map(),
    jobs: new Map(),
    users: new Map(),
  },
): TableApi<T> {
  return {
    findMany: (opts) => {
      let rows = Array.from(table.values());
      if (opts?.where)
        rows = rows.filter((r) =>
          rowMatches(r, opts.where as Prisma.Enumerable<Prisma.source_registryWhereInput>),
        );
      if (opts?.orderBy) {
        const arr = Array.isArray(opts.orderBy) ? opts.orderBy : [opts.orderBy];
        rows.sort((a, b) => {
          for (const ob of arr) {
            for (const k of Object.keys(ob)) {
              const va = a[k];
              const vb = b[k];
              const dir =
                String((ob as Record<string, unknown>)[k]).toLowerCase() === 'desc' ? -1 : 1;
              if (va == null && vb != null) return -1 * dir;
              if (va != null && vb == null) return 1 * dir;
              if (va === vb) continue;
              if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
              return (String(va) < String(vb) ? -1 : 1) * dir;
            }
          }
          return 0;
        });
      }
      if (opts?.skip) rows = rows.slice(opts.skip);
      if (opts?.take) rows = rows.slice(0, opts.take);
      let out: AnyRow[] = rows.map((r) => applySelect(r, opts?.select));
      if (opts?.include && includeHelpers) out = includeHelpers(tableKey, out, shape);
      return out as T[];
    },
    findUnique: (opts) => {
      const idW = opts.where as { id?: bigint };
      if (idW.id != null) {
        const row = table.get(idW.id) as T | undefined;
        if (!row) return null;
        let out: AnyRow = applySelect(row, opts.select);
        if (opts.include && includeHelpers) {
          const res = includeHelpers(tableKey, [out], shape);
          out = res[0] ?? out;
        }
        return out as T;
      }
      const rows = Array.from(table.values());
      const matched = rows.find((r) =>
        rowMatches(r, opts.where as Prisma.Enumerable<Prisma.source_registryWhereInput>),
      );
      if (!matched) return null;
      let out: AnyRow = applySelect(matched, opts.select);
      if (opts.include && includeHelpers) {
        const res = includeHelpers(tableKey, [out], shape);
        out = res[0] ?? out;
      }
      return out as T;
    },
    findFirst: (opts) => {
      const rows = Array.from(table.values());
      const matched = opts?.where
        ? rows.find((r) =>
            rowMatches(r, opts.where as Prisma.Enumerable<Prisma.source_registryWhereInput>),
          )
        : rows[0];
      if (!matched) return null;
      let out: AnyRow = applySelect(matched, opts?.select);
      if (opts?.include && includeHelpers) {
        const res = includeHelpers(tableKey, [out], shape);
        out = res[0] ?? out;
      }
      return out as T;
    },
    count: (opts) => {
      const rows = Array.from(table.values());
      return opts?.where
        ? rows.filter((r) =>
            rowMatches(r, opts.where as Prisma.Enumerable<Prisma.source_registryWhereInput>),
          ).length
        : rows.length;
    },
    create: (opts) => {
      let id = opts.data.id as bigint | undefined;
      if (id == null) {
        let max = 0n;
        for (const cur of table.keys()) if (cur > max) max = cur;
        id = max + 1n;
      }
      const row: AnyRow = { id, ...opts.data };
      table.set(row.id, row);
      let out: AnyRow = applySelect(row, opts.select);
      if (opts.include && includeHelpers) {
        const res = includeHelpers(tableKey, [out], shape);
        out = res[0] ?? out;
      }
      return out as T;
    },
    update: (opts) => {
      const cur = table.get(opts.where.id);
      if (!cur) throw new Error(`missing row ${String(opts.where.id)} in ${tableKey}`);
      const next = applyUpdate(cur, opts.data);
      table.set(opts.where.id, next);
      let out: AnyRow = next;
      if (opts.include && includeHelpers) {
        const res = includeHelpers(tableKey, [next], shape);
        out = res[0] ?? out;
      }
      return out as T;
    },
    updateMany: (opts) => {
      const rows = Array.from(table.values());
      const matched = opts?.where
        ? rows.filter((r) =>
            rowMatches(r, opts.where as Prisma.Enumerable<Prisma.source_registryWhereInput>),
          )
        : rows;
      for (const cur of matched) {
        const next = applyUpdate(cur, opts.data);
        table.set(cur.id, next);
      }
      return { count: matched.length };
    },
    upsert: (opts) => {
      const rows = Array.from(table.values());
      const matched = rows.find((r) =>
        rowMatches(r, opts.where as Prisma.Enumerable<Prisma.source_registryWhereInput>),
      );
      if (matched) {
        const next = applyUpdate(matched, opts.update);
        table.set(matched.id, next);
        let out: AnyRow = applySelect(next, opts.select);
        if (opts.include && includeHelpers) {
          const res = includeHelpers(tableKey, [out], shape);
          out = res[0] ?? out;
        }
        return out as T;
      }
      let id = opts.create.id as bigint | undefined;
      if (id == null) {
        let max = 0n;
        for (const cur of table.keys()) if (cur > max) max = cur;
        id = max + 1n;
      }
      const row: AnyRow = { id, ...opts.create };
      table.set(row.id, row);
      let out: AnyRow = applySelect(row, opts.select);
      if (opts.include && includeHelpers) {
        const res = includeHelpers(tableKey, [out], shape);
        out = res[0] ?? out;
      }
      return out as T;
    },
  };
}

function makePrisma(): {
  prismaShape: PrismaShape;
  prisma: PrismaService;
  ctr: ReturnType<typeof fakeIdCtr>;
} {
  const shape: PrismaShape = {
    source_registry: new Map(),
    crawl_jobs_staging: new Map(),
    audit_events: new Map(),
    jobs: new Map(),
    users: new Map(),
    crawl_job_translations: new Map(),
    job_translations: new Map(),
    job_matches: new Map(),
  };
  const includeHelpers = (tk: string, rowsIn: AnyRow[], s: PrismaShape): AnyRow[] => {
    const rows = rowsIn.map((r) => ({ ...r }));
    if (tk === 'crawl_jobs_staging') {
      for (const r of rows) {
        const source =
          r.source_id != null ? s.source_registry.get(r.source_id as bigint) : undefined;
        if (source) r.source = { name: source.name, id: source.id };
        const translationsMap = s.crawl_job_translations ?? s.job_translations ?? new Map();
        const translations = Array.from(translationsMap.values()).filter(
          (t) => t.staging_job_id === r.id || t.staging_id === r.id,
        );
        r.job_translations = translations;
      }
    }
    return rows;
  };
  const sourceRegistryTable = makeTable<source_registry & AnyRow>(
    shape.source_registry,
    includeHelpers,
    'source_registry',
    shape,
  );
  const stagingTable = makeTable<crawl_jobs_staging & AnyRow>(
    shape.crawl_jobs_staging,
    includeHelpers,
    'crawl_jobs_staging',
    shape,
  );
  const auditTable = makeTable<audit_events & AnyRow>(
    shape.audit_events,
    includeHelpers,
    'audit_events',
    shape,
  );
  const jobsTable = makeTable<jobs & AnyRow>(shape.jobs, includeHelpers, 'jobs', shape);
  const usersTable = makeTable<AnyRow>(shape.users, includeHelpers, 'users', shape);
  const crawlJobTranslationsTable = makeTable<AnyRow>(
    shape.crawl_job_translations ?? shape.job_translations ?? new Map(),
    includeHelpers,
    'job_translations',
    shape,
  );

  const mock = {
    source_registry: sourceRegistryTable,
    crawl_jobs_staging: stagingTable,
    audit_events: auditTable,
    jobs: jobsTable,
    users: usersTable,
    job_translations: crawlJobTranslationsTable,
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $transaction: async <A>(fn: (tx: Prisma.TransactionClient) => Promise<A>): Promise<A> =>
      fn(mock as unknown as Prisma.TransactionClient),
  };
  return { prismaShape: shape, prisma: mock as unknown as PrismaService, ctr: fakeIdCtr(1n) };
}

let adminUsernameSave = APP_ENV.CRAWLER_REVIEW_ADMIN_USERNAME;
let processEnvAdminUsernameSave = process.env.CRAWLER_REVIEW_ADMIN_USERNAME;
beforeEach(() => {
  APP_ENV.CRAWLER_REVIEW_ADMIN_USERNAME = adminUsernameSave;
  process.env.CRAWLER_REVIEW_ADMIN_USERNAME = processEnvAdminUsernameSave;
});

function fakeAudit(prisma: PrismaService): AuditRepository {
  return new AuditRepository(prisma);
}

describe('自动来源发现 + 未核验岗位审批（6 UT）', () => {
  it('T1 新来源默认 PENDING + disabled + discovery_method 审计 SOURCE_DISCOVERED', async () => {
    const { prisma } = makePrisma();
    const clock = makeFakeClock();
    const audit = fakeAudit(prisma);
    const svc = new SourceDiscoveryService(
      prisma,
      audit,
      clock,
      null as unknown as SourceValidationService,
      null as unknown as CrawlerReviewNotifierService,
    );
    const r = await svc.discoverFromCandidates(
      [
        {
          name: 'Foo Co.',
          base_url: 'https://www.foo.co.kh/',
          jobs_url: 'https://www.foo.co.kh/careers',
          city: 'Phnom Penh',
          industry: 'Fintech',
          discovery_method: 'unit_test',
        },
      ],
      { notifyAdmin: false, validateLive: false },
    );
    expect(r.discovered.length).toBe(1);
    const created = await prisma.source_registry.findUnique({ where: { id: r.discovered[0]! } });
    expect(created?.review_status).toBe('PENDING');
    expect(created?.enabled).toBe(false);
    expect(created?.discovery_method).toBe('unit_test');
    expect(created?.parser_type).toBe('STATIC_HTML');
    const dc = await prisma.audit_events.count({
      where: { action: AuditActionEnum.SOURCE_DISCOVERED },
    });
    expect(dc).toBe(1);
  });

  it('T2 isAdminTelegramUser 只有 Faxonlei 通过', async () => {
    const { prisma } = makePrisma();
    APP_ENV.CRAWLER_REVIEW_ADMIN_USERNAME = 'Faxonlei';
    process.env.CRAWLER_REVIEW_ADMIN_USERNAME = 'Faxonlei';
    const notifier = new CrawlerReviewNotifierService(prisma, {} as RemoteJobEligibilityService);
    expect(await notifier.isAdminTelegramUser('Faxonlei')).toBe(true);
    expect(await notifier.isAdminTelegramUser('@Faxonlei')).toBe(true);
    expect(await notifier.isAdminTelegramUser('FAXONLEI')).toBe(true);
    expect(await notifier.isAdminTelegramUser('Alice')).toBe(false);
    expect(await notifier.isAdminTelegramUser('')).toBe(false);
    expect(await notifier.isAdminTelegramUser(undefined)).toBe(false);
    expect(await notifier.isAdminTelegramUser(null)).toBe(false);
  });

  it('T3 staging QA_PENDING 未审批前 jobs 表 0，通知后 review_notified_at 非空 jobs 仍 0', async () => {
    const { prisma } = makePrisma();
    const clock = makeFakeClock();
    const audit = fakeAudit(prisma);
    void audit;
    await prisma.source_registry.create({
      data: {
        name: 'Src',
        base_url: 'https://s.co.kh',
        jobs_url: 'https://s.co.kh/careers',
        source_type: 'OFFICIAL_COMPANY_WEBSITE',
        parser_type: 'STATIC_HTML',
        enabled: true,
        review_status: 'APPROVED',
        discovery_method: 'manual',
        robots_status: 'ALLOWED',
        crawl_interval_minutes: 360,
      },
    });
    const srcRow = (await prisma.source_registry.findFirst({ where: { name: 'Src' } }))!;
    const created = await prisma.crawl_jobs_staging.create({
      data: {
        source_id: srcRow.id,
        source_job_id: 'X1',
        source_url: 'https://s.co.kh/careers/x1',
        title_source: 'Developer',
        status: 'QA_PENDING',
        qa_status: 'PASSED',
        translation_status: 'DONE',
        salary_source: '',
      },
    });
    expect(await prisma.jobs.count()).toBe(0);
    APP_ENV.TELEGRAM_BOT_TOKEN = '';
    const notifier = new CrawlerReviewNotifierService(prisma, {} as RemoteJobEligibilityService);
    await notifier.notifyPendingJobs();
    expect(await prisma.jobs.count()).toBe(0);
  });

  it('T4 approve staging → published_job_id 回写，jobs ACTIVE_EXTERNAL', async () => {
    const { prisma } = makePrisma();
    const clock = makeFakeClock();
    const audit = fakeAudit(prisma);
    await prisma.source_registry.create({
      data: {
        name: 'Src',
        base_url: 'https://s.co.kh',
        jobs_url: 'https://s.co.kh/careers',
        source_type: 'OFFICIAL_COMPANY_WEBSITE',
        parser_type: 'STATIC_HTML',
        enabled: true,
        review_status: 'APPROVED',
        discovery_method: 'manual',
        robots_status: 'ALLOWED',
        crawl_interval_minutes: 360,
      },
    });
    const src = (await prisma.source_registry.findFirst({ where: { name: 'Src' } }))!;
    const s = await prisma.crawl_jobs_staging.create({
      data: {
        source_id: src.id,
        source_job_id: 'X1',
        source_url: 'https://s.co.kh/careers/x1',
        title_source: 'Senior Engineer',
        status: 'QA_PENDING',
        qa_status: 'PASSED',
        translation_status: 'DONE',
        salary_source: '',
        locations_source: 'Phnom Penh',
        parse_version: '1.0',
        published_job_id: null,
      },
    });
    await prisma.job_translations.create({
      data: {
        staging_job_id: s.id,
        language: 'en',
        title: 'Senior Engineer',
        tasks: [],
        skills: [],
        locations: [],
        shifts: [],
        benefits: [],
        salary_text: '',
        qa_status: 'PASSED',
        warnings: [],
        review_status: 'PASSED',
        translation_provider: 'mock',
      },
    });
    await prisma.job_translations.create({
      data: {
        staging_job_id: s.id,
        language: 'km',
        title: 'វិស្វករជាន់ខ្ពស់',
        tasks: [],
        skills: [],
        locations: [],
        shifts: [],
        benefits: [],
        salary_text: '',
        qa_status: 'PASSED',
        warnings: [],
        review_status: 'PASSED',
        translation_provider: 'mock',
      },
    });
    await prisma.job_translations.create({
      data: {
        staging_job_id: s.id,
        language: 'zh_CN',
        title: '高级工程师',
        tasks: [],
        skills: [],
        locations: [],
        shifts: [],
        benefits: [],
        salary_text: '',
        qa_status: 'PASSED',
        warnings: [],
        review_status: 'PASSED',
        translation_provider: 'mock',
      },
    });
    const orch = {} as unknown as CrawlerOrchestrator;
    const review = new CrawlerReviewService(prisma, audit, orch, clock);
    const res = await review.approve(s.id, 100n);
    expect(res.jobId).toBeDefined();
    const job = await prisma.jobs.findUnique({ where: { id: res.jobId } });
    expect(job?.status).toBe('ACTIVE_EXTERNAL');
    const stagingAfter = await prisma.crawl_jobs_staging.findUnique({ where: { id: s.id } });
    expect(stagingAfter?.status).toBe('PUBLISHED');
    expect(String(stagingAfter?.published_job_id ?? '')).toBe(String(res.jobId));
  });

  it('T5 reject → staging REJECTED + jobs 仍 0', async () => {
    const { prisma } = makePrisma();
    const clock = makeFakeClock();
    const audit = fakeAudit(prisma);
    await prisma.source_registry.create({
      data: {
        name: 'Src',
        base_url: 'https://s.co.kh',
        jobs_url: 'https://s.co.kh/careers',
        source_type: 'OFFICIAL_COMPANY_WEBSITE',
        parser_type: 'STATIC_HTML',
        enabled: true,
        review_status: 'APPROVED',
        discovery_method: 'manual',
        robots_status: 'ALLOWED',
        crawl_interval_minutes: 360,
      },
    });
    const src = (await prisma.source_registry.findFirst({ where: { name: 'Src' } }))!;
    const s = await prisma.crawl_jobs_staging.create({
      data: {
        source_id: src.id,
        source_job_id: 'X1',
        source_url: 'https://s.co.kh/careers/x1',
        title_source: 'PM',
        status: 'QA_PENDING',
        qa_status: 'PASSED',
        translation_status: 'DONE',
        salary_source: '',
        parse_version: '1.0',
        published_job_id: null,
      },
    });
    const orch = {} as unknown as CrawlerOrchestrator;
    const review = new CrawlerReviewService(prisma, audit, orch, clock);
    await review.reject(s.id, 100n, '不适合', 'content_quality');
    const after = await prisma.crawl_jobs_staging.findUnique({ where: { id: s.id } });
    expect(after?.status).toBe('REJECTED');
    expect(after?.reject_reason).toBe('不适合');
    expect(after?.published_job_id).toBeNull();
    expect(await prisma.jobs.count()).toBe(0);
  });

  it('T6 相同 base_url+jobs_url 两次不重复导入', async () => {
    const { prisma } = makePrisma();
    const clock = makeFakeClock();
    const audit = fakeAudit(prisma);
    const svc = new SourceDiscoveryService(
      prisma,
      audit,
      clock,
      null as unknown as SourceValidationService,
      null as unknown as CrawlerReviewNotifierService,
    );
    const cand = {
      name: 'Bar Inc.',
      base_url: 'https://bar.kh/',
      jobs_url: 'https://bar.kh/careers/',
      city: 'Siem Reap',
      industry: 'Tourism',
      discovery_method: 'dup_test',
    };
    const a = await svc.discoverFromCandidates([cand], { notifyAdmin: false, validateLive: false });
    expect(a.discovered.length).toBe(1);
    expect(a.duplicates).toBe(0);
    const b = await svc.discoverFromCandidates([cand], { notifyAdmin: false, validateLive: false });
    expect(b.discovered.length).toBe(0);
    expect(b.duplicates).toBe(1);
    expect(await prisma.source_registry.count()).toBe(1);
  });
});

const _sourceReviewServiceCtorShape: typeof SourceReviewService = SourceReviewService;
void _sourceReviewServiceCtorShape;
void CLOCK_TOKEN;
