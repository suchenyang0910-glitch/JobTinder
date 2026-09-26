import { describe, it, expect, beforeEach } from 'vitest';
import { HardMatchService } from '@src/application/matching/hard-match.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import type { candidate_profiles } from '@prisma/client';

type AnyRow = Record<string, unknown>;

type FakePrisma = {
  db: {
    candidate_profiles: Map<bigint, AnyRow>;
    jobs: Map<bigint, AnyRow>;
    interests: Map<bigint, AnyRow>;
  };
  candidate_profiles: {
    findFirst: (p: { where: AnyRow; orderBy?: AnyRow; select?: AnyRow }) => Promise<AnyRow | null>;
  };
  interests: {
    findMany: (p: { where: AnyRow; select?: AnyRow }) => Promise<AnyRow[]>;
  };
  jobs: {
    findMany: (p: {
      where?: AnyRow;
      select?: AnyRow;
      take?: number;
      orderBy?: AnyRow;
    }) => Promise<AnyRow[]>;
  };
};

function makeAudit() {
  const records: unknown[] = [];
  return {
    records,
    record: async (r: unknown) => {
      records.push(r);
    },
  };
}

function makeFakePrisma(): FakePrisma {
  const db = {
    candidate_profiles: new Map<bigint, AnyRow>(),
    jobs: new Map<bigint, AnyRow>(),
    interests: new Map<bigint, AnyRow>(),
  };
  const prisma: FakePrisma = {
    db,
    candidate_profiles: {
      findFirst: async ({ where } = { where: {} }) => {
        const w = (where ?? {}) as { id?: bigint; deleted_at?: unknown };
        let rows = Array.from(db.candidate_profiles.values());
        if (w.deleted_at === null) rows = rows.filter((r) => r.deleted_at == null);
        if (w.id != null) return rows.find((r) => r.id === w.id) ?? null;
        return rows[0] ?? null;
      },
    },
    interests: {
      findMany: async ({ where } = { where: {} }) => {
        const w = (where ?? {}) as { candidate_id?: bigint; select?: AnyRow };
        let rows = Array.from(db.interests.values());
        if (w.candidate_id != null) rows = rows.filter((r) => r.candidate_id === w.candidate_id);
        return rows.map((r) => ({ job_id: r.job_id, ...r }));
      },
    },
    jobs: {
      findMany: async ({ where, take } = { take: 500 }) => {
        const w = (where ?? {}) as {
          status?: string;
          id?: { notIn?: bigint[] };
        };
        let rows = Array.from(db.jobs.values());
        if (w.status) rows = rows.filter((r) => r.status === w.status);
        if (w.id?.notIn?.length) {
          const exclude = new Set(w.id.notIn);
          rows = rows.filter((r) => !exclude.has(r.id as bigint));
        }
        rows.sort((a, b) => ((b.id as bigint) < (a.id as bigint) ? -1 : 1)); // orderBy id desc
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
          published_from_crawl: { status: 'PUBLISHED' },
        }));
      },
    },
  };
  return prisma;
}

describe('HardMatchService (C1 salary overlap / 6 dims)', () => {
  let prisma: FakePrisma;
  let clock: FakeClock;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    prisma = makeFakePrisma();
    clock = FakeClock.fromISO('2026-09-24T00:00:00Z');
    audit = makeAudit();
    const candId = 1n;
    prisma.db.candidate_profiles.set(candId, {
      id: candId,
      user_id: 100n,
      version: 1,
      status: 'CONFIRMED',
      deleted_at: null,
      locations: ['Phnom Penh'],
      skills: ['customer service', 'POS'],
      languages_known: ['English', 'Khmer'],
      industries: ['Retail'],
      salary_text: '1500-2000 USD',
      salary_status: 'PROVIDED',
    });
    prisma.db.jobs.set(10n, {
      id: 10n,
      title: 'Retail Cashier',
      industry: 'Retail',
      status: 'ACTIVE_EXTERNAL',
      skills: ['cashier', 'retail', 'POS'],
      locations: ['Phnom Penh', 'BKK1'],
      languages_required: ['English', 'Khmer'],
      shifts: ['FULL_TIME'],
      salary_status: 'PROVIDED',
      salary_text: '800-1200 USD',
    });
    prisma.db.jobs.set(11n, {
      id: 11n,
      title: 'Customer Service Officer',
      industry: 'Retail',
      status: 'ACTIVE_EXTERNAL',
      skills: ['customer service', 'POS', 'communication'],
      locations: ['Phnom Penh'],
      languages_required: ['English', 'Khmer'],
      shifts: ['FULL_TIME'],
      salary_status: 'PROVIDED',
      salary_text: '1500-2500 USD',
    });
    prisma.db.jobs.set(12n, {
      id: 12n,
      title: 'Manager Role',
      industry: 'Corporate',
      status: 'ACTIVE_EXTERNAL',
      skills: ['excel'],
      locations: ['Siem Reap'],
      languages_required: ['French'],
      shifts: ['FULL_TIME'],
      salary_status: 'PROVIDED',
      salary_text: '3000-4000 USD',
    });
    prisma.db.jobs.set(13n, {
      id: 13n,
      title: 'Negotiable Role',
      industry: 'Retail',
      status: 'ACTIVE_EXTERNAL',
      skills: ['customer service'],
      locations: ['Phnom Penh'],
      languages_required: ['English'],
      shifts: ['FULL_TIME'],
      salary_status: 'NEGOTIABLE',
      salary_text: 'negotiable',
    });
  });

  function svc() {
    return new HardMatchService(prisma as never, audit as never, clock);
  }

  it('C1 薪资不重叠 → salary=0，即使其他维度命中也不影响总分断言', async () => {
    const s = svc();
    // access private via TS escape hatch: scoreJobAgainstCandidate not exposed public; use suggest() and
    // verify the returned set excludes job 10 (salary 800-1200 vs 1500-2000 candidate)
    const res = await s.suggest({ candidateId: 1n, limit: 10 });
    const jobIds = new Set(res.jobs.map((j) => j.jobId));
    // job 10 salary 800-1200 vs candidate 1500-2000: NO overlap => scoreJobAgainstCandidate.salary = 0
    // locations/industry/languages match, but salary=0; overall score still >0 because loc/ind/lang match
    // so job 10 is still included BUT salary dimension MUST be 0
    const job10 = res.jobs.find((j) => j.jobId === 10n);
    expect(job10).toBeDefined();
    expect(job10!.dimensionHits.salary).toBe(0);
    // salary overlap job 11: 1500-2000 ∩ 1500-2500 = 1500-2000 → salary=1
    const job11 = res.jobs.find((j) => j.jobId === 11n);
    expect(job11).toBeDefined();
    expect(job11!.dimensionHits.salary).toBe(1);
  });

  it('C1 salary overlap PASS 边界条件：cand=1200-1500 job=1500-2000（区间端点相接算重叠=1）', async () => {
    const cand = prisma.db.candidate_profiles.get(1n)!;
    cand.salary_text = '1200-1500 USD';
    const job10 = prisma.db.jobs.get(10n)!;
    job10.salary_text = '1500-2000 USD';
    const s = svc();
    const r = await s.suggest({ candidateId: 1n, limit: 20 });
    const j = r.jobs.find((x) => x.jobId === 10n);
    expect(j).toBeDefined();
    expect(j!.dimensionHits.salary).toBe(1);
  });

  it('C1 job 12 零命中：地点/语言/行业/技能全不在候选 → totalScore = 0 被拒绝不出现在 suggest 结果', async () => {
    const s = svc();
    const r = await s.suggest({ candidateId: 1n, limit: 50 });
    expect(r.jobs.map((j) => j.jobId)).not.toContain(12n);
    // and job 12 has been filtered at if (totalScore<=0): verify by reading dimensionHits for 13 (negotiable) present
    const ids = new Set(r.jobs.map((j) => j.jobId));
    expect(ids.has(13n)).toBe(true);
  });

  it('C1 NEGOTIABLE 薪资一律视为 open → salary=1', async () => {
    const s = svc();
    const r = await s.suggest({ candidateId: 1n, limit: 20 });
    const job13 = r.jobs.find((j) => j.jobId === 13n);
    expect(job13!.dimensionHits.salary).toBe(1);
  });

  it('C1 候选 status != CONFIRMED → PROFILE_NOT_CONFIRMED', async () => {
    const cand = prisma.db.candidate_profiles.get(1n)!;
    cand.status = 'DRAFT';
    const s = svc();
    let err: unknown = null;
    try {
      await s.suggest({ candidateId: 1n });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect((err as { code?: string })?.code).toBe('PROFILE_NOT_CONFIRMED');
  });

  it('C1 候选人已有 interests → exclude 集合排除，不会重复建议同一 job', async () => {
    prisma.db.interests.set(999n, { id: 999n, candidate_id: 1n, job_id: 11n });
    const s = svc();
    const r = await s.suggest({ candidateId: 1n, limit: 50 });
    expect(r.jobs.map((j) => j.jobId)).not.toContain(11n);
  });

  it('C1 6 维命中 验证：loc×3 + skills×2 + langs + industry + salary = 建议排序 job11 > job10', async () => {
    const s = svc();
    const r = await s.suggest({ candidateId: 1n, limit: 10 });
    const job10 = r.jobs.find((j) => j.jobId === 10n)!;
    const job11 = r.jobs.find((j) => j.jobId === 11n)!;
    // loc: Phnom Penh (both 3)
    expect(job10.dimensionHits.locations).toBe(1); // Phnom Penh + BKK1 intersection size 1 vs ['Phnom Penh']
    expect(job11.dimensionHits.locations).toBe(1);
    // languages: job10=Khmer+English vs cand=English+Khmer => size 2, job11=English+Khmer => size 2
    expect(job10.dimensionHits.languages).toBe(2);
    expect(job11.dimensionHits.languages).toBe(2);
    // skills: cand 'customer service','POS' vs job10 'cashier','retail','POS' → POS
    expect(job10.dimensionHits.skills).toBe(1);
    // skills: cand vs job11 'customer service','POS','communication' → customer service + POS = 2
    expect(job11.dimensionHits.skills).toBe(2);
    // industry job10 Retail vs cand Retail → 1; job11 Retail → 1
    expect(job10.dimensionHits.industry).toBe(1);
    expect(job11.dimensionHits.industry).toBe(1);
    // salary job10 salary=0, job11 salary=1
    expect(job10.dimensionHits.salary).toBe(0);
    expect(job11.dimensionHits.salary).toBe(1);
    // ordering: job11 score ≥ job10 (salary 1 vs 0)
    expect(job11.matchScore).toBeGreaterThan(job10.matchScore);
  });
});
