import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MatchWorkflowService } from '@src/application/matching/match-workflow.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';

type AnyRow = Record<string, unknown>;

type FakePrisma = {
  db: {
    candidate_profiles: Map<bigint, AnyRow>;
    companies_members: Map<bigint, AnyRow>;
    jobs: Map<bigint, AnyRow>;
    interests: Map<bigint, AnyRow>;
    matches: Map<bigint, AnyRow>;
  };
  $transaction: <T>(fn: (tx: FakePrisma) => Promise<T>) => Promise<T>;
  candidate_profiles: {
    findFirst: (p: { where?: AnyRow; orderBy?: AnyRow; select?: AnyRow }) => Promise<AnyRow | null>;
  };
  companies_members: {
    findFirst: (p: { where?: AnyRow; include?: AnyRow }) => Promise<AnyRow | null>;
  };
  jobs: {
    findUnique: (p: { where: { id: bigint }; select?: AnyRow }) => Promise<AnyRow | null>;
  };
  interests: {
    findFirst: (p: { where?: AnyRow; orderBy?: AnyRow }) => Promise<AnyRow | null>;
    findMany: (p: { where: AnyRow; select?: AnyRow; take?: number }) => Promise<AnyRow[]>;
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
    updateMany: (p: { where: AnyRow; data: AnyRow }) => Promise<{ count: number }>;
  };
  matches: {
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
  };
};

function makeAudit() {
  const records: Array<{
    action: string;
    objectType: string;
    objectId: bigint;
    metadata: Record<string, unknown>;
  }> = [];
  return {
    records,
    record: vi.fn().mockImplementation(async (r: (typeof records)[number]) => {
      records.push(r);
    }),
  };
}

function notifierFake() {
  const sent: Array<{ headline: string; lines?: string[]; footer?: string }> = [];
  return {
    sent,
    notifyAdminGeneric: vi.fn().mockImplementation(async (payload: (typeof sent)[number]) => {
      sent.push(payload);
      return true;
    }),
  };
}

let _interestId = 1n;
let _matchId = 1000n;

function makeFakePrisma(): FakePrisma {
  const db = {
    candidate_profiles: new Map<bigint, AnyRow>(),
    companies_members: new Map<bigint, AnyRow>(),
    jobs: new Map<bigint, AnyRow>(),
    interests: new Map<bigint, AnyRow>(),
    matches: new Map<bigint, AnyRow>(),
  };
  const prisma: FakePrisma = {
    db,
    $transaction: async (fn) => fn(prisma),
    candidate_profiles: {
      findFirst: async ({ where } = { where: {} }) => {
        const w = where as { user_id?: bigint; id?: bigint; deleted_at?: unknown; status?: string };
        const rows = Array.from(db.candidate_profiles.values());
        if (w.user_id != null) {
          return rows.find((r) => r.user_id === w.user_id && r.status === 'CONFIRMED') ?? null;
        }
        if (w.id != null) return rows.find((r) => r.id === w.id) ?? null;
        return rows[0] ?? null;
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
      findMany: async ({ where, take } = { where: {}, take: 9999 }) => {
        const w = where as {
          status?: string;
          reminded_at?: { lte?: Date; not?: null };
          notified_at?: { lte?: Date; gte?: Date };
        };
        return Array.from(db.interests.values())
          .filter((r) => {
            if (w.status && r.status !== w.status) return false;
            if (w.notified_at?.lte && new Date(r.notified_at as Date) > w.notified_at.lte)
              return false;
            if (w.notified_at?.gte && new Date(r.notified_at as Date) < w.notified_at.gte)
              return false;
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
        const row = { id, ...data };
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
  };
  return prisma;
}

function seed(prisma: FakePrisma) {
  const candUserId = 500n;
  const candProfileId = 50n;
  const memberUserId = 600n;
  const companyId = 80n;
  const jobId = 900n;
  prisma.db.candidate_profiles.set(candProfileId, {
    id: candProfileId,
    user_id: candUserId,
    version: 3,
    status: 'CONFIRMED',
    deleted_at: null,
  });
  prisma.db.companies_members.set(1n, {
    id: 1n,
    company_id: companyId,
    user_id: memberUserId,
    role: 'hr',
    is_owner: false,
  });
  prisma.db.jobs.set(jobId, {
    id: jobId,
    company_id: companyId,
    status: 'ACTIVE_EXTERNAL',
    version: 1,
  });
  return { candUserId, candProfileId, memberUserId, companyId, jobId };
}

describe('MatchWorkflowService (C2a match + C2b audit + C2c cron)', () => {
  let prisma: FakePrisma;
  let clock: FakeClock;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    _interestId = 1n;
    _matchId = 1000n;
    prisma = makeFakePrisma();
    clock = FakeClock.fromISO('2026-09-24T10:00:00Z');
    audit = makeAudit();
  });

  function svc(n?: ReturnType<typeof notifierFake>) {
    return new MatchWorkflowService(
      prisma as never,
      audit as never,
      clock,
      n ? (n as unknown as never) : undefined,
    );
  }

  it('C2a 候选先表达兴趣 → 无 Match → matchCreated=false；再企业兴趣 → Match CONTACT_AVAILABLE + 双 ACCEPTED', async () => {
    const s = seed(prisma);
    const w = svc();
    const r1 = await w.candidateExpressInterest(s.candUserId, s.jobId);
    expect(r1.matchCreated).toBe(false);
    expect(r1.matchId).toBeNull();
    const candInterest = Array.from(prisma.db.interests.values()).find(
      (i) => i.actor_side === 'CANDIDATE',
    );
    expect(candInterest!.status).toBe('PENDING');
    const r2 = await w.companyExpressInterest(s.memberUserId, s.jobId, s.candProfileId);
    expect(r2.matchCreated).toBe(true);
    expect(r2.matchId).not.toBeNull();
    const finalInterests = Array.from(prisma.db.interests.values());
    expect(finalInterests.every((i) => i.status === 'ACCEPTED')).toBe(true);
    const match = prisma.db.matches.get(r2.matchId!)!;
    expect(match.status).toBe('CONTACT_AVAILABLE');
    expect(match.candidate_id).toBe(s.candProfileId);
    expect(match.job_id).toBe(s.jobId);
  });

  it('C2b Match 创建 → 审计 MATCH_CONTACT_OPENED 写入（metadata.candidate_id + job_id）', async () => {
    const s = seed(prisma);
    const w = svc();
    await w.candidateExpressInterest(s.candUserId, s.jobId);
    const before = audit.records.filter(
      (r) => r.action === AuditActionEnum.MATCH_CONTACT_OPENED,
    ).length;
    await w.companyExpressInterest(s.memberUserId, s.jobId, s.candProfileId);
    const afterMatchRecords = audit.records.filter(
      (r) => r.action === AuditActionEnum.MATCH_CONTACT_OPENED,
    );
    expect(afterMatchRecords.length).toBe(before + 1);
    const latest = afterMatchRecords[afterMatchRecords.length - 1]!;
    expect(latest.objectType).toBe('matches');
    expect(latest.metadata.candidate_id).toBe(String(s.candProfileId));
    expect(latest.metadata.job_id).toBe(String(s.jobId));
    expect(Array.from(prisma.db.matches.values()).map((m) => m.id)).toContain(latest.objectId);
  });

  it('C2a 重复同 side PENDING 兴趣 → INTEREST_ALREADY_EXISTS 幂等保护', async () => {
    const s = seed(prisma);
    const w = svc();
    await w.candidateExpressInterest(s.candUserId, s.jobId);
    let err: unknown = null;
    try {
      await w.candidateExpressInterest(s.candUserId, s.jobId);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect((err as { code?: string })?.code).toBe('INTEREST_ALREADY_EXISTS');
  });

  it('C2a 企业成员不属于该 job.company_id → COMPANY_MEMBERSHIP_REQUIRED', async () => {
    const s = seed(prisma);
    // create job with DIFFERENT company (not company 80)
    prisma.db.jobs.set(999n, { id: 999n, company_id: 888n, status: 'ACTIVE_EXTERNAL', version: 1 });
    const w = svc();
    await expect(w.companyExpressInterest(s.memberUserId, 999n, s.candProfileId)).rejects.toThrow(
      /COMPANY_MEMBERSHIP_REQUIRED/,
    );
  });

  it('C2c run24hReminder 24h 未处理 → reminded_at 写入 + notifyAdminGeneric 提醒', async () => {
    const s = seed(prisma);
    const w = svc();
    await w.candidateExpressInterest(s.candUserId, s.jobId);
    // move clock 24h 1 minute later
    clock = FakeClock.fromISO('2026-09-25T10:01:00Z');
    const n = notifierFake();
    const w2 = new MatchWorkflowService(prisma as never, audit as never, clock, n as never);
    const stats = await w2.run24hReminder();
    expect(stats.reminded).toBe(1);
    const interest = Array.from(prisma.db.interests.values()).find(
      (i) => i.actor_side === 'CANDIDATE',
    )!;
    expect(interest.reminded_at).toBeInstanceOf(Date);
    expect(n.sent.length).toBe(1);
    expect(n.sent[0]!.headline).toContain('24h 未处理兴趣提醒');
  });

  it('C2c 72h 已提醒未回应 → run72hPause status=EXPIRED processed_at 写入', async () => {
    const s = seed(prisma);
    const w = svc();
    await w.candidateExpressInterest(s.candUserId, s.jobId);
    // simulate 24h reminder
    const n = notifierFake();
    clock = FakeClock.fromISO('2026-09-25T10:01:00Z');
    const w2 = new MatchWorkflowService(prisma as never, audit as never, clock, n as never);
    await w2.run24hReminder();
    clock = FakeClock.fromISO('2026-09-28T10:01:00Z'); // + 72h+ after reminded_at
    const w3 = new MatchWorkflowService(prisma as never, audit as never, clock, n as never);
    const stats = await w3.run72hPause();
    expect(stats.paused).toBe(1);
    const interest = Array.from(prisma.db.interests.values()).find(
      (i) => i.actor_side === 'CANDIDATE',
    )!;
    expect(interest.status).toBe('EXPIRED');
    expect(interest.processed_at).toBeInstanceOf(Date);
  });

  it('C2c lastRunLock 防重入：连续 2 次 run24hReminder → 第二次返回 {reminded:0}', async () => {
    const s = seed(prisma);
    const w = svc();
    await w.candidateExpressInterest(s.candUserId, s.jobId);
    clock = FakeClock.fromISO('2026-09-25T10:01:00Z');
    const n = notifierFake();
    const w2 = new MatchWorkflowService(prisma as never, audit as never, clock, n as never);
    // simulate lock: call once (lock released in finally), then twice manually set lock=true
    const r1 = await w2.run24hReminder();
    expect(r1.reminded).toBe(1);
    // force the lock before the 2nd call (bypass private check via record indexing):
    (w2 as unknown as Record<string, unknown>)['matchReminder24Lock'] = true;
    const r2 = await w2.run24hReminder();
    expect(r2.reminded).toBe(0);
  });
});
