import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';
import { HardMatchService } from '@src/application/matching/hard-match.service';
import { APP_ENV } from '@src/shared/env/app-env';
import { CrawlerReviewNotifierService } from '@src/application/crawler/crawler-review-notifier.service';
import { createHash } from 'node:crypto';

type DigestJob = {
  jobId: bigint;
  title: string;
  industry: string | null;
  matchScore: number;
  matchReason: string | null;
  needToConfirm: string[];
  sourcePlatform: string | null;
  applicationUrl: string | null;
  remoteScope: string | null;
  eligibilityStatus: string | null;
  salaryText: string | null;
  sourceUrl: string | null;
  workMode: string;
};

const DIGEST_COPY = {
  zh_CN: {
    headline: (n: number) => `💼 每日岗位推荐（${n} 条）`,
    industry: '行业',
    score: '匹配分数',
    eligibility: '资格',
    salary: '薪资',
    scope: '远程范围',
    platform: '来源',
    apply: '申请',
    confirm: '⚠️ 部分岗位资格信息仍需确认。',
    salaryMissing: '面议',
    modes: { REMOTE: '🌐 远程', ONSITE: '🏢 现场', HYBRID: '🔀 混合办公' },
    scopes: {
      WORLDWIDE: '全球',
      ASIA: '亚洲',
      ASEAN: '东盟',
      CAMBODIA_ONLY: '仅柬埔寨',
      COUNTRY_LIMITED: '限指定国家',
    },
    eligibilityValues: {
      CONFIRMED: '已确认',
      NEEDS_CONFIRMATION: '需要确认',
      NOT_ELIGIBLE: '不符合',
    },
  },
  en: {
    headline: (n: number) => `💼 Daily job recommendations (${n})`,
    industry: 'Industry',
    score: 'Match score',
    eligibility: 'Eligibility',
    salary: 'Salary',
    scope: 'Remote scope',
    platform: 'Source',
    apply: 'Apply',
    confirm: '⚠️ Some eligibility details still need confirmation.',
    salaryMissing: 'Not disclosed',
    modes: { REMOTE: '🌐 Remote', ONSITE: '🏢 On-site', HYBRID: '🔀 Hybrid' },
    scopes: {
      WORLDWIDE: 'Worldwide',
      ASIA: 'Asia',
      ASEAN: 'ASEAN',
      CAMBODIA_ONLY: 'Cambodia only',
      COUNTRY_LIMITED: 'Country-limited',
    },
    eligibilityValues: {
      CONFIRMED: 'Confirmed',
      NEEDS_CONFIRMATION: 'Needs confirmation',
      NOT_ELIGIBLE: 'Not eligible',
    },
  },
  km: {
    headline: (n: number) => `💼 ការងារណែនាំប្រចាំថ្ងៃ (${n})`,
    industry: 'វិស័យ',
    score: 'ពិន្ទុផ្គូផ្គង',
    eligibility: 'លក្ខខណ្ឌ',
    salary: 'ប្រាក់ខែ',
    scope: 'វិសាលភាពពីចម្ងាយ',
    platform: 'ប្រភព',
    apply: 'ដាក់ពាក្យ',
    confirm: '⚠️ ព័ត៌មានលក្ខខណ្ឌខ្លះនៅត្រូវការការបញ្ជាក់។',
    salaryMissing: 'មិនបានបញ្ជាក់',
    modes: { REMOTE: '🌐 ពីចម្ងាយ', ONSITE: '🏢 នៅទីតាំង', HYBRID: '🔀 កូនកាត់' },
    scopes: {
      WORLDWIDE: 'ទូទាំងពិភពលោក',
      ASIA: 'អាស៊ី',
      ASEAN: 'អាស៊ាន',
      CAMBODIA_ONLY: 'តែកម្ពុជា',
      COUNTRY_LIMITED: 'កំណត់តាមប្រទេស',
    },
    eligibilityValues: {
      CONFIRMED: 'បានបញ្ជាក់',
      NEEDS_CONFIRMATION: 'ត្រូវការបញ្ជាក់',
      NOT_ELIGIBLE: 'មិនមានសិទ្ធិ',
    },
  },
} as const;

type CandidateDigest = {
  candidateId: bigint;
  userId: bigint;
  telegramUserId: bigint | null;
  jobs: DigestJob[];
};

@Injectable()
export class RemoteDailyDigestService {
  private readonly logger = new Logger(RemoteDailyDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditRepository,
    private readonly hardMatch: HardMatchService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() private readonly notifier?: CrawlerReviewNotifierService,
  ) {}

  async runDailyDigest(opts?: { dryRun?: boolean; candidateLimit?: number }): Promise<{
    processedCandidates: number;
    sentCandidates: number;
    skippedEmpty: number;
    totalJobsSent: number;
  }> {
    const now = this.clock.now();
    const today = this.todayKey(now);
    const candidateLimit = opts?.candidateLimit ?? 1000;

    const candidates = await this.prisma.candidate_profiles.findMany({
      where: {
        status: 'CONFIRMED',
        deleted_at: null,
        job_search_status: { in: ['LOOKING_JOB', 'INTERVIEWING'] },
      },
      select: {
        id: true,
        user_id: true,
        user: { select: { telegram_user_id: true, language: true } },
        job_search_status: true,
      },
      take: candidateLimit,
      orderBy: { id: 'asc' },
    });

    let sentCandidates = 0;
    let skippedEmpty = 0;
    let totalJobsSent = 0;

    for (const cand of candidates) {
      const dedupeKey = `remote:digest:${today}:${cand.id.toString()}`;
      const alreadySent = await this.prisma.audit_events.findFirst({
        where: {
          action: 'REMOTE_DAILY_DIGEST_SENT',
          metadata: { path: ['dedupe_key'], equals: dedupeKey },
        },
        select: { id: true },
      });
      if (alreadySent) continue;

      const [localSuggestions, remoteSuggestions] = await Promise.all([
        this.hardMatch.suggest({
          candidateId: cand.id,
          limit: 5,
          workModes: ['ONSITE', 'HYBRID'],
        }),
        this.hardMatch.suggest({ candidateId: cand.id, limit: 5, remoteScope: true }),
      ]);

      if (!localSuggestions.jobs.length && !remoteSuggestions.jobs.length) {
        skippedEmpty++;
        continue;
      }

      const jobsSent = this.interleaveJobs(localSuggestions.jobs, remoteSuggestions.jobs);
      totalJobsSent += jobsSent.length;

      if (!opts?.dryRun) {
        const ok = await this.sendCandidateDigest(
          cand.user.telegram_user_id ?? null,
          cand.id,
          cand.user.language,
          jobsSent,
        );
        if (!ok) {
          // Do not consume the daily idempotency slot when Telegram delivery
          // failed; the next run must be able to retry the digest.
          continue;
        }
        sentCandidates++;
        try {
          await this.audit.record({
            action: AuditActionEnum.REMOTE_DAILY_DIGEST_SENT,
            objectType: 'candidate_profiles',
            objectId: cand.id,
            metadata: {
              dedupe_key: dedupeKey,
              jobs_sent: String(jobsSent.length),
              job_ids: jobsSent.map((j) => String(j.jobId)).join(','),
              candidate_user_id: String(cand.user_id),
              scope: 'local_and_remote',
              top5: 'true',
            },
            now,
          });
        } catch {
          /* audit never breaks digest */
        }
      } else {
        sentCandidates++;
      }
    }

    return {
      processedCandidates: candidates.length,
      sentCandidates,
      skippedEmpty,
      totalJobsSent,
    };
  }

  private async sendCandidateDigest(
    telegramUserId: bigint | null,
    _candidateId: bigint,
    language: 'zh_CN' | 'en' | 'km',
    jobs: DigestJob[],
  ): Promise<boolean> {
    if (!telegramUserId) return false;
    const token = APP_ENV.TELEGRAM_BOT_TOKEN;
    if (!token) return false;

    const copy = DIGEST_COPY[language] ?? DIGEST_COPY.en;
    const translated = await this.prisma.jobs.findMany({
      where: { id: { in: jobs.map((job) => job.jobId) } },
      select: {
        id: true,
        published_from_crawl: {
          select: {
            job_translations: {
              where: { language },
              orderBy: { updated_at: 'desc' },
              take: 1,
              select: { title: true, industry: true, salary_text: true },
            },
          },
        },
      },
    });
    const translations = new Map(
      translated.map((job) => [job.id.toString(), job.published_from_crawl?.job_translations[0]]),
    );
    const headline = `${copy.headline(jobs.length)}\n\n`;
    const jobBlocks = jobs.map((j) => {
      const translation = translations.get(j.jobId.toString());
      const eligibility = j.eligibilityStatus ?? 'NEEDS_CONFIRMATION';
      const lines = [
        `${copy.modes[j.workMode as keyof typeof copy.modes] ?? '💼'} ${translation?.title ?? j.title}`,
        (translation?.industry ?? j.industry)
          ? `${copy.industry}: ${translation?.industry ?? j.industry}`
          : '',
        `${copy.score}: ${j.matchScore}`,
        j.workMode === 'REMOTE' && j.remoteScope
          ? `${copy.scope}: ${copy.scopes[j.remoteScope as keyof typeof copy.scopes] ?? j.remoteScope}`
          : '',
        `${copy.eligibility}: ${copy.eligibilityValues[eligibility as keyof typeof copy.eligibilityValues] ?? copy.eligibilityValues.NEEDS_CONFIRMATION}`,
        `${copy.salary}: ${translation?.salary_text ?? j.salaryText ?? copy.salaryMissing}`,
        j.sourcePlatform ? `${copy.platform}: ${j.sourcePlatform}` : '',
        j.needToConfirm.length ? copy.confirm : '',
        j.applicationUrl
          ? `🔗 ${copy.apply}: ${j.applicationUrl}`
          : j.sourceUrl
            ? `🔗 ${j.sourceUrl}`
            : '',
      ].filter(Boolean);
      return lines.join('\n');
    });
    const text = `${headline}${jobBlocks.join('\n\n')}`.slice(0, 3800);

    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: String(telegramUserId),
          text,
          disable_web_page_preview: true,
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private todayKey(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private interleaveJobs(local: DigestJob[], remote: DigestJob[]): DigestJob[] {
    const jobs: DigestJob[] = [];
    for (let i = 0; jobs.length < 5 && (i < local.length || i < remote.length); i++) {
      const localJob = local[i];
      const remoteJob = remote[i];
      if (localJob) jobs.push(localJob);
      if (remoteJob && jobs.length < 5) jobs.push(remoteJob);
    }
    return jobs;
  }
}

function sha1Hex(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export type { CandidateDigest, DigestJob };
