import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Bot, Context, session, type SessionFlavor } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { StorageAdapter } from 'grammy';
import type { Language, UserRole } from '@prisma/client';

import { APP_ENV } from '@src/shared/env/app-env';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import type { Clock } from '@src/shared/clock/clock';
import { PostgresSessionStorage } from '@src/infrastructure/telegram/postgres-session-storage';
import type { TelegramBotSession } from './telegram-bot-session.types';
import { createEmptySession } from './telegram-bot-session.types';
import { UserIdentityService } from '@src/application/identity/user-identity.service';
import { CandidateOnboardingService } from '@src/application/onboarding/candidate-onboarding.service';
import { CompanyOnboardingService } from '@src/application/onboarding/company-onboarding.service';
import { AIOnboardingService } from '@src/application/onboarding/ai-onboarding.service';
import type { AILanguage } from '@src/domain/trust/ai-extract-provider';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { translateAppError } from './error-translator';
import { pickT } from '@src/shared/i18n';
import type { Translation } from '@src/shared/i18n/locales/en';
import {
  isProfileReadyToConfirm,
  type CandidateDraftFields,
} from '@src/domain/profiles/candidate-profile-domain';
import { TelegramAIFlowHandler, STEPS as AI_STEPS } from './telegram-ai-flow.handler';

export type TeleCtx = Context & SessionFlavor<TelegramBotSession>;

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Bot<TeleCtx> | null = null;

  constructor(
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    private readonly sessionStorage: PostgresSessionStorage<TelegramBotSession>,
    private readonly userIdentity: UserIdentityService,
    private readonly candidateOnboarding: CandidateOnboardingService,
    private readonly companyOnboarding: CompanyOnboardingService,
    private readonly aiFlow: TelegramAIFlowHandler,
    private readonly aiOnboarding: AIOnboardingService,
  ) {}

  onModuleInit() {
    if (process.env.CRAWLER_CLI_MODE === 'true') {
      this.logger.log('Telegram polling disabled for crawler CLI context.');
      return;
    }
    const token = APP_ENV.TELEGRAM_BOT_TOKEN;
    if (!token) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN is empty — Telegram bot DISABLED. Service runs but no messages will be received.',
      );
      return;
    }
    const bot = new Bot<TeleCtx>(token);
    this.bot = bot;

    bot.use(
      session({
        initial: () => createEmptySession(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        storage: this.sessionStorage as unknown as StorageAdapter<any>,
        getSessionKey: (ctx) => {
          const salt = APP_ENV.TELEGRAM_SESSION_SALT;
          const uid = ctx.from?.id;
          if (!uid) return undefined;
          return `${salt}:${uid}`;
        },
      }),
    );

    bot.catch((err) => {
      const stack = err.error instanceof Error ? err.error.stack : undefined;
      this.logger.error('GrammY error', stack);
    });

    // Debug: log every received update. Write directly to stdout (not Nest
    // logger) so we can confirm polling is actually delivering messages
    // regardless of the configured Nest log level.
    // ONLY presence + truncated cmd text, NEVER PII.
    bot.use(async (ctx, next) => {
      const updateId = ctx.update?.update_id ?? 0;
      const hasMsg = Boolean(ctx.message);
      const hasCb = Boolean(ctx.callbackQuery);
      const cmd = ctx.message?.text?.slice(0, 60) ?? '-';
      const fromId = ctx.from?.id ?? 0;
      // eslint-disable-next-line no-console
      console.log(
        `[grammY:rx] update=${updateId} msg=${hasMsg} cb=${hasCb} from=${fromId} cmd="${cmd}"`,
      );
      try {
        await next();
      } finally {
        // eslint-disable-next-line no-console
        console.log(`[grammY:tx-ok] update=${updateId} handled`);
      }
    });

    // Commands
    bot.command('start', (ctx) => this.safeRun(ctx, (c) => this.handleStart(c)));
    bot.command('menu', (ctx) => this.safeRun(ctx, (c) => this.handleMenu(c)));
    bot.command('help', (ctx) => this.safeRun(ctx, (c) => this.handleHelp(c)));
    bot.command('cancel', (ctx) => this.safeRun(ctx, (c) => this.handleCancel(c)));
    bot.command('profile', (ctx) => this.safeRun(ctx, (c) => this.handleProfileCommand(c)));
    bot.command('company', (ctx) => this.safeRun(ctx, (c) => this.handleCompanyCommand(c)));
    bot.command('delete', (ctx) => ctx.reply('Feature coming in stage-2. Use /cancel for now.'));
    bot.command('matches', (ctx) => ctx.reply('Feature coming in stage-2. Use /menu to browse.'));
    bot.command('settings', (ctx) => ctx.reply('Feature coming in stage-2.'));

    // Callback queries
    bot.callbackQuery(/^lang:(en|zh_CN|km)$/, (ctx) =>
      this.safeRun(ctx, (c) => this.handleLanguagePick(c)),
    );
    bot.callbackQuery(/^role:(CANDIDATE|COMPANY|BOTH)$/, (ctx) =>
      this.safeRun(ctx, (c) => this.handleRolePick(c)),
    );
    bot.callbackQuery(/^cand_ob:(confirm|edit)$/, (ctx) =>
      this.safeRun(ctx, (c) => this.handleOnboardConfirmChoice(c)),
    );
    bot.callbackQuery(/^cand_mode:(ai|manual)$/, (ctx) =>
      this.safeRun(ctx, (c) => {
        const data = c.callbackQuery?.data;
        if (!data) return Promise.resolve();
        return this.aiFlow.handleAIModeChosen(c, data.slice(9) as 'ai' | 'manual');
      }),
    );
    bot.callbackQuery(/^cand_ai:(confirm|edit|redescribe|cancel)$/, (ctx) =>
      this.safeRun(ctx, (c) => {
        const data = c.callbackQuery?.data;
        if (!data) return Promise.resolve();
        return this.aiFlow.handleAICallback(
          c,
          data.slice(8) as 'confirm' | 'edit' | 'redescribe' | 'cancel',
        );
      }),
    );
    bot.callbackQuery(/^company_job:(ai|manual)$/, (ctx) =>
      this.safeRun(ctx, (c) => {
        const data = c.callbackQuery?.data;
        if (!data) return Promise.resolve();
        return this.handleCompanyJobModeChosen(c, data.slice(12) as 'ai' | 'manual');
      }),
    );
    bot.callbackQuery(/^company_profile:(edit|done)$/, (ctx) =>
      this.safeRun(ctx, (c) => this.handleCompanyProfileAction(c, c.callbackQuery?.data?.split(':')[1] as 'edit' | 'done')),
    );
    bot.callbackQuery(/^company_job_action:(publish|edit|cancel)$/, (ctx) =>
      this.safeRun(ctx, (c) => this.handleCompanyJobAction(c, c.callbackQuery?.data?.split(':')[1] as 'publish' | 'edit' | 'cancel')),
    );
    bot.callbackQuery(/^company_jobs:list$/, (ctx) => this.safeRun(ctx, (c) => this.handleCompanyJobsList(c)));
    bot.callbackQuery(/^company_job_edit:(title|salary)(?::\d+)?$/, (ctx) =>
      this.safeRun(ctx, (c) => this.handleCompanyJobEditStart(c, c.callbackQuery?.data?.split(':')[1] as 'title' | 'salary')),
    );

    // Plain text
    bot.on('message:text', (ctx) => this.safeRun(ctx, (c) => this.handleTextMessage(c)));

    bot
      .start({
        allowed_updates: ['message', 'callback_query'],
        onStart: () => this.logger.log('Bot started polling OK'),
      })
      .catch((e) => {
        this.logger.error('Bot start() failed', e?.stack ?? undefined);
      });
  }

  onModuleDestroy() {
    this.bot?.stop().catch(() => undefined);
  }

  private async safeRun(ctx: TeleCtx, fn: (c: TeleCtx) => Promise<void>) {
    try {
      await fn(ctx);
    } catch (e) {
      try {
        await this.handleReplyError(ctx, e);
      } catch (replyErr) {
        // Last-resort catch-all: even handleReplyError might fail (ctx.session
        // read, ctx.reply network issue, etc). Never let an unhandled error
        // bubble up into grammY error handler with "no user-visible reaction".
        this.logger.error(
          `handler+reply both failed, trying ctx.reply plain`,
          replyErr instanceof Error ? replyErr.stack : undefined,
        );
        try {
          await ctx.reply('⚠️ Service is warming up — please retry in 30 seconds.');
        } catch {
          /* totally unrecoverable */
        }
      }
    }
  }

  // ----------------------------------------------------------------------
  // Handlers
  // ----------------------------------------------------------------------

  private async handleStart(ctx: TeleCtx) {
    if (!ctx.from) return;

    const { user, isNew } = await this.userIdentity.upsertFromTelegram({
      telegramUserId: BigInt(ctx.from.id),
      telegramUsername: ctx.from.username ?? null,
      telegramFirstName: ctx.from.first_name ?? null,
      telegramLastName: ctx.from.last_name ?? null,
      initialPreference: undefined,
    });
    ctx.session.userId = String(user.id);
    ctx.session.language = user.language;
    ctx.session.preferredRole = user.preferredRole ?? undefined;
    ctx.session.step = 'CHOOSE_LANGUAGE';

    const T = this.T(ctx);
    const name = ctx.from.first_name || 'friend';

    await ctx.reply(isNew ? T.START.welcome_new(name) : T.START.welcome_back(name), {
      reply_markup: this.langKeyboard(),
    });
  }

  private async handleHelp(ctx: TeleCtx) {
    const T = this.T(ctx);
    await ctx.reply(T.START.help(), { parse_mode: undefined });
  }

  private async handleMenu(ctx: TeleCtx) {
    await this.ensureIdentity(ctx);
    const T = this.T(ctx);
    const kb = new InlineKeyboard()
      .text(T.MENU.profileCandidate(), 'menu:profile:candidate')
      .row()
      .text(T.MENU.profileCompany(), 'menu:profile:company')
      .row()
      .text(T.MENU.findJobs(), 'menu:find')
      .text(T.MENU.viewMatches(), 'menu:matches')
      .row()
      .text(T.MENU.settings(), 'menu:settings')
      .text(T.MENU.help(), 'menu:help');
    await ctx.reply(T.MENU.title(), { reply_markup: kb });
  }

  private async handleCancel(ctx: TeleCtx) {
    ctx.session.step = 'IDLE';
    ctx.session.candidateDraftId = undefined;
    ctx.session.candidateDraftVersion = undefined;
    await ctx.reply('Canceled. Use /menu to continue.');
  }

  private async handleProfileCommand(ctx: TeleCtx) {
    await this.ensureIdentity(ctx);
    return this.aiFlow.handleProfileModeChoice(ctx);
  }

  private async handleLanguagePick(ctx: TeleCtx) {
    if (!ctx.callbackQuery?.data) return;
    const m = /^lang:(en|zh_CN|km)$/.exec(ctx.callbackQuery.data);
    if (!m) return;
    const language = m[1] as Language;
    const { userId } = await this.ensureIdentity(ctx);
    const { user } = await this.userIdentity.upsertFromTelegram({
      telegramUserId: BigInt(ctx.from!.id),
      initialPreference: { language },
    });
    ctx.session.language = user.language;
    ctx.session.userId = String(userId);
    ctx.session.step = 'CHOOSE_ROLE';
    const T = this.T(ctx);
    await ctx.answerCallbackQuery();
    await ctx.reply(T.LANG.set());
    await ctx.reply(T.ROLES.pick(), { reply_markup: this.roleKeyboard(T) });
  }

  private async handleRolePick(ctx: TeleCtx) {
    if (!ctx.callbackQuery?.data) return;
    const m = /^role:(CANDIDATE|COMPANY|BOTH)$/.exec(ctx.callbackQuery.data);
    if (!m) return;
    const role = m[1] as UserRole;
    await this.ensureIdentity(ctx);
    await this.userIdentity.upsertFromTelegram({
      telegramUserId: BigInt(ctx.from!.id),
      initialPreference: { role },
    });
    ctx.session.preferredRole = role;
    ctx.session.step = 'IDLE';
    const T = this.T(ctx);
    await ctx.answerCallbackQuery();
    await ctx.reply(T.ROLES.set(role));

    if (role === 'CANDIDATE' || role === 'BOTH') {
      const userId = this.requireUserId(ctx);
      const created = await this.candidateOnboarding.createDraft({ userId, source: 'manual' });
      ctx.session.candidateDraftId = String(created.id);
      ctx.session.candidateDraftVersion = created.version;
      ctx.session.step = 'CANDIDATE_ONBOARD_ASK_ROLES';
      await ctx.reply(T.CANDIDATE_ONBOARD.intro());
      await ctx.reply(T.CANDIDATE_ONBOARD.askTargetRoles());
    }

    if (role === 'COMPANY' || role === 'BOTH') {
      // Stage-2 will add the company onboarding wizard. Stage-1: create draft & preview.
      const userId = this.requireUserId(ctx);
      const created = await this.companyOnboarding.createDraft({ userId, source: 'manual' });
      ctx.session.step = 'IDLE';
      void created;
      await ctx.reply(
        `🏢 Company profile area is ready for stage-2.\n` +
          `Company id=${String(created.id)} (${created.verificationStatus}).\n` +
          `Use /company anytime to view the skeleton.`,
      );
    }
  }

  private async handleCompanyCommand(ctx: TeleCtx) {
    const { userId } = await this.ensureIdentity(ctx);
    const T = this.T(ctx);
    const latest = await this.companyOnboarding.getLatest(userId);
    const draft =
      latest ?? (await this.companyOnboarding.createDraft({ userId, source: 'manual' }));
    const f = draft.fields;
    const lines: string[] = [
      '🏢 Company profile',
      `Verification: ${draft.verificationStatus}`,
      `Ownership: ${draft.isOwner ? '✅ Owner (companies_members.is_owner=true)' : 'Member'}`,
      '',
      `• Name: ${f.name ?? T.COMMON.notProvided()}`,
      `• Industry: ${f.industry ?? T.COMMON.notProvided()}`,
      `• Size: ${f.size ?? T.COMMON.notProvided()}`,
      `• Location: ${f.location ?? T.COMMON.notProvided()}`,
      `• Website: ${f.website ?? T.COMMON.notProvided()}`,
      `• Recruiter: ${f.recruiterName ?? T.COMMON.notProvided()} (${f.recruiterRole ?? '-'})`,
      '',
      T.COMPANY_ONBOARD.intro(),
    ];
    ctx.session.step = 'COMPANY_MODE_PICK';
    const kb = new InlineKeyboard()
      .text('✏️ 编辑企业资料', 'company_profile:edit').row()
      .text('📋 查看我的职位', 'company_jobs:list').row()
      .text(T.COMPANY_ONBOARD.button_job_ai(), 'company_job:ai')
      .row()
      .text(T.COMPANY_ONBOARD.button_job_manual(), 'company_job:manual');
    await ctx.reply(lines.join('\n'), { reply_markup: kb });
  }

  private static toAILanguage(l: Language | undefined): AILanguage {
    if (l === 'zh_CN' || l === 'en' || l === 'km') return l;
    return 'en';
  }

  private async handleCompanyJobModeChosen(ctx: TeleCtx, kind: 'ai' | 'manual'): Promise<void> {
    const T = this.T(ctx);
    if (kind === 'manual') {
      await ctx.answerCallbackQuery?.();
      ctx.session.step = 'COMPANY_JOB_EDIT_TITLE';
      await ctx.reply('请输入职位名称：');
      return;
    }
    await ctx.answerCallbackQuery?.();
    ctx.session.step = 'COMPANY_AI_AWAIT_JD_TEXT';
    await ctx.reply(T.COMPANY_ONBOARD.ask_jd_prompt());
  }

  private async handleCompanyJDText(ctx: TeleCtx, raw: string): Promise<void> {
    const T = this.T(ctx);
    const text = raw.trim();
    if (text.length < 20) {
      await ctx.reply(T.COMPANY_ONBOARD.extract_failed());
      const kb = new InlineKeyboard()
        .text(T.COMPANY_ONBOARD.button_job_ai(), 'company_job:ai')
        .row()
        .text(T.COMPANY_ONBOARD.button_job_manual(), 'company_job:manual');
      await ctx.reply(T.COMPANY_ONBOARD.intro(), { reply_markup: kb });
      return;
    }
    const loading = await ctx.reply(T.COMPANY_ONBOARD.extract_loading());
    try {
      const extracted = await this.aiOnboarding.extractJobDraftOnly(
        text,
        TelegramBotService.toAILanguage(ctx.session.language),
      );
      await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => undefined);
      if (extracted.degraded) {
        await ctx.reply(T.COMPANY_ONBOARD.extract_failed());
        const kb = new InlineKeyboard()
          .text(T.COMPANY_ONBOARD.button_job_ai(), 'company_job:ai')
          .row()
          .text(T.COMPANY_ONBOARD.button_job_manual(), 'company_job:manual');
        await ctx.reply(T.COMPANY_ONBOARD.intro(), { reply_markup: kb });
        return;
      }
      ctx.session.step = 'COMPANY_AI_PREVIEW';
      await this.sendCompanyJobPreview(ctx, extracted);
    } catch (e) {
      await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => undefined);
      this.logger.warn(
        `Company JD AI extract failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      await ctx.reply(T.COMPANY_ONBOARD.extract_failed());
      const kb = new InlineKeyboard()
        .text(T.COMPANY_ONBOARD.button_job_ai(), 'company_job:ai')
        .row()
        .text(T.COMPANY_ONBOARD.button_job_manual(), 'company_job:manual');
      await ctx.reply(T.COMPANY_ONBOARD.intro(), { reply_markup: kb });
    }
  }

  private async sendCompanyJobPreview(
    ctx: TeleCtx,
    job: {
      fields: {
        title: string | null;
        tasks: string[];
        skills: string[];
        industry: string | null;
        locations: string[];
        languagesRequired: string[];
        shifts: string[];
        salaryStatus: 'PROVIDED' | 'NOT_PROVIDED' | 'NEGOTIABLE';
        salaryText: string | null;
        availabilityStart: string | null;
        housingProvided: boolean | null;
        mealsProvided: boolean | null;
        transportProvided: boolean | null;
        workPermitRequired: boolean | null;
        headcount: number | null;
      };
      unknownFields: string[];
      warnings: string[];
    },
  ): Promise<void> {
    const T = this.T(ctx);
    const f = job.fields;
    const lines: string[] = [T.COMPANY_ONBOARD.preview_title(), ''];
    lines.push(`• Title: ${f.title ?? T.COMMON.notProvided()}`);
    if (f.industry) lines.push(`• Industry: ${f.industry}`);
    if (f.tasks?.length) lines.push(`• Tasks: ${f.tasks.join(', ')}`);
    if (f.skills?.length) lines.push(`• Skills: ${f.skills.join(', ')}`);
    if (f.locations?.length) lines.push(`• Locations: ${f.locations.join(', ')}`);
    if (f.languagesRequired?.length) lines.push(`• Languages: ${f.languagesRequired.join(', ')}`);
    if (f.shifts?.length) lines.push(`• Shifts: ${f.shifts.join(', ')}`);
    const salary =
      f.salaryStatus === 'PROVIDED'
        ? f.salaryText || ''
        : f.salaryStatus === 'NEGOTIABLE'
          ? T.COMMON.negotiable()
          : T.COMMON.notProvided();
    lines.push(`• Salary: ${salary}`);
    if (f.headcount != null) lines.push(`• Headcount: ${String(f.headcount)}`);
    if (f.availabilityStart) lines.push(`• Start: ${f.availabilityStart}`);
    const benefits: string[] = [];
    if (f.housingProvided === true) benefits.push('housing');
    if (f.mealsProvided === true) benefits.push('meals');
    if (f.transportProvided === true) benefits.push('transport');
    if (benefits.length) lines.push(`• Benefits: ${benefits.join(', ')}`);
    if (f.workPermitRequired === true) lines.push(`• Work permit: required`);
    if (job.warnings?.length) {
      lines.push('');
      lines.push(T.AI_ONBOARD.warnings_title());
      for (const w of job.warnings.slice(0, 5)) lines.push(`  ⚠️ ${w}`);
    }
    lines.push('');
    lines.push('⚠️ 这是草稿，确认后才会发布；发布后仍可编辑。');
    const userId = this.requireUserId(ctx);
    const draft = await this.companyOnboarding.createJobDraft(userId, {
      title: f.title ?? 'Untitled job', industry: f.industry, tasks: f.tasks, skills: f.skills,
      locations: f.locations, languagesRequired: f.languagesRequired, shifts: f.shifts,
      salaryStatus: f.salaryStatus, salaryText: f.salaryText,
    });
    ctx.session.companyJobDraftId = String(draft.id);
    const kb = new InlineKeyboard().text('✅ 发布职位', 'company_job_action:publish').row()
      .text('✏️ 修改职位', 'company_job_action:edit').text('❌ 取消', 'company_job_action:cancel');
    await ctx.reply(lines.join('\n'), { reply_markup: kb });
  }

  private async handleCompanyProfileAction(ctx: TeleCtx, action: 'edit' | 'done') {
    await ctx.answerCallbackQuery().catch(() => undefined);
    if (action === 'done') { ctx.session.step = 'IDLE'; await ctx.reply('已保存企业资料。'); return; }
    ctx.session.step = 'COMPANY_EDIT_NAME';
    await ctx.reply('请输入企业名称：');
  }

  private async handleCompanyJobsList(ctx: TeleCtx) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const jobs = await this.companyOnboarding.listJobs(this.requireUserId(ctx));
    if (!jobs.length) { await ctx.reply('还没有职位。'); return; }
    for (const j of jobs) {
      const status = j.status === 'ACTIVE_CLAIMED' ? '已发布' : j.status === 'DRAFT' ? '草稿' : String(j.status);
      const kb = new InlineKeyboard()
        .text(`✏️ 编辑名称`, `company_job_edit:title:${String(j.id)}`)
        .text(`💰 编辑薪资`, `company_job_edit:salary:${String(j.id)}`);
      await ctx.reply(`职位 #${String(j.id)}\n${j.title}\n状态：${status}\n薪资：${j.salary_text ?? '未提供'}`, { reply_markup: kb });
    }
  }

  private async handleCompanyJobAction(ctx: TeleCtx, action: 'publish' | 'edit' | 'cancel') {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const id = ctx.session.companyJobDraftId;
    if (!id) { await ctx.reply('草稿已失效，请重新发布。'); return; }
    if (action === 'publish') {
      await this.companyOnboarding.publishJob(this.requireUserId(ctx), BigInt(id));
      ctx.session.companyJobDraftId = undefined; ctx.session.step = 'IDLE';
      await ctx.reply('✅ 职位已发布。之后可在「查看我的职位」中编辑。'); return;
    }
    if (action === 'cancel') {
      await this.companyOnboarding.updateJob(this.requireUserId(ctx), BigInt(id), { title: '已取消职位' });
      ctx.session.companyJobDraftId = undefined; ctx.session.step = 'IDLE'; await ctx.reply('已取消草稿。'); return;
    }
    ctx.session.companyJobEditId = id; ctx.session.step = 'COMPANY_JOB_EDIT_TITLE';
    await ctx.reply('请输入新的职位名称：');
  }

  private async handleCompanyJobEditStart(ctx: TeleCtx, field: 'title' | 'salary') {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const parts = ctx.callbackQuery?.data?.split(':') ?? [];
    const id = parts[2] ?? ctx.session.companyJobDraftId;
    if (!id) { await ctx.reply('职位不存在。'); return; }
    ctx.session.companyJobEditId = id;
    ctx.session.step = field === 'title' ? 'COMPANY_JOB_EDIT_TITLE' : 'COMPANY_JOB_EDIT_SALARY';
    await ctx.reply(field === 'title' ? '请输入新的职位名称：' : '请输入新的薪资（如 800-1200 USD；输入 - 表示面议）：');
  }

  private async handleTextMessage(ctx: TeleCtx) {
    const step = ctx.session.step;
    const rawText = ctx.message?.text ?? '';
    const text = rawText.trim();
    if (!text) return;
    const T = this.T(ctx);

    switch (step) {
      case AI_STEPS.CANDIDATE_MODE_PICK:
      case AI_STEPS.CANDIDATE_AI_CONFIRM:
      case 'COMPANY_MODE_PICK':
      case 'COMPANY_AI_PREVIEW':
        await this.handleMenu(ctx);
        return;
      case AI_STEPS.CANDIDATE_AI_AWAIT_TEXT:
        await this.aiFlow.handleAICandidateText(ctx, text);
        return;
      case 'COMPANY_AI_AWAIT_JD_TEXT':
        await this.handleCompanyJDText(ctx, text);
        return;
      case 'COMPANY_EDIT_NAME':
      case 'COMPANY_EDIT_INDUSTRY':
      case 'COMPANY_EDIT_SIZE':
      case 'COMPANY_EDIT_LOCATION':
      case 'COMPANY_EDIT_WEBSITE':
      case 'COMPANY_EDIT_RECRUITER': {
        const fields: Record<string, keyof import('@src/application/onboarding/company-onboarding.service').CompanyDraftFields> = {
          COMPANY_EDIT_NAME: 'name', COMPANY_EDIT_INDUSTRY: 'industry', COMPANY_EDIT_SIZE: 'size',
          COMPANY_EDIT_LOCATION: 'location', COMPANY_EDIT_WEBSITE: 'website', COMPANY_EDIT_RECRUITER: 'recruiterName',
        };
        const field = fields[step];
        if (!field) { ctx.session.step = 'IDLE'; return; }
        await this.companyOnboarding.updateProfile(this.requireUserId(ctx), { [field]: text === '-' ? '' : text });
        const next: Record<string, TelegramBotSession['step']> = {
          COMPANY_EDIT_NAME: 'COMPANY_EDIT_INDUSTRY', COMPANY_EDIT_INDUSTRY: 'COMPANY_EDIT_SIZE',
          COMPANY_EDIT_SIZE: 'COMPANY_EDIT_LOCATION', COMPANY_EDIT_LOCATION: 'COMPANY_EDIT_WEBSITE',
          COMPANY_EDIT_WEBSITE: 'COMPANY_EDIT_RECRUITER', COMPANY_EDIT_RECRUITER: 'IDLE',
        };
        const nextStep = next[step] ?? 'IDLE';
        ctx.session.step = nextStep;
        if (ctx.session.step === 'IDLE') await ctx.reply('✅ 企业资料已保存，可随时用 /company 修改。');
        else await ctx.reply(({ COMPANY_EDIT_INDUSTRY: '请输入行业：', COMPANY_EDIT_SIZE: '请输入企业规模：', COMPANY_EDIT_LOCATION: '请输入工作地点：', COMPANY_EDIT_WEBSITE: '请输入企业官网（没有请输入 -）：', COMPANY_EDIT_RECRUITER: '请输入招聘联系人姓名：' } as Record<string,string>)[nextStep] ?? '请输入：');
        return;
      }
      case 'COMPANY_JOB_EDIT_TITLE': {
        const id = ctx.session.companyJobEditId ?? ctx.session.companyJobDraftId;
        if (!id) { ctx.session.step = 'IDLE'; await ctx.reply('职位草稿已失效。'); return; }
        await this.companyOnboarding.updateJob(this.requireUserId(ctx), BigInt(id), { title: text });
        ctx.session.companyJobDraftId = id; ctx.session.step = 'IDLE';
        await ctx.reply('✅ 职位名称已保存。发布草稿请再次打开 /company。');
        return;
      }
      case 'COMPANY_JOB_EDIT_SALARY': {
        const id = ctx.session.companyJobEditId ?? ctx.session.companyJobDraftId;
        if (!id) { ctx.session.step = 'IDLE'; await ctx.reply('职位不存在。'); return; }
        await this.companyOnboarding.updateJob(this.requireUserId(ctx), BigInt(id), { salaryStatus: text === '-' ? 'NEGOTIABLE' : 'PROVIDED', salaryText: text === '-' ? null : text });
        ctx.session.step = 'IDLE'; await ctx.reply('✅ 薪资已保存。'); return;
      }
      case 'CANDIDATE_ONBOARD_ASK_ROLES':
        await this.saveCandidateFieldStep(ctx, 'targetRoles', splitCsv(text));
        ctx.session.step = 'CANDIDATE_ONBOARD_ASK_SKILLS';
        await ctx.reply(T.CANDIDATE_ONBOARD.askSkills());
        return;
      case 'CANDIDATE_ONBOARD_ASK_SKILLS':
        await this.saveCandidateFieldStep(ctx, 'skills', splitCsv(text));
        ctx.session.step = 'CANDIDATE_ONBOARD_ASK_INDUSTRIES';
        await ctx.reply(T.CANDIDATE_ONBOARD.askIndustries());
        return;
      case 'CANDIDATE_ONBOARD_ASK_INDUSTRIES': {
        const industries = text === '-' ? [] : splitCsv(text);
        await this.saveCandidateFieldStep(ctx, 'industries', industries);
        await this.sendCandidatePreview(ctx);
        return;
      }
      case 'IDLE':
      default:
        await this.handleMenu(ctx);
    }
  }

  private async handleOnboardConfirmChoice(ctx: TeleCtx) {
    if (!ctx.callbackQuery?.data) return;
    const choice = ctx.callbackQuery.data.startsWith('cand_ob:confirm') ? 'confirm' : 'edit';
    const T = this.T(ctx);
    const userId = this.requireUserId(ctx);
    const draftId = ctx.session.candidateDraftId;
    const expectedVersion = ctx.session.candidateDraftVersion;
    if (!draftId || expectedVersion == null) {
      throw new AppError({ code: AppErrorCode.PROFILE_DRAFT_STALE });
    }

    if (choice === 'confirm') {
      try {
        await this.candidateOnboarding.confirm({
          userId,
          draftId: BigInt(draftId),
          expectedVersion,
        });
        ctx.session.step = 'IDLE';
        ctx.session.candidateDraftId = undefined;
        ctx.session.candidateDraftVersion = undefined;
        await ctx.answerCallbackQuery();
        await ctx.reply(T.CANDIDATE_ONBOARD.confirmed());
      } catch (e) {
        if (e instanceof AppError && e.code === 'PROFILE_NOT_CONFIRMED') {
          await ctx.answerCallbackQuery();
          const active = await this.candidateOnboarding.getActiveDraft(userId);
          if (active) {
            const ready = isProfileReadyToConfirm(active.fields);
            if (!ready.ok) {
              await ctx.reply(T.CANDIDATE_ONBOARD.missing_required(ready.missing.join(', ')));
              ctx.session.step = ready.missing.includes('targetRoles')
                ? 'CANDIDATE_ONBOARD_ASK_ROLES'
                : 'CANDIDATE_ONBOARD_ASK_SKILLS';
              const nextQ =
                ctx.session.step === 'CANDIDATE_ONBOARD_ASK_ROLES'
                  ? T.CANDIDATE_ONBOARD.askTargetRoles()
                  : T.CANDIDATE_ONBOARD.askSkills();
              await ctx.reply(nextQ);
              return;
            }
          }
          await ctx.reply(T.ERRORS.PROFILE_NOT_CONFIRMED(''));
          return;
        }
        throw e;
      }
    } else {
      ctx.session.step = 'CANDIDATE_ONBOARD_ASK_ROLES';
      await ctx.answerCallbackQuery();
      await ctx.reply(T.CANDIDATE_ONBOARD.askTargetRoles());
    }
  }

  // ----------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------

  private async saveCandidateFieldStep(
    ctx: TeleCtx,
    field: keyof CandidateDraftFields,
    value: unknown,
  ): Promise<void> {
    const userId = this.requireUserId(ctx);
    const draftId = ctx.session.candidateDraftId;
    const expectedVersion = ctx.session.candidateDraftVersion;
    if (!draftId || expectedVersion == null) {
      throw new AppError({ code: AppErrorCode.PROFILE_DRAFT_STALE });
    }
    const saved = await this.candidateOnboarding.updateDraft({
      userId,
      draftId: BigInt(draftId),
      expectedVersion,
      edits: { [field]: value },
    });
    ctx.session.candidateDraftVersion = saved.version;
  }

  private async sendCandidatePreview(ctx: TeleCtx): Promise<void> {
    const userId = this.requireUserId(ctx);
    const draft = await this.candidateOnboarding.getActiveDraft(userId);
    if (!draft) throw new AppError({ code: AppErrorCode.PROFILE_NOT_FOUND });
    ctx.session.candidateDraftVersion = draft.version;
    const T = this.T(ctx);

    const f = draft.fields;
    const lines: string[] = [T.CANDIDATE_ONBOARD.preview_title(), ''];
    lines.push(`• Target roles: ${f.targetRoles?.join(', ') || T.COMMON.notProvided()}`);
    lines.push(`• Skills: ${f.skills?.join(', ') || T.COMMON.notProvided()}`);
    lines.push(`• Industries: ${f.industries?.join(', ') || T.COMMON.notProvided()}`);
    if (f.locations?.length) lines.push(`• Locations: ${f.locations.join(', ')}`);
    if (f.salaryStatus && f.salaryStatus !== 'NOT_PROVIDED') {
      lines.push(`• Salary: ${f.salaryText || f.salaryStatus}`);
    }
    lines.push('');
    lines.push(T.CANDIDATE_ONBOARD.confirm_prompt());

    const kb = new InlineKeyboard()
      .text(T.CANDIDATE_ONBOARD.confirm(), 'cand_ob:confirm')
      .text(T.CANDIDATE_ONBOARD.edit(), 'cand_ob:edit');

    ctx.session.step = 'CANDIDATE_ONBOARD_CONFIRM';
    await ctx.reply(lines.join('\n'), { reply_markup: kb });
  }

  private async ensureIdentity(ctx: TeleCtx): Promise<{ userId: bigint }> {
    if (!ctx.from) throw new AppError({ code: AppErrorCode.AUTH_UNAUTHORIZED });
    if (!ctx.session.userId || !ctx.session.language) {
      const { user } = await this.userIdentity.upsertFromTelegram({
        telegramUserId: BigInt(ctx.from.id),
        telegramUsername: ctx.from.username ?? null,
        telegramFirstName: ctx.from.first_name ?? null,
        telegramLastName: ctx.from.last_name ?? null,
      });
      ctx.session.userId = String(user.id);
      ctx.session.language = user.language;
      ctx.session.preferredRole = user.preferredRole ?? undefined;
    }
    return { userId: BigInt(ctx.session.userId) };
  }

  private requireUserId(ctx: TeleCtx): bigint {
    const uid = ctx.session.userId;
    if (!uid) throw new AppError({ code: AppErrorCode.AUTH_UNAUTHORIZED });
    return BigInt(uid);
  }

  private T(ctx: TeleCtx): Translation {
    return pickT(ctx.session.language ?? 'en');
  }

  private async handleReplyError(ctx: TeleCtx, error: unknown): Promise<void> {
    if (error instanceof AppError) {
      this.logger.warn(`AppError code=${error.code}`);
    } else {
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error('Unexpected handler error', stack);
    }
    const T = this.T(ctx);
    const { text } = translateAppError(error, T);
    try {
      await ctx.reply(text);
    } catch {
      // ignore send failure
    }
  }

  private langKeyboard() {
    return new InlineKeyboard()
      .text('🇰🇭 ខ្មែរ', 'lang:km')
      .text('🇨🇳 中文', 'lang:zh_CN')
      .text('🇬🇧 English', 'lang:en');
  }

  private roleKeyboard(T: Translation) {
    return new InlineKeyboard()
      .text(T.ROLES.candidate(), 'role:CANDIDATE')
      .row()
      .text(T.ROLES.company(), 'role:COMPANY')
      .row()
      .text(T.ROLES.both(), 'role:BOTH');
  }
}

function splitCsv(raw: string): string[] {
  return raw
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
