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
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { translateAppError } from './error-translator';
import { pickT } from '@src/shared/i18n';
import type { Translation } from '@src/shared/i18n/locales/en';
import {
  isProfileReadyToConfirm,
  type CandidateDraftFields,
} from '@src/domain/profiles/candidate-profile-domain';

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
  ) {}

  onModuleInit() {
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
    const { userId } = await this.ensureIdentity(ctx);
    const T = this.T(ctx);

    const confirmed = await this.candidateOnboarding.getLatestConfirmed(userId);
    const draft = await this.candidateOnboarding.getActiveDraft(userId);
    const existing = draft ?? confirmed;

    let draftId: string;
    if (draft) {
      ctx.session.candidateDraftVersion = draft.version;
      draftId = String(draft.id);
    } else if (confirmed) {
      const cloned = await this.candidateOnboarding.createDraft({
        userId,
        source: 'manual',
        initialFields: confirmed.fields,
      });
      ctx.session.candidateDraftVersion = cloned.version;
      draftId = String(cloned.id);
    } else {
      const created = await this.candidateOnboarding.createDraft({
        userId,
        source: 'manual',
      });
      ctx.session.candidateDraftVersion = created.version;
      draftId = String(created.id);
    }

    ctx.session.candidateDraftId = draftId;
    ctx.session.step = 'CANDIDATE_ONBOARD_ASK_ROLES';
    await ctx.reply(T.CANDIDATE_ONBOARD.intro());
    await ctx.reply(T.CANDIDATE_ONBOARD.askTargetRoles());
    void existing;
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
    const latest = await this.companyOnboarding.getLatest(userId);
    const draft =
      latest ?? (await this.companyOnboarding.createDraft({ userId, source: 'manual' }));
    const T = this.T(ctx);
    const f = draft.fields;
    const lines: string[] = [
      '🏢 Company profile (stage-1 skeleton, stage-2 will add edit wizard)',
      `Verification: ${draft.verificationStatus}`,
      `Ownership: ${draft.isOwner ? '✅ Owner (companies_members.is_owner=true)' : 'Member'}`,
      '',
      `• Name: ${f.name ?? T.COMMON.notProvided()}`,
      `• Industry: ${f.industry ?? T.COMMON.notProvided()}`,
      `• Size: ${f.size ?? T.COMMON.notProvided()}`,
      `• Location: ${f.location ?? T.COMMON.notProvided()}`,
      `• Website: ${f.website ?? T.COMMON.notProvided()}`,
      `• Recruiter: ${f.recruiterName ?? T.COMMON.notProvided()} (${f.recruiterRole ?? '-'})`,
    ];
    await ctx.reply(lines.join('\n'));
  }

  private async handleTextMessage(ctx: TeleCtx) {
    const step = ctx.session.step;
    const rawText = ctx.message?.text ?? '';
    const text = rawText.trim();
    if (!text) return;
    const T = this.T(ctx);

    switch (step) {
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
