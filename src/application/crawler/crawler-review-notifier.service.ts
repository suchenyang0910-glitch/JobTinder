import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { APP_ENV } from '@src/shared/env/app-env';

function fmtCreatedAt(d: Date | string | null | undefined): string {
  if (!d) return '-';
  const dt = d instanceof Date ? d : new Date(String(d));
  if (Number.isNaN(dt.getTime())) return String(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}Z`;
}

function fmtSalary(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '面议';
  return s;
}

/** Sends review cards to the configured Telegram operator. No job is published here. */
@Injectable()
export class CrawlerReviewNotifierService {
  private readonly logger = new Logger(CrawlerReviewNotifierService.name);

  constructor(private readonly prisma: PrismaService) {}

  adminUsername(): string {
    return (process.env.CRAWLER_REVIEW_ADMIN_USERNAME || 'Faxonlei').replace(/^@/, '');
  }

  async isAdminTelegramUser(telegramUsername?: string | null): Promise<boolean> {
    const normalized = telegramUsername?.replace(/^@/, '').toLowerCase();
    return Boolean(normalized && normalized === this.adminUsername().toLowerCase());
  }

  private async adminChatId(): Promise<bigint | null> {
    const admin = await this.prisma.users.findFirst({
      where: { telegram_username: { equals: this.adminUsername(), mode: 'insensitive' } },
      select: { telegram_user_id: true },
    });
    return admin?.telegram_user_id ?? null;
  }

  private async send(
    text: string,
    inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>,
  ) {
    const chatId = await this.adminChatId();
    const token = APP_ENV.TELEGRAM_BOT_TOKEN;
    if (!chatId || !token) {
      this.logger.warn(
        'Review notification skipped: admin has not started the bot or token is empty.',
      );
      return false;
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: String(chatId),
        text,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: inlineKeyboard },
      }),
    });
    if (!response.ok) {
      this.logger.warn(`Review notification failed: HTTP ${response.status}`);
      return false;
    }
    return true;
  }

  async notifyPendingJobs(sourceId?: bigint): Promise<number> {
    const rows = await this.prisma.crawl_jobs_staging.findMany({
      where: {
        ...(sourceId ? { source_id: sourceId } : {}),
        status: 'QA_PENDING',
        review_notified_at: null,
      },
      orderBy: { id: 'asc' },
      take: 10,
      select: { id: true },
    });
    let sent = 0;
    for (const r of rows) {
      if (await this.notifyStaging(r.id, { forceRenotify: false })) sent++;
    }
    return sent;
  }

  async notifyStaging(stagingId: bigint, opts: { forceRenotify?: boolean } = {}): Promise<boolean> {
    const row = await this.prisma.crawl_jobs_staging.findUnique({
      where: { id: stagingId },
      include: {
        source: { select: { name: true } },
        job_translations: { orderBy: { language: 'asc' } },
      },
    });
    if (!row) return false;
    if (!opts.forceRenotify && row.review_notified_at) return false;
    if (
      row.status !== 'QA_PENDING' &&
      row.status !== 'REVIEW_REQUIRED' &&
      row.status !== 'DEFERRED'
    ) {
      return false;
    }
    const titleLines: string[] = [];
    const detailLines: string[] = [];
    let warnJoined = '';
    for (const t of row.job_translations) {
      titleLines.push(`${t.language.toUpperCase()}: ${t.title ?? row.title_source ?? '(无标题)'}`);
      const taskSlice = Array.isArray(t.tasks) ? t.tasks.slice(0, 3) : [];
      const skillSlice = Array.isArray(t.skills) ? t.skills.slice(0, 3) : [];
      const locSlice = Array.isArray(t.locations) ? t.locations.slice(0, 2) : [];
      const pieces = [
        taskSlice.length ? `· ${taskSlice.join(' / ')}` : '',
        skillSlice.length ? `🛠 ${skillSlice.join(' / ')}` : '',
        locSlice.length ? `📍 ${locSlice.join(' / ')}` : '',
        t.salary_text ? `💰 ${fmtSalary(t.salary_text)}` : '',
      ].filter(Boolean);
      if (pieces.length) detailLines.push(`${t.language.toUpperCase()}: ${pieces.join(' ')}`);
      const w = Array.isArray(t.warnings) ? t.warnings : [];
      if (w.length)
        warnJoined =
          (warnJoined ? `${warnJoined}; ` : '') + `${t.language.toUpperCase()}:${w.join('|')}`;
    }
    const originalSummary = [
      row.title_source ? `原文标题：${row.title_source}` : '',
      row.locations_source ? `原文地点：${row.locations_source}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const text =
      `🔎 JobTinder 职位待审核 #${String(row.id)}\n\n` +
      `来源：${row.source?.name ?? '(未知)'}\n` +
      `薪资：${fmtSalary(row.salary_source)}\n` +
      `抓取时间：${fmtCreatedAt(row.created_at)}\n\n` +
      `${titleLines.join('\n')}\n\n` +
      (detailLines.length ? `${detailLines.join('\n')}\n\n` : '') +
      (warnJoined ? `⚠️ 翻译 QA 警告：${warnJoined}\n\n` : '') +
      (originalSummary ? `${originalSummary}\n\n` : '') +
      `原始链接：${row.source_url ?? ''}`;
    const ok = await this.send(text, [
      [
        { text: '✅ 批准发布', callback_data: `crawler_job:approve:${String(row.id)}` },
        { text: '❌ 不批准', callback_data: `crawler_job:reject:${String(row.id)}` },
      ],
      [
        { text: '💤 暂缓审核', callback_data: `crawler_job:defer:${String(row.id)}` },
        { text: '🔄 重新翻译', callback_data: `crawler_job:retranslate:${String(row.id)}` },
      ],
    ]);
    if (ok && !row.review_notified_at) {
      await this.prisma.crawl_jobs_staging.update({
        where: { id: row.id },
        data: { review_notified_at: new Date() },
      });
    }
    return ok;
  }

  async notifySource(sourceId: bigint, opts: { forceRenotify?: boolean } = {}): Promise<boolean> {
    const source = await this.prisma.source_registry.findUnique({ where: { id: sourceId } });
    if (!source) return false;
    if (!opts.forceRenotify && source.source_notified_at) return false;
    if (source.review_status !== 'PENDING' && source.review_status !== 'DEFERRED') return false;
    const text =
      `🔎 JobTinder 来源待审核 #${String(source.id)}\n\n` +
      `${source.name}\n` +
      `官网：${source.base_url}\n` +
      `招聘页：${source.jobs_url}\n` +
      `发现方式：${source.discovery_method ?? 'manual'}\n` +
      `验证分数：${source.verification_score ?? '-'}\n` +
      `说明：${source.verification_notes ?? '未提供'}\n` +
      `发现时间：${fmtCreatedAt(source.created_at ?? new Date())}`;
    const ok = await this.send(text, [
      [
        { text: '✅ 批准来源', callback_data: `crawler_source:approve:${String(source.id)}` },
        { text: '❌ 不批准', callback_data: `crawler_source:reject:${String(source.id)}` },
      ],
      [
        { text: '💤 暂缓审核', callback_data: `crawler_source:defer:${String(source.id)}` },
        { text: '🚫 标记失效', callback_data: `crawler_source:suspend:${String(source.id)}` },
      ],
    ]);
    if (ok && !source.source_notified_at) {
      await this.prisma.source_registry.update({
        where: { id: source.id },
        data: { source_notified_at: new Date() },
      });
    }
    return ok;
  }

  async reviewCounts(): Promise<{ pendingJobs: number; pendingSources: number }> {
    const [pendingJobs, pendingSources] = await Promise.all([
      this.prisma.crawl_jobs_staging.count({
        where: {
          OR: [{ status: 'QA_PENDING' }, { status: 'REVIEW_REQUIRED' }, { status: 'DEFERRED' }],
        },
      }),
      this.prisma.source_registry.count({
        where: { OR: [{ review_status: 'PENDING' }, { review_status: 'DEFERRED' }] },
      }),
    ]);
    return { pendingJobs, pendingSources };
  }

  async listPendingJobs(limit = 10): Promise<bigint[]> {
    const rows = await this.prisma.crawl_jobs_staging.findMany({
      where: {
        OR: [{ status: 'QA_PENDING' }, { status: 'REVIEW_REQUIRED' }, { status: 'DEFERRED' }],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: Math.min(Math.max(limit, 1), 50),
    });
    return rows.map((r) => r.id);
  }

  async listPendingSources(limit = 10): Promise<bigint[]> {
    const rows = await this.prisma.source_registry.findMany({
      where: { OR: [{ review_status: 'PENDING' }, { review_status: 'DEFERRED' }] },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: Math.min(Math.max(limit, 1), 50),
    });
    return rows.map((r) => r.id);
  }

  async notifyAdminGeneric(payload: {
    headline: string;
    lines?: string[];
    footer?: string;
  }): Promise<boolean> {
    const parts = [payload.headline];
    if (payload.lines && payload.lines.length > 0) {
      parts.push('', ...payload.lines);
    }
    if (payload.footer) parts.push('', payload.footer);
    const text = parts.join('\n').slice(0, 3800);
    return this.send(text, []);
  }
}
