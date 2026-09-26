import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpsStatsService, type OpsStats } from '@src/application/ops/ops-stats.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';

type AnyRow = Record<string, unknown>;

type Countable<T = unknown> = T & { $rows: AnyRow[] };

type FakePrisma = {
  db: {
    users: Map<bigint, AnyRow>;
    candidate_profiles: Map<bigint, AnyRow>;
    companies: Map<bigint, AnyRow>;
    jobs: Map<bigint, AnyRow>;
    crawl_jobs_staging: Map<bigint, AnyRow>;
    interests: Map<bigint, AnyRow>;
    matches: Map<bigint, AnyRow>;
    source_registry: Map<bigint, AnyRow>;
  };
  $queryRaw: <T>(_q: TemplateStringsArray, ..._args: unknown[]) => Promise<T>;
  users: { count: (p?: AnyRow) => Promise<number> };
  candidate_profiles: { count: (p?: AnyRow) => Promise<number> };
  companies: { count: (p?: AnyRow) => Promise<number> };
  jobs: { count: (p?: AnyRow) => Promise<number> };
  crawl_jobs_staging: { count: (p?: AnyRow) => Promise<number> };
  interests: { count: (p?: AnyRow) => Promise<number> };
  matches: { count: (p?: AnyRow) => Promise<number> };
  source_registry: { count: (p?: AnyRow) => Promise<number> };
};

function applyWhereOperator(rowValue: unknown, opValue: unknown, op: string): boolean {
  switch (op) {
    case 'gte': {
      if (opValue instanceof Date && rowValue instanceof Date) return rowValue >= opValue;
      if (opValue instanceof Date && rowValue) return new Date(String(rowValue)) >= opValue;
      return (rowValue as number) >= (opValue as number);
    }
    case 'lte': {
      if (opValue instanceof Date && rowValue instanceof Date) return rowValue <= opValue;
      if (opValue instanceof Date && rowValue) return new Date(String(rowValue)) <= opValue;
      return (rowValue as number) <= (opValue as number);
    }
    case 'in': {
      const arr = opValue as unknown[];
      return arr.includes(rowValue) || arr.includes(String(rowValue));
    }
    case 'not': {
      if (opValue === null) return rowValue != null;
      return rowValue !== opValue;
    }
    default:
      return true;
  }
}

function matchesWhereField(row: AnyRow, fieldValue: unknown, whereVal: unknown): boolean {
  if (whereVal == null) {
    // exact null match: row value must also be null/undefined
    if (whereVal === null) return row[fieldValue as string] == null;
    return true;
  }
  if (typeof whereVal !== 'object' || whereVal instanceof Date) {
    // exact equality match (string/bigint/number/date)
    return String(row[fieldValue as string]) === String(whereVal);
  }
  // object with operators (gte/lte/in/not)
  const ops = whereVal as Record<string, unknown>;
  for (const op of Object.keys(ops)) {
    if (!applyWhereOperator(row[fieldValue as string], ops[op], op)) return false;
  }
  return true;
}

function matchWhere(row: AnyRow, where: AnyRow | undefined): boolean {
  if (!where) return true;
  const keys = Object.keys(where);
  let orClauses: AnyRow[] | undefined;
  for (const k of keys) {
    if (k === 'OR') {
      orClauses = (where as { OR: AnyRow[] }).OR;
      continue;
    }
    if (!matchesWhereField(row, k, where[k])) return false;
  }
  if (orClauses && orClauses.length) {
    const ok = orClauses.some((clause) => matchWhere(row, clause));
    if (!ok) return false;
  }
  return true;
}

function makeFakePrisma(): {
  prisma: FakePrisma;
  addId: <T extends AnyRow>(m: Map<bigint, AnyRow>, row: T) => T & { id: bigint };
} {
  const db: FakePrisma['db'] = {
    users: new Map(),
    candidate_profiles: new Map(),
    companies: new Map(),
    jobs: new Map(),
    crawl_jobs_staging: new Map(),
    interests: new Map(),
    matches: new Map(),
    source_registry: new Map(),
  };
  let counter = 1n;
  const addId = <T extends AnyRow>(m: Map<bigint, AnyRow>, row: T): T & { id: bigint } => {
    const id = counter++;
    const r = { id, ...row } as T & { id: bigint };
    m.set(id, r);
    return r;
  };
  const countFor = (m: Map<bigint, AnyRow>, whereArg: AnyRow | undefined) => {
    const w = (whereArg as { where?: AnyRow } | undefined)?.where;
    const rows = Array.from(m.values());
    if (!w) return Promise.resolve(rows.length);
    return Promise.resolve(rows.filter((r) => matchWhere(r, w)).length);
  };
  const prisma: FakePrisma = {
    db,
    $queryRaw: vi.fn().mockResolvedValue([{ cnt: 0 }]),
    users: { count: (p) => countFor(db.users, p) },
    candidate_profiles: { count: (p) => countFor(db.candidate_profiles, p) },
    companies: { count: (p) => countFor(db.companies, p) },
    jobs: { count: (p) => countFor(db.jobs, p) },
    crawl_jobs_staging: { count: (p) => countFor(db.crawl_jobs_staging, p) },
    interests: { count: (p) => countFor(db.interests, p) },
    matches: { count: (p) => countFor(db.matches, p) },
    source_registry: { count: (p) => countFor(db.source_registry, p) },
  };
  return { prisma, addId };
}

function seedForReversal(
  addId: ReturnType<typeof makeFakePrisma>['addId'],
  prisma: FakePrisma,
  now: Date,
) {
  const w30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const d = (offsetDays: number) => new Date(w30.getTime() + offsetDays * 24 * 3600 * 1000);
  // 10 total jobs (lifecycle=10) of which 2 stale-closed within window -> effective=80%
  for (let i = 0; i < 8; i++) {
    addId(prisma.db.jobs, {
      status: 'ACTIVE_EXTERNAL',
      created_at: d(i + 1),
      closed_reason: null,
      closed_at: null,
      hiring_status: 'OPEN',
      hiring_status_updated_at: now,
    });
  }
  for (let i = 0; i < 2; i++) {
    addId(prisma.db.jobs, {
      status: 'CLOSED',
      created_at: d(2 + i),
      closed_reason: 'STALE',
      closed_at: d(5 + i),
      hiring_status: 'CLOSED',
      hiring_status_updated_at: d(5 + i),
    });
  }
  // 10 interests created within 30d, 4 responded within 24h (40%)
  for (let i = 0; i < 10; i++) {
    addId(prisma.db.interests, {
      created_at: d(2 + i),
      notified_at: d(2 + i),
      processed_at: i < 4 ? new Date(d(2 + i).getTime() + 3 * 3600 * 1000) : null,
      status: i < 4 ? 'ACCEPTED' : 'PENDING',
      reminded_at: i === 0 ? new Date(d(2 + i).getTime() + 24 * 3600 * 1000) : null,
    });
  }
  // 2 CONTACT_AVAILABLE matches within window over 10 interests -> 20%
  for (let i = 0; i < 2; i++) {
    addId(prisma.db.matches, {
      created_at: d(6 + i),
      status: 'CONTACT_AVAILABLE',
      contact_opened_at: d(6 + i),
    });
  }
  // 1 interview within window: audit-events via $queryRaw override below returns 1
}

describe('OpsStatsService (E1 reversal 30d window + PASS/WARN panel formatting)', () => {
  let prisma: FakePrisma;
  let addId: ReturnType<typeof makeFakePrisma>['addId'];
  let clock: FakeClock;

  beforeEach(() => {
    const p = makeFakePrisma();
    prisma = p.prisma;
    addId = p.addId;
    clock = FakeClock.fromISO('2026-09-24T10:00:00Z');
  });

  function svc() {
    return new OpsStatsService(prisma as never, clock);
  }

  it('E1 reversal30d 4 字段 30d 窗口 count 正确（有效率=80% / 24h 响应率=40% / 联系率=20% / 面试率=10%）', async () => {
    seedForReversal(addId, prisma, clock.now());
    prisma.$queryRaw = vi.fn().mockResolvedValue([{ cnt: 1 }]); // 1 interview
    const s = await svc().getOpsStats();
    expect(s.reversal30d.windowDays).toBe(30);
    expect(s.reversal30d.effectiveJobRatePct).toBeCloseTo(80, 0);
    expect(s.reversal30d.companyResponse24hPct).toBe(40);
    expect(s.reversal30d.contactOpenRatePct).toBe(20);
    expect(s.reversal30d.interviewRatePct).toBe(10);
  });

  it('E1 PASS/WARN 阈值判定：反转阈值 70/30/20/5 低于触发 WARN', async () => {
    // populate weak data below thresholds
    const now = clock.now();
    const w30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const d = (off: number) => new Date(w30.getTime() + off * 24 * 3600 * 1000);
    // 10 jobs in lifecycle, 5 STALE → 50% (below 70% → WARN)
    for (let i = 0; i < 5; i++)
      addId(prisma.db.jobs, { status: 'ACTIVE_EXTERNAL', created_at: d(i) });
    for (let i = 0; i < 5; i++)
      addId(prisma.db.jobs, {
        status: 'CLOSED',
        created_at: d(i),
        closed_at: d(i + 2),
        closed_reason: 'DEADLINE',
      });
    // 20 interests, 4 responded within 24h -> 20% (<30% WARN)
    for (let i = 0; i < 20; i++)
      addId(prisma.db.interests, {
        created_at: d(i),
        notified_at: d(i),
        processed_at: i < 4 ? new Date(d(i).getTime() + 12 * 3600 * 1000) : null,
        status: i < 4 ? 'ACCEPTED' : 'PENDING',
      });
    // 100 interests total (20 + 80 pending dummy): contact 1 / 20 = 5% (<20% WARN)
    // contact matches: 1 / 20 = 5% (<20% WARN)
    addId(prisma.db.matches, {
      created_at: d(5),
      status: 'CONTACT_AVAILABLE',
      contact_opened_at: d(5),
    });
    prisma.$queryRaw = vi.fn().mockResolvedValue([{ cnt: 0 }]); // 0 interviews
    const svc2 = svc();
    const s = await svc2.getOpsStats();
    const asc = svc2.formatAscii(s);
    const tg = svc2.formatTelegram(s);
    expect(s.reversal30d.effectiveJobRatePct).toBe(50);
    expect(s.reversal30d.companyResponse24hPct).toBe(20);
    expect(s.reversal30d.contactOpenRatePct).toBe(5);
    expect(s.reversal30d.interviewRatePct).toBe(0);
    expect(asc).toContain('⚠️ WARN');
    expect(tg).toContain('⚠️');
    // All 4 should be ⚠️ -> count them
    expect((asc.match(/⚠️/g) || []).length).toBeGreaterThanOrEqual(4);
    expect((tg.match(/⚠️/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('E1 window 内数据空 → 反转率 null（不误触发 WARN）', async () => {
    const s = await svc().getOpsStats();
    expect(s.reversal30d.effectiveJobRatePct).toBeNull();
    expect(s.reversal30d.companyResponse24hPct).toBeNull();
    expect(s.reversal30d.contactOpenRatePct).toBeNull();
    expect(s.reversal30d.interviewRatePct).toBeNull();
    const asc = svc().formatAscii(s);
    expect(asc).toContain('🛡️  反转条件预警');
    // null 显示 N/A -> PASS (effectiveJobOk → (null ?? 100)>=70)
    expect(asc).toMatch(/✅ PASS[\s\S]*✅ PASS[\s\S]*✅ PASS[\s\S]*✅ PASS/);
  });

  it('E1 验收面板 + 反转面板字段顺序：CLI/Telegram 顶部首屏显示🛡️ / 🎯 区块', async () => {
    seedForReversal(addId, prisma, clock.now());
    prisma.$queryRaw = vi.fn().mockResolvedValue([{ cnt: 1 }]);
    const svc2 = svc();
    const s = await svc2.getOpsStats();
    const asc = svc2.formatAscii(s);
    const tg = svc2.formatTelegram(s);
    const ascIdx1 = asc.indexOf('🛡️');
    const ascIdx2 = asc.indexOf('🎯');
    expect(ascIdx1).toBeGreaterThan(-1);
    expect(ascIdx2).toBeGreaterThan(ascIdx1);
    const tgIdx1 = tg.indexOf('🛡️');
    const tgIdx2 = tg.indexOf('🎯');
    expect(tgIdx1).toBeGreaterThan(-1);
    expect(tgIdx2).toBeGreaterThan(tgIdx1);
    expect(asc).toContain('window=30d');
    expect(tg).toContain('窗口 30 天');
  });

  it('E1 14 天试点验收 6 项 PASS/▫️ 图标在 Telegram 仍正确（>=10 jobs 等）', async () => {
    const now = clock.now();
    for (let i = 0; i < 50; i++) addId(prisma.db.users, {});
    for (let i = 0; i < 35; i++)
      addId(prisma.db.candidate_profiles, {
        status: 'CONFIRMED',
        deleted_at: null,
        user_id: BigInt(i + 1),
      });
    for (let i = 0; i < 15; i++) addId(prisma.db.jobs, { status: 'ACTIVE_EXTERNAL' });
    for (let i = 0; i < 15; i++) addId(prisma.db.interests, {});
    for (let i = 0; i < 5; i++) addId(prisma.db.matches, { status: 'CONTACT_AVAILABLE' });
    prisma.$queryRaw = vi.fn().mockResolvedValue([{ cnt: 2 }]);
    const svc2 = svc();
    const s = await svc2.getOpsStats();
    const tg = svc2.formatTelegram(s);
    const icons = tg.match(/🎯[\s\S]*?(?:✅|▫️)/g)?.length ?? 0;
    expect(icons).toBeGreaterThan(0);
    // 6 items expected all ✅
    const ok = (tg.match(/✅/g) || []).length;
    expect(ok).toBeGreaterThanOrEqual(6 + 4); // 6 pilot + 4 reversal
  });
});
