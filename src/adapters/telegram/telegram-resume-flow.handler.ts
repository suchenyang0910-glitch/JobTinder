import { Injectable } from '@nestjs/common';
import { InlineKeyboard, InputFile } from 'grammy';
import type { Translation } from '@src/shared/i18n/locales/en';
import { ResumeService } from '@src/application/resume/resume.service';
import type { ResumeDraft } from '@src/application/resume/resume.schema';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import type { TeleCtx } from './telegram-bot.service';

type ResumeDocument = NonNullable<
  Awaited<ReturnType<PrismaService['resume_documents']['findUnique']>>
>;

@Injectable()
export class TelegramResumeFlowHandler {
  constructor(
    private readonly resumes: ResumeService,
    private readonly prisma: PrismaService,
  ) {}

  async cancelUnprocessedDraft(userId: bigint): Promise<void> {
    await this.resumes.cancelUnprocessedDraft(userId);
  }

  async handleResumeCommand(ctx: TeleCtx, T: Translation): Promise<void> {
    const userId = this.userId(ctx);
    const doc = await this.prisma.resume_documents.findUnique({ where: { user_id: userId } });
    if (doc) return this.showResume(ctx, T, doc);
    ctx.session.step = 'RESUME_AWAIT_TEXT';
    await ctx.reply(
      'Paste your resume or describe your experience, education, and skills. Maximum 20,000 characters.',
    );
  }

  async handleMyResumeCommand(ctx: TeleCtx, T: Translation): Promise<void> {
    const doc = await this.prisma.resume_documents.findUnique({
      where: { user_id: this.userId(ctx) },
    });
    if (!doc) return void (await ctx.reply('No resume yet. Use /resume to create one.'));
    return this.showResume(ctx, T, doc);
  }

  async handleDeleteResumeCommand(ctx: TeleCtx): Promise<void> {
    const uid = this.userId(ctx);
    const used = await this.resumes.delete(uid);
    ctx.session.step = 'IDLE';
    await ctx.reply(
      used
        ? 'Your resume data was deleted. The one-free-resume limit remains used.'
        : 'Draft deleted. No free resume was used.',
    );
  }

  async handleText(ctx: TeleCtx, T: Translation): Promise<boolean> {
    if (ctx.session.step !== 'RESUME_AWAIT_TEXT') return false;
    const input = ctx.message?.text?.trim() ?? '';
    if (input.length < 20 || input.length > 20000) {
      await ctx.reply('Please send 20–20,000 characters, or use /cancel.');
      return true;
    }
    ctx.session.step = 'IDLE';
    try {
      await ctx.reply('⏳ Preparing your resume draft…');
      const uid = this.userId(ctx);
      const existing = await this.prisma.resume_documents.findUnique({ where: { user_id: uid } });
      const doc = existing
        ? await this.resumes.replaceInput(uid, input)
        : await this.resumes.createDraft(uid, input);
      if (doc?.output_language == null) {
        await ctx.reply('The input language is mixed or unclear. Choose the resume language:', {
          reply_markup: new InlineKeyboard()
            .text('ខ្មែរ', 'resume:language:km')
            .text('中文', 'resume:language:zh_CN')
            .text('English', 'resume:language:en')
            .row()
            .text('Cancel', 'resume:cancel'),
        });
      } else {
        await this.showResume(ctx, T, doc);
      }
    } catch {
      await ctx.reply('Could not create the draft. Please try again.');
    }
    return true;
  }

  async handleCallback(ctx: TeleCtx, action: string, T: Translation): Promise<void> {
    const userId = this.userId(ctx);
    await ctx.answerCallbackQuery().catch(() => undefined);
    if (action.startsWith('language:')) {
      const language = action.slice('language:'.length);
      if (!['en', 'zh_CN', 'km'].includes(language)) return;
      const doc = await this.resumes.completeDraft(userId, language as 'en' | 'zh_CN' | 'km');
      if (doc) await this.showResume(ctx, T, doc);
      return;
    }
    if (action === 'cancel') {
      await this.resumes.cancelUnprocessedDraft(userId);
      ctx.session.step = 'IDLE';
      await ctx.reply('Cancelled. No free resume was used.');
      return;
    }
    if (action === 'delete') return this.handleDeleteResumeCommand(ctx);
    if (action === 'edit') {
      ctx.session.step = 'RESUME_AWAIT_TEXT';
      await ctx.reply(
        'Send the complete revised resume text. The existing resume will be replaced after you review the new draft.',
      );
      return;
    }
    if (action === 'retry') {
      const doc = await this.resumes.retryDraft(userId);
      if (doc) await this.showResume(ctx, T, doc);
      return;
    }
    if (action === 'confirm') {
      await ctx.reply('⏳ Generating your Word document…');
      await this.resumes.confirmAndGenerate(userId);
      const filePath = await this.resumes.getDownloadPath(userId);
      await ctx.replyWithDocument(new InputFile(filePath), { caption: 'Your resume is ready.' });
      return;
    }
    if (action === 'download') {
      const filePath = await this.resumes.getDownloadPath(userId);
      await ctx.replyWithDocument(new InputFile(filePath));
      return;
    }
    if (action === 'check_status') return this.handleMyResumeCommand(ctx, T);
  }

  private async showResume(ctx: TeleCtx, _T: Translation, doc: ResumeDocument): Promise<void> {
    if (doc.status === 'DELETED') {
      await ctx.reply('Resume data was deleted. Your free resume has already been used.');
      return;
    }
    if (doc.status === 'GENERATING') {
      await ctx.reply('Your resume is being generated. Use /myresume to check again.');
      return;
    }
    if (doc.status === 'READY') {
      await ctx.reply('Your resume is ready.', {
        reply_markup: new InlineKeyboard()
          .text('⬇️ Download Word file', 'resume:download')
          .row()
          .text('✏️ Edit resume', 'resume:edit')
          .row()
          .text('🗑 Delete data', 'resume:delete'),
      });
      return;
    }
    const data = (
      doc.structured_json && typeof doc.structured_json === 'object' ? doc.structured_json : {}
    ) as Partial<ResumeDraft>;
    if (doc.output_language == null) {
      await ctx.reply('Choose the language for your resume:', {
        reply_markup: new InlineKeyboard()
          .text('ខ្មែរ', 'resume:language:km')
          .text('中文', 'resume:language:zh_CN')
          .text('English', 'resume:language:en')
          .row()
          .text('Cancel', 'resume:cancel'),
      });
      return;
    }
    const summary = [
      `Name: ${data.fullName || 'Not provided'}`,
      `Title: ${data.headline || 'Not provided'}`,
      `Skills: ${(data.skills ?? []).join(', ') || 'Not provided'}`,
      `Language: ${doc.output_language}`,
      ...(data.warnings ?? []).map((warning: string) => `Note: ${warning}`),
    ].join('\n');
    const keyboard = new InlineKeyboard()
      .text('✅ Confirm & generate Word', 'resume:confirm')
      .row()
      .text('✏️ Replace input', 'resume:edit')
      .row()
      .text('🗑 Delete data', 'resume:delete');
    if (doc.raw_input) keyboard.row().text('🔄 Retry AI', 'resume:retry');
    await ctx.reply(`Resume draft — review before generating:\n\n${summary}`, {
      reply_markup: keyboard,
    });
  }

  private userId(ctx: TeleCtx): bigint {
    if (!ctx.session.userId) throw new Error('Telegram identity is not initialized');
    return BigInt(ctx.session.userId);
  }
}
