import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { APP_ENV } from '@src/shared/env/app-env';

/** Sends review cards to the configured Telegram operator. No job is published here. */
@Injectable()
export class CrawlerReviewNotifierService {
  private readonly logger = new Logger(CrawlerReviewNotifierService.name);

  constructor(private readonly prisma: PrismaService) {}

  adminUsername(): string {
    return (process.env.CRAWLER_REVIEW_ADMIN_USERNAME || 'Faxonlei').replace(/^@/, '');
  }

  async isAdminTelegramUser(telegramUsername?: string | null): Promise<boolean> {
    return Boolean(telegramUsername && telegramUsername.toLowerCase() === this.adminUsername().toLowerCase());
  }

  private async adminChatId(): Promise<bigint | null> {
    const admin = await this.prisma.users.findFirst({
      where: { telegram_username: { equals: this.adminUsername(), mode: 'insensitive' } },
      select: { telegram_user_id: true },
    });
    return admin?.telegram_user_id ?? null;
  }

  private async send(text: string, inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>) {
    const chatId = await this.adminChatId();
    const token = APP_ENV.TELEGRAM_BOT_TOKEN;
    if (!chatId || !token) {
      this.logger.warn('Review notification skipped: admin has not started the bot or token is empty.');
      return false;
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text, disable_web_page_preview: true, reply_markup: { inline_keyboard: inlineKeyboard } }),
    });
    if (!response.ok) {
      this.logger.warn(`Review notification failed: HTTP ${response.status}`);
      return false;
    }
    return true;
  }

  async notifyPendingJobs(sourceId?: bigint): Promise<number> {
    const rows = await this.prisma.crawl_jobs_staging.findMany({
      where: { ...(sourceId ? { source_id: sourceId } : {}), status: 'QA_PENDING', review_notified_at: null },
      include: { source: { select: { name: true } }, job_translations: { orderBy: { language: 'asc' } } },
      orderBy: { id: 'asc' }, take: 10,
    });
    let sent = 0;
    for (const row of rows) {
      const titles = row.job_translations.map((t) => `${t.language}: ${t.title ?? row.title_source ?? '(no title)'}`).join('\n');
      const text = `🔎 JobTinder 职位待审核\n\n来源：${row.source.name}\n职位：${row.title_source ?? '(no title)'}\n地点：${row.locations_source ?? '未提供'}\n薪资：${row.salary_source ?? '未提供'}\n\n${titles}\n\n原始链接：${row.source_url}`;
      const ok = await this.send(text, [[
        { text: '✅ 批准发布', callback_data: `crawler_job:approve:${String(row.id)}` },
        { text: '❌ 不批准', callback_data: `crawler_job:reject:${String(row.id)}` },
      ]]);
      if (ok) { await this.prisma.crawl_jobs_staging.update({ where: { id: row.id }, data: { review_notified_at: new Date() } }); sent++; }
    }
    return sent;
  }

  async notifySource(sourceId: bigint): Promise<boolean> {
    const source = await this.prisma.source_registry.findUnique({ where: { id: sourceId } });
    if (!source || source.review_status !== 'PENDING') return false;
    const text = `🔎 JobTinder 来源待审核\n\n${source.name}\n${source.base_url}\n招聘页：${source.jobs_url}\n验证分数：${source.verification_score ?? '-'}\n说明：${source.verification_notes ?? '未提供'}`;
    return this.send(text, [[
      { text: '✅ 批准来源', callback_data: `crawler_source:approve:${String(source.id)}` },
      { text: '❌ 不批准', callback_data: `crawler_source:reject:${String(source.id)}` },
    ]]);
  }
}
