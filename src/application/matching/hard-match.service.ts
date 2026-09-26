import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { isVisibleToMatches } from '@src/domain/crawler/crawl-job-status-machine';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import type { EligibilityStatus } from '@prisma/client';
import type { candidate_profiles, jobs } from '@prisma/client';

type SuggestedJob = {
  jobId: bigint;
  title: string;
  industry: string | null;
  locations: string[];
  matchScore: number;
  dimensionHits: {
    locations: number;
    skills: number;
    languages: number;
    industry: number;
    salary: number;
    remoteWorkMode: number;
    remoteScopeMatch: number;
    workAuthorization: number;
    employmentType: number;
    timezone: number;
    paymentMethod: number;
  };
  matchReasons: string[];
  needToConfirm: string[];
  eligibility: EligibilityStatus;
  matchReason: string | null;
  sourcePlatform: string | null;
  applicationUrl: string | null;
  remoteScope: string | null;
  eligibilityStatus: string | null;
  salaryText: string | null;
  sourceUrl: string | null;
  workMode: string;
};

type SuggestInput = {
  candidateId: bigint;
  limit?: number;
  excludeJobIds?: bigint[];
  remoteScope?: boolean;
};

type SalaryRange = {
  min: number | null;
  max: number | null;
  currency: string | null;
  open: boolean;
};

type ScoredJobRow = {
  id: bigint;
  title: string;
  industry: string | null;
  skills: string[];
  locations: string[];
  languages_required: string[];
  shifts: string[];
  salary_status: string;
  salary_text: string | null;
  work_mode: string;
  remote_scope: string | null;
  eligible_countries: string[];
  timezone_required: string | null;
  timezone_overlap_hours: number | null;
  work_authorization: string;
  employment_type: string | null;
  payment_method: string | null;
  salary_currency: string | null;
  application_url: string | null;
  source_platform: string | null;
  source_url: string | null;
  eligibility_status: EligibilityStatus;
  published_from_crawl: { status: string } | null;
};

@Injectable()
export class HardMatchService {
  private readonly logger = new Logger(HardMatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async suggest(input: SuggestInput): Promise<{ candidateId: bigint; jobs: SuggestedJob[] }> {
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 50);
    const candidate = await this.prisma.candidate_profiles.findFirst({
      where: { id: input.candidateId, deleted_at: null },
      orderBy: { version: 'desc' },
    });
    if (!candidate) {
      throw new AppError({
        code: AppErrorCode.PROFILE_NOT_FOUND,
        message: `candidate ${String(input.candidateId)} not found`,
      });
    }
    if (candidate.status !== 'CONFIRMED') {
      throw new AppError({
        code: AppErrorCode.PROFILE_NOT_CONFIRMED,
        message: `candidate ${String(input.candidateId)} must be CONFIRMED`,
      });
    }

    const candidateJobs = await this.prisma.interests
      .findMany({
        where: { candidate_id: candidate.id },
        select: { job_id: true },
      })
      .then((rows) => rows.map((r) => r.job_id));
    const exclude = new Set<bigint>([...candidateJobs, ...(input.excludeJobIds ?? [])]);

    const activeJobs = await this.prisma.jobs.findMany({
      where: {
        status: 'ACTIVE_EXTERNAL',
        id: exclude.size ? { notIn: [...exclude] } : undefined,
        ...(input.remoteScope
          ? {
              work_mode: 'REMOTE',
              eligibility_status: { in: ['CONFIRMED', 'NEEDS_CONFIRMATION'] },
            }
          : {}),
      },
      select: {
        id: true,
        title: true,
        industry: true,
        skills: true,
        locations: true,
        languages_required: true,
        shifts: true,
        salary_status: true,
        salary_text: true,
        work_mode: true,
        remote_scope: true,
        eligible_countries: true,
        timezone_required: true,
        timezone_overlap_hours: true,
        work_authorization: true,
        employment_type: true,
        payment_method: true,
        salary_currency: true,
        application_url: true,
        source_platform: true,
        source_url: true,
        eligibility_status: true,
        published_from_crawl: {
          select: { status: true },
        },
      },
      take: 500,
      orderBy: { id: 'desc' },
    });

    const scored: Array<SuggestedJob & { _row: jobs }> = [];
    for (const j of activeJobs as unknown as ScoredJobRow[]) {
      const crawlStatus = j.published_from_crawl?.status ?? 'PUBLISHED';
      if (!isVisibleToMatches(crawlStatus as Parameters<typeof isVisibleToMatches>[0])) continue;
      const result = this.scoreJobAgainstCandidate(candidate, j);
      if (result.totalScore < 0) continue;
      if (
        result.totalScore === 0 &&
        j.eligibility_status !== 'CONFIRMED' &&
        j.eligibility_status !== 'NEEDS_CONFIRMATION'
      )
        continue;
      const matchReasonStr = result.matchReasons.length
        ? result.matchReasons.slice(0, 3).join('；')
        : null;
      scored.push({
        jobId: j.id,
        title: j.title,
        industry: j.industry ?? null,
        locations: Array.isArray(j.locations) ? j.locations : [],
        matchScore: result.totalScore,
        dimensionHits: result.hits,
        matchReasons: result.matchReasons,
        needToConfirm: result.needToConfirm,
        eligibility: j.eligibility_status,
        matchReason: matchReasonStr,
        sourcePlatform: j.source_platform ?? null,
        applicationUrl: j.application_url ?? null,
        remoteScope: j.remote_scope ?? null,
        eligibilityStatus: j.eligibility_status ?? null,
        salaryText: j.salary_text ?? null,
        sourceUrl: j.source_url ?? null,
        workMode: String(j.work_mode),
        _row: j as unknown as jobs,
      });
    }

    scored.sort((a, b) => b.matchScore - a.matchScore);
    const top = scored.slice(0, limit).map(({ _row, ...rest }) => rest);

    await this.audit.record({
      action: AuditActionEnum.MATCH_INTERESTED_CANDIDATE,
      objectType: 'candidate_profiles',
      objectId: candidate.id,
      metadata: {
        suggested_count: String(top.length),
        pool_size: String(activeJobs.length),
        limit: String(limit),
      },
      now: this.clock.now(),
    });

    return { candidateId: candidate.id, jobs: top };
  }

  private scoreJobAgainstCandidate(
    candidate: candidate_profiles,
    job: ScoredJobRow,
  ): {
    totalScore: number;
    hits: SuggestedJob['dimensionHits'];
    matchReasons: string[];
    needToConfirm: string[];
  } {
    const hits: SuggestedJob['dimensionHits'] = {
      locations: 0,
      skills: 0,
      languages: 0,
      industry: 0,
      salary: 0,
      remoteWorkMode: 0,
      remoteScopeMatch: 0,
      workAuthorization: 0,
      employmentType: 0,
      timezone: 0,
      paymentMethod: 0,
    };
    const matchReasons: string[] = [];
    const needToConfirm: string[] = [];

    if (job.eligibility_status === 'NOT_ELIGIBLE') {
      return {
        totalScore: -1,
        hits,
        matchReasons: [],
        needToConfirm: ['资格检查未通过（NOT_ELIGIBLE）'],
      };
    }

    hits.locations = intersectSize(candidate.locations ?? [], job.locations ?? []);
    if (hits.locations > 0) {
      const matched = intersectList(candidate.locations ?? [], job.locations ?? []).slice(0, 2);
      if (matched.length) matchReasons.push(`地点匹配：${matched.join('、')}`);
    }

    hits.skills = intersectSize(candidate.skills ?? [], job.skills ?? []);
    if (hits.skills > 0) {
      const matched = intersectList(candidate.skills ?? [], job.skills ?? []).slice(0, 3);
      if (matched.length) matchReasons.push(`技能匹配：${matched.join('、')}`);
    }

    hits.languages = intersectSize(candidate.languages_known ?? [], job.languages_required ?? []);
    if (hits.languages > 0) {
      const matched = intersectList(
        candidate.languages_known ?? [],
        job.languages_required ?? [],
      ).slice(0, 2);
      if (matched.length) matchReasons.push(`语言匹配：${matched.join('、')}`);
    }

    if (candidate.industries && candidate.industries.length > 0 && job.industry) {
      const industrySet = new Set(candidate.industries.map((s) => s.toLowerCase()));
      if (industrySet.has(String(job.industry).toLowerCase())) {
        hits.industry = 1;
        matchReasons.push(`行业匹配：${job.industry}`);
      }
    }

    const candSalary = this.parseSalaryRange(candidate.salary_text ?? null);
    const jobSalary = this.parseSalaryRange(job.salary_text ?? null);
    if (candSalary.open || jobSalary.open || this.rangesOverlap(candSalary, jobSalary)) {
      hits.salary = 1;
      if (job.salary_text) matchReasons.push('薪资范围匹配');
    }

    const remoteHits = this.scoreRemoteDimensions(candidate, job);
    hits.remoteWorkMode = remoteHits.remoteWorkMode;
    hits.remoteScopeMatch = remoteHits.remoteScopeMatch;
    hits.workAuthorization = remoteHits.workAuthorization;
    hits.employmentType = remoteHits.employmentType;
    hits.timezone = remoteHits.timezone;
    hits.paymentMethod = remoteHits.paymentMethod;
    matchReasons.push(...remoteHits.matchReasons);
    needToConfirm.push(...remoteHits.needToConfirm);

    if (job.eligibility_status === 'NEEDS_CONFIRMATION') {
      if (needToConfirm.length === 0) {
        needToConfirm.push('申请前请确认岗位资格细节');
      }
    }

    const totalScore =
      hits.locations * 3 +
      hits.skills * 2 +
      hits.languages +
      hits.industry +
      hits.salary +
      hits.remoteWorkMode * 2 +
      hits.remoteScopeMatch +
      hits.workAuthorization +
      hits.employmentType +
      hits.timezone +
      hits.paymentMethod;

    return { totalScore, hits, matchReasons, needToConfirm };
  }

  private scoreRemoteDimensions(
    candidate: candidate_profiles,
    job: ScoredJobRow,
  ): {
    remoteWorkMode: number;
    remoteScopeMatch: number;
    workAuthorization: number;
    employmentType: number;
    timezone: number;
    paymentMethod: number;
    matchReasons: string[];
    needToConfirm: string[];
  } {
    const result = {
      remoteWorkMode: 0,
      remoteScopeMatch: 0,
      workAuthorization: 0,
      employmentType: 0,
      timezone: 0,
      paymentMethod: 0,
      matchReasons: [] as string[],
      needToConfirm: [] as string[],
    };

    if (candidate.remote_preferred && job.work_mode === 'REMOTE') {
      result.remoteWorkMode = 1;
      result.matchReasons.push('远程办公模式匹配');
    } else if (!candidate.remote_preferred && job.work_mode === 'ONSITE') {
      result.remoteWorkMode = 1;
    } else if (job.work_mode === 'HYBRID') {
      result.remoteWorkMode = 1;
      result.matchReasons.push('混合办公模式');
    }

    if (candidate.remote_scope_preference && job.remote_scope) {
      const scopeRank: Record<string, number> = {
        WORLDWIDE: 4,
        ASIA: 3,
        ASEAN: 2,
        CAMBODIA_ONLY: 1,
        COUNTRY_LIMITED: 0,
      };
      const candRank = scopeRank[candidate.remote_scope_preference] ?? 0;
      const jobRank = scopeRank[job.remote_scope] ?? 0;
      if (jobRank >= candRank) {
        result.remoteScopeMatch = 1;
        result.matchReasons.push(`远程范围兼容：${job.remote_scope}`);
      } else if (job.remote_scope === 'COUNTRY_LIMITED') {
        result.needToConfirm.push('请确认远程范围限制是否包含您的地区');
      }
    } else if (
      !candidate.remote_scope_preference &&
      job.remote_scope &&
      job.remote_scope !== 'COUNTRY_LIMITED'
    ) {
      result.remoteScopeMatch = 1;
    }

    if (job.work_authorization === 'NOT_REQUIRED') {
      result.workAuthorization = 1;
      result.matchReasons.push('无需当地工作许可');
    } else if (job.work_authorization === 'REQUIRED') {
      result.needToConfirm.push('需确认当地工作许可 / 签证要求');
    } else if (job.work_authorization === 'UNKNOWN') {
      result.needToConfirm.push('请确认是否需要工作许可');
    }

    if (candidate.preferred_employment_types?.length && job.employment_type) {
      const candTypes = new Set(
        candidate.preferred_employment_types.map((t) => String(t).toUpperCase()),
      );
      if (candTypes.has(String(job.employment_type).toUpperCase())) {
        result.employmentType = 1;
        result.matchReasons.push(`雇佣类型匹配：${job.employment_type}`);
      }
    } else if (!candidate.preferred_employment_types?.length && job.employment_type) {
      result.employmentType = 1;
    }

    if (job.timezone_overlap_hours != null) {
      const minHours = candidate.timezone_overlap_hours ?? 2;
      if (job.timezone_overlap_hours >= minHours) {
        result.timezone = 1;
        result.matchReasons.push(`时区重叠 ${job.timezone_overlap_hours}h`);
      } else {
        result.needToConfirm.push(`时区重叠仅 ${job.timezone_overlap_hours}h，需确认是否可接受`);
      }
    } else if (job.timezone_required) {
      const tz = String(job.timezone_required).toLowerCase();
      if (/(utc\+7|gmt\+7|cambodia|phnom|bangkok|ho chi minh|vientiane|jakarta)/.test(tz)) {
        result.timezone = 1;
        result.matchReasons.push(`时区兼容：${job.timezone_required}`);
      } else if (/(flexible|any|anywhere|no preference)/.test(tz)) {
        result.timezone = 1;
        result.matchReasons.push('时区要求灵活');
      } else {
        result.needToConfirm.push(`请确认时区 ${job.timezone_required} 是否可满足`);
      }
    } else {
      result.needToConfirm.push('请确认时区重叠要求');
    }

    if (candidate.payment_methods?.length && job.payment_method) {
      const norm = (s: string) => String(s).trim().toLowerCase();
      const candSet = new Set(candidate.payment_methods.map(norm));
      if (candSet.has(norm(job.payment_method))) {
        result.paymentMethod = 1;
        result.matchReasons.push(`付款方式匹配：${job.payment_method}`);
      } else if (
        /(wise|transferwise|paypal|payoneer|swift|revolut|crypto|international)/i.test(
          job.payment_method,
        )
      ) {
        result.paymentMethod = 1;
        result.matchReasons.push(`跨境付款方式可用：${job.payment_method}`);
      }
    } else if (job.payment_method) {
      if (
        /(wise|transferwise|paypal|payoneer|swift|revolut|crypto|international)/i.test(
          job.payment_method,
        )
      ) {
        result.paymentMethod = 1;
        result.matchReasons.push(`跨境付款方式可用：${job.payment_method}`);
      } else {
        result.needToConfirm.push('请确认跨境付款方式');
      }
    } else {
      result.needToConfirm.push('请确认跨境付款方式');
    }

    return result;
  }

  private parseSalaryRange(raw: string | null): SalaryRange {
    const r: SalaryRange = { min: null, max: null, currency: null, open: false };
    if (!raw) {
      r.open = true;
      return r;
    }
    const text = raw.trim();
    if (!text || /面议|negotiable|ចរចា|tbd|to be discussed|open/i.test(text)) {
      r.open = true;
      return r;
    }
    const curMatch = text.match(/(USD|KHR|CNY|¥|\$|€)/i);
    if (curMatch && curMatch[1]) r.currency = curMatch[1].toUpperCase();
    const numbers = text.match(/\d[\d,，]*/g)?.map((s) => Number(s.replace(/[,，]/g, ''))) ?? [];
    const numeric = numbers.filter((n): n is number => Number.isFinite(n) && n > 0);
    if (numeric.length >= 2) {
      r.min = Math.min(numeric[0] ?? 0, numeric[1] ?? 0);
      r.max = Math.max(numeric[0] ?? 0, numeric[1] ?? 0);
    } else if (numeric.length === 1 && numeric[0] != null) {
      r.min = numeric[0];
      r.max = numeric[0];
    } else {
      r.open = true;
    }
    return r;
  }

  private rangesOverlap(a: SalaryRange, b: SalaryRange): boolean {
    if (a.open || b.open) return true;
    if (a.min == null || a.max == null || b.min == null || b.max == null) return true;
    return a.max >= b.min && b.max >= a.min;
  }
}

function intersectSize(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const norm = (s: string) => String(s).trim().toLowerCase();
  const bSet = new Set((b ?? []).map(norm));
  return (a ?? []).filter((s) => bSet.has(norm(s))).length;
}

function intersectList(a: string[], b: string[]): string[] {
  if (!a.length || !b.length) return [];
  const norm = (s: string) => String(s).trim().toLowerCase();
  const bNorm = b.map(norm);
  const bSet = new Set(bNorm);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of a) {
    const k = norm(s);
    if (bSet.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}
