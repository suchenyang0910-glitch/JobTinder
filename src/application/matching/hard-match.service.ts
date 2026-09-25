import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { isVisibleToMatches } from '@src/domain/crawler/crawl-job-status-machine';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import type { matches, candidate_profiles, jobs } from '@prisma/client';

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
  };
};

type SuggestInput = {
  candidateId: bigint;
  limit?: number;
  excludeJobIds?: bigint[];
};

type SalaryRange = {
  min: number | null;
  max: number | null;
  currency: string | null;
  open: boolean;
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
        published_from_crawl: {
          select: { status: true },
        },
      },
      take: 500,
      orderBy: { id: 'desc' },
    });

    const scored: Array<SuggestedJob & { _row: jobs }> = [];
    for (const j of activeJobs) {
      const crawlStatus = (j.published_from_crawl?.status ?? 'PUBLISHED') as string;
      if (!isVisibleToMatches(crawlStatus as Parameters<typeof isVisibleToMatches>[0])) continue;
      const result = this.scoreJobAgainstCandidate(candidate, j);
      if (result.totalScore <= 0) continue;
      scored.push({
        jobId: j.id,
        title: j.title,
        industry: j.industry ?? null,
        locations: Array.isArray(j.locations) ? j.locations : [],
        matchScore: result.totalScore,
        dimensionHits: result.hits,
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
    job: {
      skills: string[];
      industry: string | null;
      locations: string[];
      languages_required: string[];
      salary_status: string;
      salary_text: string | null;
    },
  ): { totalScore: number; hits: SuggestedJob['dimensionHits'] } {
    const hits: SuggestedJob['dimensionHits'] = {
      locations: 0,
      skills: 0,
      languages: 0,
      industry: 0,
      salary: 0,
    };

    hits.locations = intersectSize(candidate.locations ?? [], job.locations ?? []);
    hits.skills = intersectSize(candidate.skills ?? [], job.skills ?? []);
    hits.languages = intersectSize(candidate.languages_known ?? [], job.languages_required ?? []);
    if (candidate.industries && candidate.industries.length > 0 && job.industry) {
      const industrySet = new Set(candidate.industries.map((s) => s.toLowerCase()));
      if (industrySet.has(String(job.industry).toLowerCase())) {
        hits.industry = 1;
      }
    }

    const candSalary = this.parseSalaryRange(candidate.salary_text ?? null);
    const jobSalary = this.parseSalaryRange(job.salary_text ?? null);
    if (candSalary.open || jobSalary.open || this.rangesOverlap(candSalary, jobSalary)) {
      hits.salary = 1;
    }

    const totalScore =
      hits.locations * 3 + hits.skills * 2 + hits.languages + hits.industry + hits.salary;
    return { totalScore, hits };
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
