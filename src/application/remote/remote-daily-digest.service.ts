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
};

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
        user: { select: { telegram_user_id: true } },
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

      const suggestions = await this.hardMatch.suggest({
        candidateId: cand.id,
        limit: 5,
        remoteScope: true,
      });

      if (!suggestions.jobs.length) {
        skippedEmpty++;
        continue;
      }

      const jobsSent = suggestions.jobs.slice(0, 5);
      totalJobsSent += jobsSent.length;

      if (!opts?.dryRun) {
        const ok = await this.sendCandidateDigest(
          cand.user.telegram_user_id ?? null,
          cand.id,
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
              scope: 'remote',
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
    jobs: DigestJob[],
  ): Promise<boolean> {
    if (!telegramUserId) return false;
    const token = APP_ENV.TELEGRAM_BOT_TOKEN;
    if (!token) return false;

    const headline = `🌐 远程岗位每日推荐（${jobs.length} 条）\n\n`;
    const jobBlocks = jobs.map((j) => {
      const lines = [
        `🌐 ${j.title}`,
        j.industry ? `行业：${j.industry}` : '',
        `匹配度：${j.matchScore}`,
        j.remoteScope ? `远程范围：${j.remoteScope}` : '',
        `资格：${j.eligibilityStatus ?? 'NEEDS_CONFIRMATION'}`,
        `薪资：${j.salaryText || '面议'}`,
        j.sourcePlatform ? `平台：${j.sourcePlatform}` : '',
        j.matchReason ? `📌 匹配：${j.matchReason}` : '',
        j.needToConfirm.length ? `⚠️ 确认：${j.needToConfirm.slice(0, 2).join('；')}` : '',
        j.applicationUrl ? `🔗 ${j.applicationUrl}` : j.sourceUrl ? `🔗 ${j.sourceUrl}` : '',
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
}

function sha1Hex(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export type { CandidateDigest, DigestJob };
