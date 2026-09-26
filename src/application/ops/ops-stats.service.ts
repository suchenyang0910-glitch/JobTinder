import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { Clock, CLOCK_TOKEN } from '@src/shared/clock/clock';

export type OpsStats = {
  generatedAt: Date;

  usersRegistered: number;
  candidatesConfirmed: number;
  companiesTotal: number;
  companiesVerified: number;
  jobsActive: number;
  jobsPendingReview: number;

  interestsTotal: number;
  matchesTotal: number;
  matchesContactOpened: number;

  companyOverallResponseRatePct: number | null;
  responseRate24hPct: number | null;
  noResponse72hPct: number | null;

  interviewsScheduled: number;
  candidatesFoundJob: number;
  jobsFilled: number;

  sourceApprovalRatePct: number | null;
  translationFailureRatePct: number | null;
  jobExpiryRatePct: number | null;
  jobStaleFailureRatePct: number | null;

  reversal30d: {
    effectiveJobRatePct: number | null;
    companyResponse24hPct: number | null;
    contactOpenRatePct: number | null;
    interviewRatePct: number | null;
    windowDays: number;
  };
};

@Injectable()
export class OpsStatsService {
  private readonly logger = new Logger(OpsStatsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async getOpsStats(): Promise<OpsStats> {
    const now = this.clock.now();
    const window24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const window72 = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const window30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      usersRegistered,
      candidatesConfirmed,
      companiesTotal,
      companiesVerified,
      jobsActive,
      jobsPendingReview,
      interestsTotal,
      interestsTotalResponded,
      matchesTotal,
      matchesContactOpened,
      interests24Created,
      interests24Responded,
      interests72Created,
      interests72NoResp,
      interviewsScheduled,
      candidatesFoundJob,
      jobsFilled,
      sourcesTotal,
      sourcesApproved,
      stagingTotal,
      stagingFailedTranslation,
      stagingExpired,
      jobsEverLifecycle,
      jobsStaleClosed,
      rev30JobsLifecycle,
      rev30JobsStaleClosed,
      rev30InterestsResponded24h,
      rev30InterestsTotal,
      rev30Interests,
      rev30MatchesContactOpened,
      rev30Interviews,
    ] = await Promise.all([
      this.prisma.users.count(),
      this.prisma.candidate_profiles.count({
        where: { status: 'CONFIRMED', deleted_at: null },
      }),
      this.prisma.companies.count(),
      this.prisma.companies.count({ where: { verification_status: 'VERIFIED' } }),
      this.prisma.jobs.count({
        where: {
          OR: [{ status: 'ACTIVE_EXTERNAL' }, { status: 'ACTIVE_CLAIMED' }],
        },
      }),
      this.prisma.crawl_jobs_staging.count({
        where: {
          OR: [{ status: 'QA_PENDING' }, { status: 'REVIEW_REQUIRED' }, { status: 'DEFERRED' }],
        },
      }),
      this.prisma.interests.count(),
      this.prisma.interests.count({ where: { processed_at: { not: null } } }),
      this.prisma.matches.count(),
      this.prisma.matches.count({
        where: { status: 'CONTACT_AVAILABLE' },
      }),
      this.prisma.interests.count({ where: { notified_at: { gte: window24 } } }),
      this.prisma.interests.count({
        where: {
          notified_at: { gte: window24 },
          processed_at: { not: null },
        },
      }),
      this.prisma.interests.count({ where: { notified_at: { gte: window72 } } }),
      this.prisma.interests.count({
        where: {
          notified_at: { gte: window72 },
          status: { in: ['EXPIRED', 'WITHDRAWN'] },
          reminded_at: { not: null },
        },
      }),
      this.prisma.$queryRaw<{ cnt: bigint | number }[]>`
        SELECT COUNT(DISTINCT COALESCE(related_job_id, (metadata->>'related_job_id')::bigint, id))::int AS cnt
        FROM audit_events
        WHERE action IN ('CANDIDATE_STATUS_CHANGED', 'COMPANY_JOB_STATUS_CHANGED')
          AND (
            (new_status = 'INTERVIEWING')
            OR (metadata->>'new_status' = 'INTERVIEWING')
          )
      `
        .then((rows) => Number(rows[0]?.cnt ?? 0))
        .catch(() => {
          return Promise.all([
            this.prisma.candidate_profiles.count({ where: { job_search_status: 'INTERVIEWING' } }),
            this.prisma.jobs.count({ where: { hiring_status: 'INTERVIEWING' } }),
          ]).then(([c, j]) => c + j);
        }),
      this.prisma.candidate_profiles.count({
        where: { job_search_status: 'FOUND_JOB', deleted_at: null },
      }),
      this.prisma.jobs.count({
        where: {
          OR: [{ hiring_status: 'FILLED' }, { hiring_status: 'CLOSED' }],
        },
      }),
      this.prisma.source_registry.count(),
      this.prisma.source_registry.count({ where: { review_status: 'APPROVED' } }),
      this.prisma.crawl_jobs_staging.count(),
      this.prisma.crawl_jobs_staging.count({
        where: { translation_status: 'FAILED' },
      }),
      this.prisma.crawl_jobs_staging.count({ where: { status: 'EXPIRED' } }),
      this.prisma.jobs.count({
        where: {
          OR: [
            { status: 'ACTIVE_EXTERNAL' },
            { status: 'ACTIVE_CLAIMED' },
            { status: 'CLOSED' },
            { status: 'PAUSED' },
          ],
        },
      }),
      this.prisma.jobs.count({
        where: {
          status: 'CLOSED',
          closed_reason: { in: ['STALE_SOURCE', 'STALE', 'NOT_FOUND', 'DEADLINE'] },
        },
      }),
      this.prisma.jobs.count({
        where: {
          OR: [
            { status: 'ACTIVE_EXTERNAL' },
            { status: 'ACTIVE_CLAIMED' },
            { status: 'CLOSED' },
            { status: 'PAUSED' },
          ],
          created_at: { gte: window30d },
        },
      }),
      this.prisma.jobs.count({
        where: {
          status: 'CLOSED',
          closed_reason: { in: ['STALE_SOURCE', 'STALE', 'NOT_FOUND', 'DEADLINE'] },
          closed_at: { gte: window30d },
        },
      }),
      this.prisma.interests.count({
        where: {
          notified_at: { gte: window30d },
          processed_at: { not: null, lte: new Date(window24.getTime() + 24 * 3600 * 1000) },
        },
      }),
      this.prisma.interests.count({ where: { notified_at: { gte: window30d } } }),
      this.prisma.interests.count({ where: { created_at: { gte: window30d } } }),
      this.prisma.matches.count({
        where: { status: 'CONTACT_AVAILABLE', created_at: { gte: window30d } },
      }),
      this.prisma.$queryRaw<{ cnt: bigint | number }[]>`
        SELECT COUNT(DISTINCT COALESCE(related_job_id, (metadata->>'related_job_id')::bigint, id))::int AS cnt
        FROM audit_events
        WHERE action IN ('CANDIDATE_STATUS_CHANGED', 'COMPANY_JOB_STATUS_CHANGED')
          AND created_at >= ${window30d}
          AND (
            (new_status = 'INTERVIEWING')
            OR (metadata->>'new_status' = 'INTERVIEWING')
          )
      `
        .then((rows) => Number(rows[0]?.cnt ?? 0))
        .catch(() =>
          Promise.all([
            this.prisma.candidate_profiles.count({
              where: {
                job_search_status: 'INTERVIEWING',
                job_search_status_updated_at: { gte: window30d },
              },
            }),
            this.prisma.jobs.count({
              where: {
                hiring_status: 'INTERVIEWING',
                hiring_status_updated_at: { gte: window30d },
              },
            }),
          ]).then(([c, j]) => c + j),
        ),
    ]);

    const companyOverallResponseRatePct = pct(interestsTotalResponded, interestsTotal);
    const responseRate24hPct = pct(interests24Responded, interests24Created);
    const noResponse72hPct = pct(interests72NoResp, interests72Created);
    const sourceApprovalRatePct = pct(sourcesApproved, sourcesTotal);
    const translationFailureRatePct = pct(stagingFailedTranslation, stagingTotal);
    const jobExpiryRatePct = pct(stagingExpired, stagingTotal);
    const jobStaleFailureRatePct = pct(jobsStaleClosed, jobsEverLifecycle);

    const reversal30d: OpsStats['reversal30d'] = {
      windowDays: 30,
      effectiveJobRatePct:
        rev30JobsLifecycle > 0
          ? Math.max(0, 100 - (rev30JobsStaleClosed / rev30JobsLifecycle) * 100)
          : null,
      companyResponse24hPct: pct(rev30InterestsResponded24h, rev30InterestsTotal),
      contactOpenRatePct: pct(rev30MatchesContactOpened, rev30Interests),
      interviewRatePct: pct(rev30Interviews, rev30Interests),
    };

    return {
      generatedAt: now,
      usersRegistered,
      candidatesConfirmed,
      companiesTotal,
      companiesVerified,
      jobsActive,
      jobsPendingReview,
      interestsTotal,
      matchesTotal,
      matchesContactOpened,
      companyOverallResponseRatePct,
      responseRate24hPct,
      noResponse72hPct,
      interviewsScheduled,
      candidatesFoundJob,
      jobsFilled,
      sourceApprovalRatePct,
      translationFailureRatePct,
      jobExpiryRatePct,
      jobStaleFailureRatePct,
      reversal30d,
    };
  }

  formatAscii(s: OpsStats): string {
    const pctFmt = (v: number | null) => (v == null ? 'N/A' : `${v.toFixed(1)}%`);
    const pilotPass = (cond: boolean) => (cond ? '✓' : '·');
    const warn = (isOk: boolean) => (isOk ? '✅ PASS' : '⚠️ WARN');
    const r = s.reversal30d;
    const effectiveJobOk = (r.effectiveJobRatePct ?? 100) >= 70;
    const resp24Ok = (r.companyResponse24hPct ?? 100) >= 30;
    const contactOk = (r.contactOpenRatePct ?? 100) >= 20;
    const interviewOk = (r.interviewRatePct ?? 100) >= 5;
    const lines = [
      `JobTinder 运营统计 — ${this.formatDate(s.generatedAt)}  (window=${r.windowDays}d)`,
      `═══════════════════════════════════════════════════`,
      `🛡️  反转条件预警（30 天窗口）`,
      `   有效岗位率 ≥70%             ${warn(effectiveJobOk)}   ${pctFmt(r.effectiveJobRatePct)}   threshold=70%`,
      `   企业 24h 响应率 ≥30%        ${warn(resp24Ok)}   ${pctFmt(r.companyResponse24hPct)}   threshold=30%`,
      `   匹配联系开启率 ≥20%         ${warn(contactOk)}   ${pctFmt(r.contactOpenRatePct)}   threshold=20%`,
      `   面试转化率 ≥5%              ${warn(interviewOk)}   ${pctFmt(r.interviewRatePct)}   threshold=5%`,
      ``,
      `🎯 14 天试点验收（目标 vs 现状）`,
      `   真实求职者（≥30）  ${pilotPass(s.candidatesConfirmed >= 30)}  已确认档案：${s.candidatesConfirmed} / 30`,
      `   真实岗位（10–20）   ${pilotPass(s.jobsActive >= 10 && s.jobsActive <= 20)}  有效职位：${s.jobsActive}`,
      `   企业有效回应（≥10） ${pilotPass(s.interestsTotal >= 10)}  兴趣总数：${s.interestsTotal}`,
      `   联系开启（≥5）      ${pilotPass(s.matchesContactOpened >= 5)}  联系开放数：${s.matchesContactOpened}`,
      `   真实面试（≥2）      ${pilotPass(s.interviewsScheduled >= 2)}  面试数：${s.interviewsScheduled}`,
      `   岗位失效率（<20%）  ${pilotPass((s.jobStaleFailureRatePct ?? 0) < 20)}  失效率：${pctFmt(s.jobStaleFailureRatePct)}`,
      ``,
      `👥 用户 & 企业`,
      `   注册用户：                      ${s.usersRegistered}`,
      `   已确认求职档案：               ${s.candidatesConfirmed}`,
      `   企业总数：                      ${s.companiesTotal}`,
      `   已验证企业：                    ${s.companiesVerified}`,
      ``,
      `💼 职位`,
      `   有效职位：                      ${s.jobsActive}`,
      `   待审核职位：                    ${s.jobsPendingReview}`,
      `   岗位失效率（STALE/失效/过期）：${pctFmt(s.jobStaleFailureRatePct)}`,
      ``,
      `🤝 匹配 & 联系`,
      `   兴趣总数：                      ${s.interestsTotal}`,
      `   匹配总数：                      ${s.matchesTotal}`,
      `   联系开放数：                    ${s.matchesContactOpened}`,
      `   企业响应率（总）：              ${pctFmt(s.companyOverallResponseRatePct)}`,
      `   24h 响应率：                    ${pctFmt(s.responseRate24hPct)}`,
      `   72h 无回应率：                  ${pctFmt(s.noResponse72hPct)}`,
      ``,
      `🏆 结果反馈`,
      `   面试数（INTERVIEWING 去重）：   ${s.interviewsScheduled}`,
      `   找到工作人数：                  ${s.candidatesFoundJob}`,
      `   找到候选人数：                  ${s.jobsFilled}`,
      ``,
      `📊 质量指标`,
      `   来源成功率（APPROVED/总数）：   ${pctFmt(s.sourceApprovalRatePct)}`,
      `   翻译失败率：                    ${pctFmt(s.translationFailureRatePct)}`,
      `   岗位过期率（staging）：         ${pctFmt(s.jobExpiryRatePct)}`,
    ];
    return lines.join('\n');
  }

  formatTelegram(s: OpsStats): string {
    const pctFmt = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}%`);
    const ok = (cond: boolean) => (cond ? '✅' : '▫️');
    const revIcon = (cond: boolean) => (cond ? '✅' : '⚠️');
    const r = s.reversal30d;
    const effectiveJobOk = (r.effectiveJobRatePct ?? 100) >= 70;
    const resp24Ok = (r.companyResponse24hPct ?? 100) >= 30;
    const contactOk = (r.contactOpenRatePct ?? 100) >= 20;
    const interviewOk = (r.interviewRatePct ?? 100) >= 5;
    return (
      `📊 JobTinder 运营统计\n` +
      `生成时间：${this.formatDate(s.generatedAt)}  (窗口 ${r.windowDays} 天)\n\n` +
      `🛡️ 反转条件预警（30天）\n` +
      `  ${revIcon(effectiveJobOk)} 有效岗位率：${pctFmt(r.effectiveJobRatePct)}  (≥70%)\n` +
      `  ${revIcon(resp24Ok)} 企业 24h 响应率：${pctFmt(r.companyResponse24hPct)}  (≥30%)\n` +
      `  ${revIcon(contactOk)} 联系开启率：${pctFmt(r.contactOpenRatePct)}  (≥20%)\n` +
      `  ${revIcon(interviewOk)} 面试转化率：${pctFmt(r.interviewRatePct)}  (≥5%)\n\n` +
      `🎯 14 天试点验收\n` +
      `  ${ok(s.candidatesConfirmed >= 30)} 真实求职者：${s.candidatesConfirmed} / 30\n` +
      `  ${ok(s.jobsActive >= 10 && s.jobsActive <= 20)} 有效岗位：${s.jobsActive}\n` +
      `  ${ok(s.interestsTotal >= 10)} 企业有效回应(兴趣)：${s.interestsTotal}\n` +
      `  ${ok(s.matchesContactOpened >= 5)} 联系开启：${s.matchesContactOpened} / 5\n` +
      `  ${ok(s.interviewsScheduled >= 2)} 真实面试：${s.interviewsScheduled} / 2\n` +
      `  ${ok((s.jobStaleFailureRatePct ?? 0) < 20)} 岗位失效率：${pctFmt(s.jobStaleFailureRatePct)} (<20%)\n\n` +
      `👥 用户与企业\n` +
      `  注册用户：${s.usersRegistered}\n` +
      `  已确认求职档案：${s.candidatesConfirmed}\n` +
      `  企业总数：${s.companiesTotal}\n` +
      `  已验证企业：${s.companiesVerified}\n\n` +
      `💼 职位\n` +
      `  有效职位：${s.jobsActive}\n` +
      `  待审核职位：${s.jobsPendingReview}\n` +
      `  岗位失效率：${pctFmt(s.jobStaleFailureRatePct)}\n\n` +
      `🤝 匹配\n` +
      `  兴趣总数：${s.interestsTotal}\n` +
      `  匹配总数：${s.matchesTotal}\n` +
      `  联系开放：${s.matchesContactOpened}\n` +
      `  企业响应率：${pctFmt(s.companyOverallResponseRatePct)}\n` +
      `  24h 响应率：${pctFmt(s.responseRate24hPct)}\n` +
      `  72h 无回应：${pctFmt(s.noResponse72hPct)}\n\n` +
      `🏆 成功结果\n` +
      `  面试数：${s.interviewsScheduled}\n` +
      `  找到工作人数：${s.candidatesFoundJob}\n` +
      `  招到候选人数：${s.jobsFilled}\n\n` +
      `📈 质量指标\n` +
      `  来源成功率：${pctFmt(s.sourceApprovalRatePct)}\n` +
      `  翻译失败率：${pctFmt(s.translationFailureRatePct)}\n` +
      `  岗位过期率：${pctFmt(s.jobExpiryRatePct)}`
    );
  }

  private formatDate(d: Date): string {
    const dt = d instanceof Date ? d : new Date(String(d));
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}Z`;
  }
}

function pct(num: number, den: number): number | null {
  if (!Number.isFinite(den) || den <= 0) return null;
  return Math.min(100, Math.max(0, (num / den) * 100));
}
