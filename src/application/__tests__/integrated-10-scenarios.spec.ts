import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MatchWorkflowService } from '@src/application/matching/match-workflow.service';
import { HardMatchService } from '@src/application/matching/hard-match.service';
import { JobApplicationService } from '@src/application/job-application.service';
import { RemoteDailyDigestService } from '@src/application/remote/remote-daily-digest.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { isVisibleToMatches } from '@src/domain/crawler/crawl-job-status-machine';
import type { CrawlJobStatusValue } from '@src/domain/crawler/crawl-job-status-machine';

type AnyRow = Record<string, unknown>;

type FakePrisma = {
  db: {
    candidate_profiles: Map<bigint, AnyRow>;
    companies_members: Map<bigint, AnyRow>;
    jobs: Map<bigint, AnyRow>;
    interests: Map<bigint, AnyRow>;
    matches: Map<bigint, AnyRow>;
    job_applications: Map<bigint, AnyRow>;
    audit_events: Map<bigint, AnyRow>;
    users: Map<bigint, AnyRow>;
  };
  $transaction: <T>(fn: (tx: FakePrisma) => Promise<T>) => Promise<T>;
  candidate_profiles: {
    findFirst: (p: { where?: AnyRow; orderBy?: AnyRow; select?: AnyRow }) => Promise<AnyRow | null>;
    findMany: (p: { where?: AnyRow; select?: AnyRow; take?: number; orderBy?: AnyRow }) => Promise<AnyRow[]>;
  };
  companies_members: {
    findFirst: (p: { where?: AnyRow; include?: AnyRow; select?: AnyRow }) => Promise<AnyRow | null>;
  };
  jobs: {
    findUnique: (p: { where: { id: bigint }; select?: AnyRow }) => Promise<AnyRow | null>;
    findMany: (p: {
      where?: AnyRow;
      select?: AnyRow;
      take?: number;
      orderBy?: AnyRow;
    }) => Promise<AnyRow[]>;
  };
  interests: {
    findFirst: (p: { where?: AnyRow; orderBy?: AnyRow }) => Promise<AnyRow | null>;
    findMany: (p: { where?: AnyRow; select?: AnyRow; take?: number }) => Promise<AnyRow[]>;
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
    updateMany: (p: { where: AnyRow; data: AnyRow }) => Promise<{ count: number }>;
  };
  matches: {
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
  };
  job_applications: {
    findUnique: (p: { where: AnyRow }) => Promise<AnyRow | null>;
    findMany: (p: { where?: AnyRow; take?: number; orderBy?: AnyRow; skip?: number }) => Promise<AnyRow[]>;
    count: (p: { where: AnyRow }) => Promise<number>;
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
  };
  audit_events: {
    findFirst: (p: { where?: AnyRow; select?: AnyRow }) => Promise<AnyRow | null>;
  };
};

function makeAudit() {
  const records: Array<{
    action: string;
    objectType: string;
    objectId: bigint;
    metadata: Record<string, unknown>;
    version?: number;
    actorId?: unknown;
    now?: Date;
  }> = [];
  return {
    records,
    record: vi.fn().mockImplementation(async (r: (typeof records)[number], _tx?: unknown) => {
      records.push(r);
      return true;
    }),
  };
}

let _interestId = 1n;
let _matchId = 1000n;
let _jobAppId = 5000n;
let _auditEventId = 9000n;

function makeFakePrisma(): FakePrisma {
  const db = {
    candidate_profiles: new Map<bigint, AnyRow>(),
    companies_members: new Map<bigint, AnyRow>(),
    jobs: new Map<bigint, AnyRow>(),
    interests: new Map<bigint, AnyRow>(),
    matches: new Map<bigint, AnyRow>(),
    job_applications: new Map<bigint, AnyRow>(),
    audit_events: new Map<bigint, AnyRow>(),
    users: new Map<bigint, AnyRow>(),
  };

  const prisma: FakePrisma = {
    db,
    $transaction: async (fn) => fn(prisma),

    candidate_profiles: {
      findFirst: async ({ where } = { where: {} }) => {
        const w = where as { user_id?: bigint; id?: bigint; deleted_at?: unknown; status?: string };
        const rows = Array.from(db.candidate_profiles.values());
        if (w.deleted_at === null) {
          const filtered = rows.filter((r) => r.deleted_at == null);
          if (w.user_id != null) {
            const cand = filtered.find((r) => r.user_id === w.user_id && r.status === 'CONFIRMED');
            return cand ?? null;
          }
          if (w.id != null) return filtered.find((r) => r.id === w.id) ?? null;
          return filtered[0] ?? null;
        }
        if (w.user_id != null) {
          return rows.find((r) => r.user_id === w.user_id && r.status === 'CONFIRMED') ?? null;
        }
        if (w.id != null) return rows.find((r) => r.id === w.id) ?? null;
        return rows[0] ?? null;
      },
      findMany: async ({ where = {}, take = 9999 } = {}) => {
        const w = where as {
          status?: string;
          deleted_at?: unknown;
          job_search_status?: { in?: string[] };
        };
        let rows = Array.from(db.candidate_profiles.values());
        if (w.status) rows = rows.filter((r) => r.status === w.status);
        if (w.deleted_at === null) rows = rows.filter((r) => r.deleted_at == null);
        if (w.job_search_status?.in?.length) {
          const set = new Set(w.job_search_status.in);
          rows = rows.filter((r) => set.has(String(r.job_search_status)));
        }
        rows.sort((a, b) => ((a.id as bigint) < (b.id as bigint) ? -1 : 1));
        return rows.slice(0, take).map((r) => ({
          id: r.id,
          user_id: r.user_id,
          job_search_status: r.job_search_status,
          user: { telegram_user_id: (db.users.get(r.user_id as bigint)?.telegram_user_id) ?? null },
        }));
      },
    },

    companies_members: {
      findFirst: async ({ where } = { where: {} }) => {
        const uid = (where as { user_id?: bigint })?.user_id;
        const rows = Array.from(db.companies_members.values());
        const r = uid != null ? rows.find((x) => x.user_id === uid) : rows[0];
        return r ? { ...r, company: { id: r.company_id } } : null;
      },
    },

    jobs: {
      findUnique: async ({ where }) => db.jobs.get(where.id) ?? null,
      findMany: async ({ where = {}, take = 500, orderBy } = {}) => {
        const w = where as {
          status?: string;
          id?: { notIn?: bigint[] };
          work_mode?: string;
          eligibility_status?: { in?: string[] };
        };
        let rows = Array.from(db.jobs.values());
        if (w.status) rows = rows.filter((r) => r.status === w.status);
        if (w.id?.notIn?.length) {
          const exclude = new Set(w.id.notIn);
          rows = rows.filter((r) => !exclude.has(r.id as bigint));
        }
        if (w.work_mode) rows = rows.filter((r) => r.work_mode === w.work_mode);
        if (w.eligibility_status?.in?.length) {
          const set = new Set(w.eligibility_status.in);
          rows = rows.filter((r) => set.has(String(r.eligibility_status)));
        }
        rows.sort((a, b) => ((b.id as bigint) < (a.id as bigint) ? -1 : 1));
        return (take ? rows.slice(0, take) : rows).map((j) => ({
          id: j.id,
          title: j.title,
          industry: j.industry,
          skills: j.skills,
          locations: j.locations,
          languages_required: j.languages_required,
          shifts: j.shifts,
          salary_status: j.salary_status,
          salary_text: j.salary_text,
          status: j.status,
          work_mode: j.work_mode,
          remote_scope: j.remote_scope,
          eligible_countries: j.eligible_countries,
          timezone_required: j.timezone_required,
          timezone_overlap_hours: j.timezone_overlap_hours,
          work_authorization: j.work_authorization,
          employment_type: j.employment_type,
          payment_method: j.payment_method,
          salary_currency: j.salary_currency,
          application_url: j.application_url,
          source_platform: j.source_platform,
          source_url: j.source_url,
          eligibility_status: j.eligibility_status,
          published_from_crawl: j.published_from_crawl ?? { status: 'PUBLISHED' },
        }));
      },
    },

    interests: {
      findFirst: async ({ where } = { where: {} }) => {
        const w = where as {
          candidate_id?: bigint;
          job_id?: bigint;
          actor_side?: string;
          status?: string;
        };
        const rows = Array.from(db.interests.values());
        return (
          rows.find(
            (r) =>
              (w.candidate_id == null || r.candidate_id === w.candidate_id) &&
              (w.job_id == null || r.job_id === w.job_id) &&
              (w.actor_side == null || r.actor_side === w.actor_side) &&
              (w.status == null || r.status === w.status),
          ) ?? null
        );
      },
      findMany: async ({ where = {}, take = 9999 } = {}) => {
        const w = where as {
          candidate_id?: bigint;
          status?: string;
          reminded_at?: { lte?: Date; not?: null };
          notified_at?: { lte?: Date; gte?: Date };
        };
        return Array.from(db.interests.values())
          .filter((r) => {
            if (w.candidate_id != null && r.candidate_id !== w.candidate_id) return false;
            if (w.status && r.status !== w.status) return false;
            if (w.notified_at?.lte && new Date(r.notified_at as Date) > w.notified_at.lte) return false;
            if (w.notified_at?.gte && new Date(r.notified_at as Date) < w.notified_at.gte) return false;
            if (w.reminded_at?.not === null && r.reminded_at == null) return false;
            if (
              w.reminded_at?.lte &&
              r.reminded_at &&
              new Date(r.reminded_at as Date) > w.reminded_at.lte
            )
              return false;
            return true;
          })
          .slice(0, take)
          .map((r) => ({
            id: r.id,
            candidate_id: r.candidate_id,
            job_id: r.job_id,
            actor_side: r.actor_side,
          }));
      },
      create: async ({ data }) => {
        const id = ++_interestId;
        const row = { id, ...data, version: (data.version as number) ?? 1 };
        db.interests.set(id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const cur = db.interests.get(where.id) ?? {};
        const merged = { ...cur, ...data };
        db.interests.set(where.id, merged);
        return merged;
      },
      updateMany: async ({ where, data }) => {
        const ids = (where as { id?: { in: bigint[] } }).id?.in ?? [];
        for (const id of ids) {
          const cur = db.interests.get(id) ?? {};
          db.interests.set(id, { ...cur, ...data });
        }
        return { count: ids.length };
      },
    },

    matches: {
      create: async ({ data }) => {
        const id = ++_matchId;
        const row = { id, ...data, status: 'CONTACT_AVAILABLE', contact_opened_at: new Date() };
        db.matches.set(id, row);
        return row;
      },
    },

    job_applications: {
      findUnique: async ({ where }) => {
        const w = where as { id?: bigint; application_cand_job_uq?: { candidate_id: bigint; job_id: bigint } };
        if (w.id != null) return db.job_applications.get(w.id) ?? null;
        const uq = w.application_cand_job_uq;
        if (uq) {
          const rows = Array.from(db.job_applications.values());
          return rows.find((r) => r.candidate_id === uq.candidate_id && r.job_id === uq.job_id) ?? null;
        }
        return null;
      },
      findMany: async ({ where = {}, take = 9999, orderBy, skip = 0 } = {}) => {
        const w = where as {
          candidate_id?: bigint;
          status?: { in?: string[] };
          next_follow_up_at?: { not?: null; lte?: Date };
        };
        let rows = Array.from(db.job_applications.values());
        if (w.candidate_id != null) rows = rows.filter((r) => r.candidate_id === w.candidate_id);
        if (w.status?.in?.length) {
          const set = new Set(w.status.in);
          rows = rows.filter((r) => set.has(String(r.status)));
        }
        if (w.next_follow_up_at && 'not' in w.next_follow_up_at) {
          if (w.next_follow_up_at.not === null) {
            rows = rows.filter((r) => r.next_follow_up_at != null);
          }
          if (w.next_follow_up_at.lte) {
            const cutoff = w.next_follow_up_at.lte as Date;
            rows = rows.filter(
              (r) =>
                r.next_follow_up_at != null &&
                new Date(r.next_follow_up_at as Date) <= cutoff,
            );
          }
        }
        if (orderBy) {
          const o = orderBy as unknown as Array<Record<string, 'asc' | 'desc'>>;
          const firstOrder = o[0];
          if (firstOrder) {
            for (const key in firstOrder) {
              const dir = firstOrder[key];
              rows.sort((a, b) => {
                const av = a[key];
                const bv = b[key];
                if (av == null && bv == null) return 0;
                if (av == null) return dir === 'asc' ? -1 : 1;
                if (bv == null) return dir === 'asc' ? 1 : -1;
                if (av instanceof Date && bv instanceof Date) {
                  return dir === 'asc' ? av.getTime() - bv.getTime() : bv.getTime() - av.getTime();
                }
                return dir === 'asc' ? (av < bv ? -1 : 1) : bv < av ? -1 : 1;
              });
            }
          }
        }
        return rows.slice(skip, skip + take);
      },
      count: async ({ where }) => {
        const w = (where ?? {}) as { candidate_id?: bigint; status?: { in?: string[] } };
        let rows = Array.from(db.job_applications.values());
        if (w.candidate_id != null) rows = rows.filter((r) => r.candidate_id === w.candidate_id);
        if (w.status?.in?.length) {
          const set = new Set(w.status.in);
          rows = rows.filter((r) => set.has(String(r.status)));
        }
        return rows.length;
      },
      create: async ({ data }) => {
        const id = ++_jobAppId;
        const now = new Date();
        const row = {
          id,
          ...data,
          version: 1,
          created_at: now,
          updated_at: now,
        };
        db.job_applications.set(id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const cur = db.job_applications.get(where.id) ?? {};
        const merged = {
          ...cur,
          ...data,
          version: ((cur.version as number) ?? 1) + 1,
          updated_at: new Date(),
        };
        db.job_applications.set(where.id, merged);
        return merged;
      },
    },

    audit_events: {
      findFirst: async ({ where } = { where: {} }) => {
        const w = (where ?? {}) as {
          action?: string;
          metadata?: { path?: string[]; equals?: string };
        };
        const rows = Array.from(db.audit_events.values());
        for (const r of rows) {
          if (w.action && r.action !== w.action) continue;
          if (w.metadata?.path?.length && w.metadata.equals != null) {
            const meta = r.metadata as Record<string, unknown>;
            let val: unknown = meta;
            for (const k of w.metadata.path) {
              if (val && typeof val === 'object') val = (val as Record<string, unknown>)[k];
              else {
                val = undefined;
                break;
              }
            }
            if (val !== w.metadata.equals) continue;
          }
          return { id: r.id };
        }
        return null;
      },
    },
  };

  return prisma;
}

function seedCandidate(prisma: FakePrisma, overrides: Partial<AnyRow> = {}) {
  const candUserId = 500n;
  const candProfileId = 50n;
  dbgUser(prisma, candUserId, 123456789n);
  prisma.db.candidate_profiles.set(candProfileId, {
    id: candProfileId,
    user_id: candUserId,
    version: 3,
    status: 'CONFIRMED',
    deleted_at: null,
    locations: ['Phnom Penh'],
    skills: ['customer service', 'POS'],
    languages_known: ['English', 'Khmer'],
    industries: ['Retail'],
    salary_text: '1500-2000 USD',
    salary_status: 'PROVIDED',
    job_search_status: 'LOOKING_JOB',
    remote_preferred: true,
    remote_scope_preference: 'WORLDWIDE',
    timezone_overlap_hours: 2,
    payment_methods: ['Wise', 'PayPal'],
    preferred_employment_types: ['FULL_TIME'],
    ...overrides,
  });
  return { candUserId, candProfileId };
}

function seedCompany(prisma: FakePrisma) {
  const memberUserId = 600n;
  const companyId = 80n;
  prisma.db.companies_members.set(1n, {
    id: 1n,
    company_id: companyId,
    user_id: memberUserId,
    role: 'hr',
    is_owner: false,
  });
  return { memberUserId, companyId };
}

function dbgUser(prisma: FakePrisma, userId: bigint, telegramUserId: bigint | null) {
  prisma.db.users.set(userId, {
    id: userId,
    telegram_user_id: telegramUserId,
    telegram_username: 'test_user',
  });
}

function seedJob(
  prisma: FakePrisma,
  companyId: bigint,
  overrides: Partial<AnyRow> = {},
  crawlStatus: CrawlJobStatusValue = 'PUBLISHED',
) {
  const jobId = 900n + BigInt(prisma.db.jobs.size);
  prisma.db.jobs.set(jobId, {
    id: jobId,
    company_id: companyId,
    status: 'ACTIVE_EXTERNAL',
    version: 1,
    title: 'Retail Cashier',
    industry: 'Retail',
    skills: ['cashier', 'retail', 'POS'],
    locations: ['Phnom Penh'],
    languages_required: ['English', 'Khmer'],
    shifts: ['FULL_TIME'],
    salary_status: 'PROVIDED',
    salary_text: '1500-2500 USD',
    work_mode: 'ONSITE',
    remote_scope: null,
    eligible_countries: [],
    timezone_required: 'UTC+7',
    timezone_overlap_hours: 4,
    work_authorization: 'NOT_REQUIRED',
    employment_type: 'FULL_TIME',
    payment_method: 'Wise',
    eligibility_status: 'CONFIRMED',
    source_platform: null,
    source_url: null,
    application_url: null,
    published_from_crawl: { status: crawlStatus },
    ...overrides,
  });
  return jobId;
}

function seedAuditEvent(
  prisma: FakePrisma,
  action: string,
  metadata: Record<string, unknown>,
) {
  const id = ++_auditEventId;
  prisma.db.audit_events.set(id, {
    id,
    action,
    object_type: 'candidate_profiles',
    object_id: 50n,
    metadata,
    created_at: new Date(),
  });
  return id;
}

describe('10 Integrated Scenarios (FakePrisma Map + FakeClock)', () => {
  let prisma: FakePrisma;
  let clock: FakeClock;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    _interestId = 1n;
    _matchId = 1000n;
    _jobAppId = 5000n;
    _auditEventId = 9000n;
    prisma = makeFakePrisma();
    clock = FakeClock.fromISO('2026-09-24T10:00:00Z');
    audit = makeAudit();
  });

  // ========== Scenario 1: 翻译失败 status 非 PUBLISHED → isVisibleToMatches=false 隐藏 ==========
  it('S1 翻译失败 status=非PUBLISHED/STALE/EXPIRED → isVisibleToMatches=false → HardMatch.suggest() 隐藏', async () => {
    expect(isVisibleToMatches('PUBLISHED')).toBe(true);
    expect(isVisibleToMatches('TRANSLATED')).toBe(false);
    expect(isVisibleToMatches('STALE')).toBe(false);
    expect(isVisibleToMatches('EXPIRED')).toBe(false);
    expect(isVisibleToMatches('REJECTED')).toBe(false);

    const { candProfileId } = seedCandidate(prisma);
    const { companyId } = seedCompany(prisma);
    seedJob(prisma, companyId, { title: 'JobA Published' }, 'PUBLISHED');
    seedJob(prisma, companyId, { title: 'JobB Stale' }, 'STALE');
    seedJob(prisma, companyId, { title: 'JobC Expired' }, 'EXPIRED');

    const hm = new HardMatchService(prisma as never, audit as never, clock);
    const res = await hm.suggest({ candidateId: candProfileId, limit: 20 });

    const titles = res.jobs.map((j) => j.title);
    expect(titles).toContain('JobA Published');
    expect(titles).not.toContain('JobB Stale');
    expect(titles).not.toContain('JobC Expired');
  });

  // ========== Scenario 2: STALE/EXPIRED status 远程岗位不进入 suggest() ==========
  it('S2 STALE/EXPIRED crawl status 远程 work_mode=REMOTE 岗位被 suggest() 过滤', async () => {
    const { candProfileId } = seedCandidate(prisma);
    const { companyId } = seedCompany(prisma);
    seedJob(
      prisma,
      companyId,
      { title: 'RemoteGood', work_mode: 'REMOTE', remote_scope: 'WORLDWIDE' },
      'PUBLISHED',
    );
    seedJob(
      prisma,
      companyId,
      { title: 'RemoteStale', work_mode: 'REMOTE', remote_scope: 'WORLDWIDE' },
      'STALE',
    );
    seedJob(
      prisma,
      companyId,
      { title: 'RemoteExpired', work_mode: 'REMOTE', remote_scope: 'WORLDWIDE' },
      'EXPIRED',
    );

    const hm = new HardMatchService(prisma as never, audit as never, clock);
    const res = await hm.suggest({ candidateId: candProfileId, limit: 20 });
    const titles = res.jobs.map((j) => j.title);

    expect(titles).toContain('RemoteGood');
    expect(titles).not.toContain('RemoteStale');
    expect(titles).not.toContain('RemoteExpired');
  });

  // ========== Scenario 3: 每日推送 dedupe_key 同日期第二次调用 0 推送 ==========
  it('S3 RemoteDailyDigest 同日期第二次调用 dedupe_key 命中 → sentCandidates=0', async () => {
    const { candUserId, candProfileId } = seedCandidate(prisma);
    const { companyId } = seedCompany(prisma);
    seedJob(
      prisma,
      companyId,
      {
        title: 'RemoteDigestJob',
        work_mode: 'REMOTE',
        remote_scope: 'WORLDWIDE',
        eligibility_status: 'CONFIRMED',
      },
      'PUBLISHED',
    );

    const hm = new HardMatchService(prisma as never, audit as never, clock);
    const digest = new RemoteDailyDigestService(
      prisma as never,
      audit as never,
      hm,
      clock,
    );

    const r1 = await digest.runDailyDigest({ candidateLimit: 10, dryRun: true });
    expect(r1.processedCandidates).toBe(1);
    expect(r1.sentCandidates).toBe(1);
    expect(r1.totalJobsSent).toBeGreaterThanOrEqual(1);

    const todayKey = '2026-09-24';
    const expectedDedupe = `remote:digest:${todayKey}:${candProfileId.toString()}`;

    seedAuditEvent(prisma, AuditActionEnum.REMOTE_DAILY_DIGEST_SENT, {
      dedupe_key: expectedDedupe,
      candidate_user_id: String(candUserId),
    });

    const r2 = await digest.runDailyDigest({ candidateLimit: 10, dryRun: true });
    expect(r2.processedCandidates).toBe(1);
    expect(r2.sentCandidates).toBe(0);
    expect(r2.totalJobsSent).toBe(0);
  });

  // ========== Scenario 4: job_applications 8 状态合法迁移 ==========
  it('S4 JobApplicationService 8 状态 SAVED→APPLYING→APPLIED→SCREENING→INTERVIEW→OFFER→REJECTED→EXPIRED 合法迁移', async () => {
    const { candProfileId } = seedCandidate(prisma);
    const { companyId } = seedCompany(prisma);
    const jobId = seedJob(prisma, companyId);

    const svc = new JobApplicationService(prisma as never, audit as never, clock);

    const r1 = await svc.saveJob({ candidateId: candProfileId, jobId });
    expect(r1.status).toBe('SAVED');

    const r2 = await svc.updateStatus({
      candidateId: candProfileId,
      jobId,
      status: 'APPLYING',
    });
    expect(r2.status).toBe('APPLYING');

    const r3 = await svc.markApplied({ candidateId: candProfileId, jobId });
    expect(r3.status).toBe('APPLIED');
    expect(r3.appliedAt).toBeInstanceOf(Date);
    expect(r3.nextFollowUpAt).toBeInstanceOf(Date);

    const r4 = await svc.updateStatus({
      candidateId: candProfileId,
      jobId,
      status: 'SCREENING',
    });
    expect(r4.status).toBe('SCREENING');

    const r5 = await svc.updateStatus({
      candidateId: candProfileId,
      jobId,
      status: 'INTERVIEW',
    });
    expect(r5.status).toBe('INTERVIEW');

    const r6 = await svc.updateStatus({
      candidateId: candProfileId,
      jobId,
      status: 'OFFER',
    });
    expect(r6.status).toBe('OFFER');

    const r7 = await svc.updateStatus({
      candidateId: candProfileId,
      jobId,
      status: 'REJECTED',
    });
    expect(r7.status).toBe('REJECTED');

    const r8 = await svc.updateStatus({
      candidateId: candProfileId,
      jobId,
      status: 'EXPIRED',
    });
    expect(r8.status).toBe('EXPIRED');
  });

  // ========== Scenario 5: 3d follow-up Cron 到期触发提醒 ==========
  it('S5 markApplied 设置 next_follow_up_at=now+3d → advance clock → runFollowUpRemindersCron notified=1', async () => {
    const { candProfileId } = seedCandidate(prisma);
    const { companyId } = seedCompany(prisma);
    const jobId = seedJob(prisma, companyId);

    const svc = new JobApplicationService(prisma as never, audit as never, clock);
    const applied = await svc.markApplied({ candidateId: candProfileId, jobId });

    const expectedNext = new Date(clock.now().getTime() + 3 * 24 * 60 * 60 * 1000);
    expect(applied.nextFollowUpAt!.getTime()).toBe(expectedNext.getTime());
    expect(applied.status).toBe('APPLIED');
    expect(prisma.db.job_applications.size).toBe(1);

    const dbApp = Array.from(prisma.db.job_applications.values())[0]!;
    expect(dbApp.status).toBe('APPLIED');
    expect(dbApp.next_follow_up_at).toBeInstanceOf(Date);
    expect(new Date(dbApp.next_follow_up_at as Date).getTime()).toBe(expectedNext.getTime());

    clock.advanceDays(3);
    clock.advanceMs(60 * 1000);

    const res = await svc.runFollowUpRemindersCron({ lookAheadMinutes: 60 });
    expect(res.processed).toBe(1);
    expect(res.notified).toBe(1);

    const updated = await prisma.job_applications.findUnique({
      where: { application_cand_job_uq: { candidate_id: candProfileId, job_id: jobId } },
    });
    const newNext = new Date(updated!.next_follow_up_at as Date);
    const expectedNewNext = new Date(clock.now().getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(Math.abs(newNext.getTime() - expectedNewNext.getTime())).toBeLessThan(1000);

    const auditHit = audit.records.find(
      (r) => r.action === AuditActionEnum.FOLLOW_UP_REMINDER_SENT,
    );
    expect(auditHit).toBeDefined();
    expect(auditHit!.metadata.status).toBe('APPLIED');
  });

  // ========== Scenario 6: 双向 expressInterest + REMOTE work_mode + 审计 ==========
  it('S6 双向 expressInterest 远程 REMOTE job → Match CONTACT_AVAILABLE + MATCH_CONTACT_OPENED 审计', async () => {
    const { candUserId, candProfileId } = seedCandidate(prisma);
    const { memberUserId, companyId } = seedCompany(prisma);
    const jobId = seedJob(
      prisma,
      companyId,
      {
        title: 'Remote Dev Job',
        work_mode: 'REMOTE',
        remote_scope: 'WORLDWIDE',
      },
      'PUBLISHED',
    );

    const jobBefore = prisma.db.jobs.get(jobId)!;
    expect(jobBefore.work_mode).toBe('REMOTE');

    const mw = new MatchWorkflowService(prisma as never, audit as never, clock);
    const r1 = await mw.candidateExpressInterest(candUserId, jobId);
    expect(r1.matchCreated).toBe(false);

    const r2 = await mw.companyExpressInterest(memberUserId, jobId, candProfileId);
    expect(r2.matchCreated).toBe(true);
    expect(r2.matchId).not.toBeNull();

    const match = prisma.db.matches.get(r2.matchId!)!;
    expect(match.status).toBe('CONTACT_AVAILABLE');
    expect(match.candidate_id).toBe(candProfileId);
    expect(match.job_id).toBe(jobId);

    const candInt = Array.from(prisma.db.interests.values()).find(
      (i) => i.actor_side === 'CANDIDATE',
    )!;
    const compInt = Array.from(prisma.db.interests.values()).find(
      (i) => i.actor_side === 'COMPANY',
    )!;
    expect(candInt.status).toBe('ACCEPTED');
    expect(compInt.status).toBe('ACCEPTED');

    const auditHit = audit.records.find(
      (r) => r.action === AuditActionEnum.MATCH_CONTACT_OPENED,
    );
    expect(auditHit).toBeDefined();
    expect(auditHit!.objectType).toBe('matches');
    expect(auditHit!.objectId).toBe(r2.matchId!);
    expect((auditHit!.metadata as Record<string, unknown>).candidate_id).toBe(
      String(candProfileId),
    );
    expect((auditHit!.metadata as Record<string, unknown>).job_id).toBe(String(jobId));
  });

  // ========== Scenario 7: NOT_ELIGIBLE 岗位打分 -1 → suggest() 过滤 ==========
  it('S7 eligibility_status=NOT_ELIGIBLE → 打分 -1，suggest() 结果中过滤掉', async () => {
    const { candProfileId } = seedCandidate(prisma);
    const { companyId } = seedCompany(prisma);
    seedJob(prisma, companyId, { title: 'NormalJob', eligibility_status: 'CONFIRMED' }, 'PUBLISHED');
    seedJob(
      prisma,
      companyId,
      { title: 'NotEligibleJob', eligibility_status: 'NOT_ELIGIBLE' },
      'PUBLISHED',
    );

    const hm = new HardMatchService(prisma as never, audit as never, clock);
    const res = await hm.suggest({ candidateId: candProfileId, limit: 20 });
    const titles = res.jobs.map((j) => j.title);

    expect(titles).toContain('NormalJob');
    expect(titles).not.toContain('NotEligibleJob');
  });

  // ========== Scenario 8: NEEDS_CONFIRMATION 仍推荐但 needToConfirm 长度 >0 ==========
  it('S8 eligibility_status=NEEDS_CONFIRMATION → 仍出现在 suggest 中，needToConfirm.length > 0', async () => {
    const { candProfileId } = seedCandidate(prisma);
    const { companyId } = seedCompany(prisma);
    seedJob(
      prisma,
      companyId,
      { title: 'NeedsConfirmJob', eligibility_status: 'NEEDS_CONFIRMATION' },
      'PUBLISHED',
    );

    const hm = new HardMatchService(prisma as never, audit as never, clock);
    const res = await hm.suggest({ candidateId: candProfileId, limit: 20 });
    const target = res.jobs.find((j) => j.title === 'NeedsConfirmJob');

    expect(target).toBeDefined();
    expect(target!.needToConfirm.length).toBeGreaterThan(0);
    expect(target!.eligibility).toBe('NEEDS_CONFIRMATION');
  });

  // ========== Scenario 9: remoteScope:true 仅返回 REMOTE 岗位 ==========
  it('S9 HardMatch.suggest({remoteScope:true}) 仅返回 work_mode=REMOTE 岗位', async () => {
    const { candProfileId } = seedCandidate(prisma);
    const { companyId } = seedCompany(prisma);
    seedJob(
      prisma,
      companyId,
      {
        title: 'OnsiteCashier',
        work_mode: 'ONSITE',
        eligibility_status: 'CONFIRMED',
      },
      'PUBLISHED',
    );
    seedJob(
      prisma,
      companyId,
      {
        title: 'HybridRole',
        work_mode: 'HYBRID',
        eligibility_status: 'CONFIRMED',
      },
      'PUBLISHED',
    );
    seedJob(
      prisma,
      companyId,
      {
        title: 'RemoteDev',
        work_mode: 'REMOTE',
        remote_scope: 'WORLDWIDE',
        eligibility_status: 'CONFIRMED',
      },
      'PUBLISHED',
    );
    seedJob(
      prisma,
      companyId,
      {
        title: 'RemoteDesign',
        work_mode: 'REMOTE',
        remote_scope: 'ASEAN',
        eligibility_status: 'NEEDS_CONFIRMATION',
      },
      'PUBLISHED',
    );

    const hm = new HardMatchService(prisma as never, audit as never, clock);
    const res = await hm.suggest({ candidateId: candProfileId, remoteScope: true, limit: 20 });

    expect(res.jobs.length).toBeGreaterThan(0);
    for (const j of res.jobs) {
      expect(j.workMode).toBe('REMOTE');
    }
    const titles = res.jobs.map((j) => j.title);
    expect(titles).toContain('RemoteDev');
    expect(titles).toContain('RemoteDesign');
    expect(titles).not.toContain('OnsiteCashier');
    expect(titles).not.toContain('HybridRole');
  });

  // ========== Scenario 10: follow-up 期间 job 关闭 → 停止提醒 ==========
  it('S10 follow-up 期间 job 关闭 → application 状态改为 EXPIRED → 下次 cron 不再提醒（停止）', async () => {
    const { candProfileId } = seedCandidate(prisma);
    const { companyId } = seedCompany(prisma);
    const jobId = seedJob(prisma, companyId, { status: 'ACTIVE_EXTERNAL' });

    const svc = new JobApplicationService(prisma as never, audit as never, clock);
    await svc.markApplied({ candidateId: candProfileId, jobId });

    clock.advanceDays(3);
    clock.advanceMs(60 * 1000);

    const r1 = await svc.runFollowUpRemindersCron({ lookAheadMinutes: 60 });
    expect(r1.notified).toBe(1);

    const jobRow = prisma.db.jobs.get(jobId)!;
    jobRow.status = 'CLOSED';
    jobRow.closed_at = new Date(clock.now().getTime());

    await svc.updateStatus({
      candidateId: candProfileId,
      jobId,
      status: 'EXPIRED',
      notes: 'Job closed, stopping follow-up',
    });

    clock.advanceDays(7);

    const r2 = await svc.runFollowUpRemindersCron({ lookAheadMinutes: 60 });
    expect(r2.processed).toBe(0);
    expect(r2.notified).toBe(0);

    const afterApp = await prisma.job_applications.findUnique({
      where: { application_cand_job_uq: { candidate_id: candProfileId, job_id: jobId } },
    });
    expect(afterApp!.status).toBe('EXPIRED');
  });
});
