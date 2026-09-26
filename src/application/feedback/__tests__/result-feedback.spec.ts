import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResultFeedbackService } from '@src/application/feedback/result-feedback.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';

type AnyRow = Record<string, unknown>;

type FakePrisma = {
  db: {
    candidate_profiles: Map<bigint, AnyRow>;
    companies_members: Map<bigint, AnyRow>;
    jobs: Map<bigint, AnyRow>;
  };
  $transaction: <T>(fn: (tx: FakePrisma) => Promise<T>) => Promise<T>;
  candidate_profiles: {
    findFirst: (p: { where?: AnyRow; orderBy?: AnyRow; select?: AnyRow }) => Promise<AnyRow | null>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
  };
  companies_members: {
    findFirst: (p: { where?: AnyRow; select?: AnyRow }) => Promise<AnyRow | null>;
  };
  jobs: {
    findUnique: (p: { where: { id: bigint }; select?: AnyRow }) => Promise<AnyRow | null>;
    update: (p: { where: { id: bigint }; data: AnyRow }) => Promise<AnyRow>;
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

function makeFakePrisma(): FakePrisma {
  const db = {
    candidate_profiles: new Map<bigint, AnyRow>(),
    companies_members: new Map<bigint, AnyRow>(),
    jobs: new Map<bigint, AnyRow>(),
  };
  const prisma: FakePrisma = {
    db,
    $transaction: async (fn) => fn(prisma),
    candidate_profiles: {
      findFirst: async ({ where } = { where: {} }) => {
        const w = where as { user_id?: bigint; id?: bigint };
        const rows = Array.from(db.candidate_profiles.values());
        if (w.user_id != null) return rows.find((r) => r.user_id === w.user_id) ?? null;
        if (w.id != null) return rows.find((r) => r.id === w.id) ?? null;
        return rows[0] ?? null;
      },
      update: async ({ where, data }) => {
        const cur = db.candidate_profiles.get(where.id) ?? {};
        const merged = { ...cur, ...data };
        db.candidate_profiles.set(where.id, merged);
        return merged;
      },
    },
    companies_members: {
      findFirst: async ({ where } = { where: {} }) => {
        const uid = (where as { user_id?: bigint })?.user_id;
        const rows = Array.from(db.companies_members.values());
        return uid != null ? (rows.find((r) => r.user_id === uid) ?? null) : (rows[0] ?? null);
      },
    },
    jobs: {
      findUnique: async ({ where }) => db.jobs.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const cur = db.jobs.get(where.id) ?? {};
        const merged = { ...cur, ...data };
        db.jobs.set(where.id, merged);
        return merged;
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
    version: 1,
    status: 'CONFIRMED',
    deleted_at: null,
    job_search_status: 'LOOKING_JOB',
    job_search_status_updated_at: new Date('2026-09-01T00:00:00Z'),
    job_search_status_source: 'MANUAL',
  });
  prisma.db.companies_members.set(1n, {
    id: 1n,
    company_id: companyId,
    user_id: memberUserId,
    role: 'hr',
    is_owner: true,
  });
  prisma.db.jobs.set(jobId, {
    id: jobId,
    company_id: companyId,
    status: 'ACTIVE_EXTERNAL',
    version: 1,
    hiring_status: 'OPEN',
    hiring_status_updated_at: new Date('2026-09-01T00:00:00Z'),
    hiring_status_source: 'MANUAL',
    closed_at: null,
  });
  return { candUserId, candProfileId, memberUserId, companyId, jobId };
}

describe('ResultFeedbackService (D1a cascade + D1b INFERRED + D1c candidate)', () => {
  let prisma: FakePrisma;
  let clock: FakeClock;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    prisma = makeFakePrisma();
    clock = FakeClock.fromISO('2026-09-24T00:00:00Z');
    audit = makeAudit();
  });

  function svc() {
    return new ResultFeedbackService(prisma as never, audit as never, clock);
  }

  it('D1a 企业 FILLED → 联动 jobs.status=CLOSED + 审计 COMPANY_JOB_STATUS_CHANGED', async () => {
    const s = seed(prisma);
    await svc().updateCompanyHiringStatus(s.memberUserId, s.jobId, 'FILLED');
    const job = prisma.db.jobs.get(s.jobId)!;
    expect(job.hiring_status).toBe('FILLED');
    expect(job.hiring_status_source).toBe('MANUAL');
    expect(job.status).toBe('CLOSED');
    expect(job.closed_at).toBeInstanceOf(Date);
    const records = audit.records.filter(
      (r) => r.action === AuditActionEnum.COMPANY_JOB_STATUS_CHANGED,
    );
    expect(records.length).toBe(1);
    expect(records[0]!.objectType).toBe('jobs');
    expect(records[0]!.objectId).toBe(s.jobId);
    expect(records[0]!.metadata).toMatchObject({
      old_status: 'OPEN',
      new_status: 'FILLED',
      status_source: 'MANUAL',
      company_id: String(s.companyId),
      member_user_id: String(s.memberUserId),
    });
  });

  it('D1a CLOSED/CANCELLED 同样级联 jobs.status=CLOSED；INTERVIEWING 级联不触发', async () => {
    const s = seed(prisma);
    const w = svc();
    await w.updateCompanyHiringStatus(s.memberUserId, s.jobId, 'INTERVIEWING');
    expect(prisma.db.jobs.get(s.jobId)!.status).toBe('ACTIVE_EXTERNAL');
    // reset hiring_status via direct
    prisma.db.jobs.get(s.jobId)!.hiring_status = 'OPEN';
    prisma.db.jobs.get(s.jobId)!.status = 'ACTIVE_EXTERNAL';
    prisma.db.jobs.get(s.jobId)!.closed_at = null;
    await w.updateCompanyHiringStatus(s.memberUserId, s.jobId, 'CLOSED');
    expect(prisma.db.jobs.get(s.jobId)!.status).toBe('CLOSED');
    prisma.db.jobs.get(s.jobId)!.hiring_status = 'OPEN';
    prisma.db.jobs.get(s.jobId)!.status = 'ACTIVE_EXTERNAL';
    prisma.db.jobs.get(s.jobId)!.closed_at = null;
    await w.updateCompanyHiringStatus(s.memberUserId, s.jobId, 'CANCELLED');
    expect(prisma.db.jobs.get(s.jobId)!.status).toBe('CLOSED');
  });

  it('D1b 72h 自动 INFERRED → status_source=INFERRED + from_jt_match=true metadata 记录 + 不触发多次级联（幂等）', async () => {
    const s = seed(prisma);
    await svc().updateCompanyHiringStatus(s.memberUserId, s.jobId, 'FILLED', {
      source: 'INFERRED',
      fromJtMatch: true,
    });
    const job = prisma.db.jobs.get(s.jobId)!;
    expect(job.hiring_status_source).toBe('INFERRED');
    const meta = audit.records.filter(
      (r) => r.action === AuditActionEnum.COMPANY_JOB_STATUS_CHANGED,
    )[0]!.metadata;
    expect(meta.status_source).toBe('INFERRED');
    expect(meta.from_jt_match).toBe('true');
    // 重复 INFERRED 不应该产生多余副作用：audit 仍 1 条
    audit.records.length = 0;
    await svc().updateCompanyHiringStatus(s.memberUserId, s.jobId, 'FILLED', {
      source: 'INFERRED',
      fromJtMatch: true,
    });
    // jobs.status 已 CLOSED，FILLED 再次来仍触发 1 次 audit（事务）；但 side effects 仍然符合：
    expect(audit.records.length).toBe(1);
    expect(audit.records[0]!.metadata.old_status).toBe('FILLED');
    expect(audit.records[0]!.metadata.new_status).toBe('FILLED');
  });

  it('D1b 非成员改 company hiring_status → COMPANY_MEMBERSHIP_REQUIRED（访问控制）', async () => {
    const s = seed(prisma);
    prisma.db.companies_members.delete(1n); // revoke
    await expect(
      svc().updateCompanyHiringStatus(s.memberUserId, s.jobId, 'FILLED'),
    ).rejects.toThrow(/COMPANY_MEMBERSHIP_REQUIRED/);
  });

  it('D1c 求职者 FOUND_JOB → candidate_profiles.job_search_status + CANDIDATE_STATUS_CHANGED 审计（含 related_job_id）', async () => {
    const s = seed(prisma);
    const relatedJobId = 9876n;
    const w = svc();
    const r = await w.updateCandidateJobSearchStatus(s.candUserId, 'FOUND_JOB', {
      source: 'MANUAL',
      relatedJobId,
      fromJtMatch: true,
    });
    expect(r.newStatus).toBe('FOUND_JOB');
    expect(r.oldStatus).toBe('LOOKING_JOB');
    const cand = prisma.db.candidate_profiles.get(s.candProfileId)!;
    expect(cand.job_search_status).toBe('FOUND_JOB');
    expect(cand.job_search_status_source).toBe('MANUAL');
    expect(cand.job_search_status_updated_at).toBeInstanceOf(Date);
    const records = audit.records.filter(
      (x) => x.action === AuditActionEnum.CANDIDATE_STATUS_CHANGED,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.metadata).toMatchObject({
      old_status: 'LOOKING_JOB',
      new_status: 'FOUND_JOB',
      status_source: 'MANUAL',
      related_job_id: String(relatedJobId),
      from_jt_match: 'true',
      candidate_user_id: String(s.candUserId),
    });
  });

  it('D1c 非法 candidate status → PROFILE_ROLE_CONFLICT；DELETED 档案 → PROFILE_PAUSED', async () => {
    const s = seed(prisma);
    const w = svc();
    let err1: unknown = null;
    try {
      await w.updateCandidateJobSearchStatus(s.candUserId, 'INVALID' as never);
    } catch (e) {
      err1 = e;
    }
    expect(err1).not.toBeNull();
    expect((err1 as { code?: string })?.code).toBe('PROFILE_ROLE_CONFLICT');

    const cand = prisma.db.candidate_profiles.get(s.candProfileId)!;
    cand.status = 'DELETED';
    cand.deleted_at = new Date();
    let err2: unknown = null;
    try {
      await w.updateCandidateJobSearchStatus(s.candUserId, 'FOUND_JOB');
    } catch (e) {
      err2 = e;
    }
    expect(err2).not.toBeNull();
    expect((err2 as { code?: string })?.code).toBe('PROFILE_PAUSED');
  });
});
