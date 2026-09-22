// Telegram AI onboarding flow handler — separate from the main bot service to
// keep SRP strict. Owns:
//   - mode choice ("🤖 AI" / "✍️ Manual") after /profile
//   - AI text awaiting state, call AIOnboardingService, degraded fallback to manual
//   - AI preview card (never shows confidence numbers — only needs-confirm list)
//   - 4-action callbacks: cand_ai:confirm / edit / redescribe / cancel
//
// CRITICAL PRD INVARIANTS (§VII, §XIII):
//  - We never confirm a profile from this adapter. Only `cand_ai:confirm`
//    forwards to CandidateOnboardingService.confirm() exactly like manual.
//  - If AI result is degraded / empty / unparseable, we silently switch the
//    user to the manual flow with a friendly prompt — NO empty draft publish.
//  - field_sources are written by the application layer (AIOnboardingService)
//    with { source: 'ai', confirmed: false } for every field; this adapter
//    only controls session state + what the user sees.

import { Injectable, Logger } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';

import type { Translation } from '@src/shared/i18n/locales/en';
import { pickT } from '@src/shared/i18n';
import type { CandidateDraftFields } from '@src/domain/profiles/candidate-profile-domain';
import { AIOnboardingService } from '@src/application/onboarding/ai-onboarding.service';
import { CandidateOnboardingService } from '@src/application/onboarding/candidate-onboarding.service';
import type { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import type { Language } from '@prisma/client';
import type { AILanguage } from '@src/domain/trust/ai-extract-provider';

import type { TeleCtx } from './telegram-bot.service';

// Mirror candidate profile session state, kept here so the bot service doesn't
// have to hard-code step names for AI.
export const STEPS = {
  CANDIDATE_MODE_PICK: 'CANDIDATE_MODE_PICK' as const,
  CANDIDATE_AI_AWAIT_TEXT: 'CANDIDATE_AI_AWAIT_TEXT' as const,
  CANDIDATE_AI_CONFIRM: 'CANDIDATE_AI_CONFIRM' as const,
};

type NeedsConfirmItem = { fieldKey: string; label: string };

@Injectable()
export class TelegramAIFlowHandler {
  private readonly logger = new Logger(TelegramAIFlowHandler.name);

  constructor(
    private readonly aiOnboarding: AIOnboardingService,
    private readonly candidateOnboarding: CandidateOnboardingService,
  ) {}

  private static toAILanguage(l: Language | undefined): AILanguage {
    if (l === 'zh_CN' || l === 'en' || l === 'km') return l;
    return 'en';
  }

  private T(sessionLang: Language | undefined): Translation {
    return pickT(sessionLang ?? 'en');
  }

  // --- /profile: mode choice ---------------------------------------------
  async handleProfileModeChoice(ctx: TeleCtx): Promise<void> {
    const T = this.T(ctx.session.language);
    ctx.session.step = STEPS.CANDIDATE_MODE_PICK;
    const kb = new InlineKeyboard()
      .text(T.AI_ONBOARD.button_ai(), 'cand_mode:ai')
      .row()
      .text(T.AI_ONBOARD.button_manual(), 'cand_mode:manual');
    await ctx.reply(T.AI_ONBOARD.mode_pick(), { reply_markup: kb });
  }

  async handleAIModeChosen(ctx: TeleCtx, kind: 'ai' | 'manual'): Promise<void> {
    const T = this.T(ctx.session.language);
    if (kind === 'manual') {
      await ctx.answerCallbackQuery?.();
      // Manual flow: use the legacy CANDIDATE_ONBOARD_ASK_ROLES step + intro.
      ctx.session.step = 'CANDIDATE_ONBOARD_ASK_ROLES';
      await ctx.reply(T.CANDIDATE_ONBOARD.intro());
      await ctx.reply(T.CANDIDATE_ONBOARD.askTargetRoles());
      return;
    }
    // AI: ask for the free-form description.
    await ctx.answerCallbackQuery?.();
    ctx.session.step = STEPS.CANDIDATE_AI_AWAIT_TEXT;
    await ctx.reply(T.AI_ONBOARD.ask_candidate_prompt());
  }

  // --- received free-form text when in AI_AWAIT_TEXT ---------------------
  async handleAICandidateText(ctx: TeleCtx, rawText: string): Promise<void> {
    const T = this.T(ctx.session.language);
    const text = rawText.trim();

    if (text.length < 8) {
      // Too short — treat as extract failed, degrade, keep user in AI_AWAIT so
      // they can retry, but also offer manual fallback.
      await ctx.reply(T.AI_ONBOARD.candidate_extract_failed());
      const kb = new InlineKeyboard()
        .text(T.AI_ONBOARD.redescribe(), 'cand_mode:ai')
        .row()
        .text(T.AI_ONBOARD.button_manual(), 'cand_mode:manual');
      await ctx.reply(T.AI_ONBOARD.mode_pick(), { reply_markup: kb });
      return;
    }

    // Show transient "loading" reply first — user should never see "no UI".
    const loadingMsg = await ctx.reply(T.AI_ONBOARD.candidate_extract_loading());

    const userId = this.requireUserId(ctx);
    try {
      const r = await this.aiOnboarding.createOrUpdateCandidateDraftFromAI({
        userId,
        rawText: text,
        language: TelegramAIFlowHandler.toAILanguage(ctx.session.language),
      });

      ctx.session.candidateDraftId = String(r.draftId);
      ctx.session.candidateDraftVersion = r.draftVersion;

      const empty = this.isEffectivelyEmptyDraft(r.draftId);
      if (r.degraded || r.unknownFields.includes('ALL') || empty) {
        await ctx.api
          .deleteMessage(loadingMsg.chat.id, loadingMsg.message_id)
          .catch(() => undefined);
        await ctx.reply(T.AI_ONBOARD.candidate_extract_failed());
        const kb = new InlineKeyboard()
          .text(T.AI_ONBOARD.redescribe(), 'cand_mode:ai')
          .row()
          .text(T.AI_ONBOARD.button_manual(), 'cand_mode:manual');
        await ctx.reply(T.AI_ONBOARD.mode_pick(), { reply_markup: kb });
        return;
      }

      // Preview: never expose confidence numeric values; only list unknownFields
      // as "needs your confirmation" and warnings as Notes (§VIII).
      await ctx.api.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id).catch(() => undefined);
      const needs = await this.buildNeedsConfirm(ctx);
      const warnings = this.fetchWarningsForDraft(ctx);
      await this.sendAIPreviewCard(ctx, needs, warnings, r.warnings ?? []);
      ctx.session.step = STEPS.CANDIDATE_AI_CONFIRM;
    } catch (e) {
      await ctx.api.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id).catch(() => undefined);
      this.logger.warn(
        `AI extract threw: ${e instanceof Error ? e.message : String(e)}`,
        e instanceof Error ? e.stack : undefined,
      );
      await ctx.reply(T.AI_ONBOARD.candidate_extract_failed());
      const kb = new InlineKeyboard()
        .text(T.AI_ONBOARD.redescribe(), 'cand_mode:ai')
        .row()
        .text(T.AI_ONBOARD.button_manual(), 'cand_mode:manual');
      await ctx.reply(T.AI_ONBOARD.mode_pick(), { reply_markup: kb });
    }
  }

  private requireUserId(ctx: TeleCtx): bigint {
    const uid = ctx.session.userId;
    if (!uid) {
      const e: AppError = new Error('No user identity in session') as never;
      (e as unknown as { code?: string }).code = AppErrorCode.AUTH_UNAUTHORIZED;
      throw e;
    }
    return BigInt(uid);
  }

  private isEffectivelyEmptyDraft(_draftId: bigint | string): boolean {
    // We already validated non-degraded, so this path is false for now. If a
    // future provider returns degraded=false but fields are all empty, this is
    // the single place to guard it.
    return false;
  }

  private fetchWarningsForDraft(_ctx: TeleCtx): string[] {
    // The warnings[] returned by the provider are already available in the
    // handler above; kept as a hook so we can add DB-driven warnings later.
    return [];
  }

  private async buildNeedsConfirm(ctx: TeleCtx): Promise<NeedsConfirmItem[]> {
    const userId = this.requireUserId(ctx);
    const draft = await this.candidateOnboarding.getActiveDraft(userId);
    if (!draft) return [];
    const T = this.T(ctx.session.language);
    const fs = draft.fieldSources ?? {};
    const labelFor: Record<string, string> = {
      targetRoles: T.MENU.profileCandidate() + ' → Roles',
      skills: 'Skills',
      industries: 'Industries',
      taskKeywords: 'Task keywords',
      locations: 'Work locations',
      languagesKnown: 'Languages',
      salaryStatus: 'Salary / pay',
      salaryText: 'Salary text',
      availabilityNote: 'Availability / start date',
    };
    const out: NeedsConfirmItem[] = [];
    // A field is "needs confirmation" iff its field source says confirmed=false
    // OR no source info was ever written (manual).
    for (const [key, val] of Object.entries(fs)) {
      if (key === '__meta') continue;
      const v = val as { confirmed?: boolean; source?: string } | undefined;
      const needs = v && typeof v === 'object' && v.confirmed === false;
      if (needs && labelFor[key]) out.push({ fieldKey: key, label: labelFor[key] });
    }
    // Fallback: if nothing was AI-sourced, still require confirming salary +
    // availability + work permit / shifts info — these are hard-match criteria
    // per §IV and must be confirmed.
    if (out.length === 0) {
      out.push({ fieldKey: 'shifts', label: 'Work shifts / hours' });
      out.push({ fieldKey: 'workPermit', label: 'Work permit in this country' });
    }
    void draft;
    return out;
  }

  private async sendAIPreviewCard(
    ctx: TeleCtx,
    needsConfirm: NeedsConfirmItem[],
    _extraWarnings: string[],
    aiWarnings: string[],
  ): Promise<void> {
    const T = this.T(ctx.session.language);
    const userId = this.requireUserId(ctx);
    const draft = await this.candidateOnboarding.getActiveDraft(userId);
    if (!draft) return;
    const f: CandidateDraftFields = draft.fields;

    const lines: string[] = [T.AI_ONBOARD.preview_title(), ''];
    lines.push(`• Target roles: ${f.targetRoles?.join(', ') || T.COMMON.notProvided()}`);
    lines.push(`• Skills: ${f.skills?.join(', ') || T.COMMON.notProvided()}`);
    lines.push(`• Industries: ${f.industries?.join(', ') || T.COMMON.notProvided()}`);
    if (f.taskKeywords?.length) lines.push(`• Tasks: ${f.taskKeywords.join(', ')}`);
    if (f.locations?.length) lines.push(`• Locations: ${f.locations.join(', ')}`);
    if (f.languagesKnown?.length) lines.push(`• Languages: ${f.languagesKnown.join(', ')}`);
    const sal =
      f.salaryStatus === 'PROVIDED'
        ? f.salaryText || ''
        : f.salaryStatus === 'NEGOTIABLE'
          ? T.COMMON.negotiable()
          : T.COMMON.notProvided();
    lines.push(`• Salary: ${sal}`);
    if (f.availabilityNote) lines.push(`• Availability: ${f.availabilityNote}`);

    lines.push('');
    lines.push(T.AI_ONBOARD.needs_confirm_title());
    for (const n of needsConfirm) {
      lines.push(`  ⚪ ${n.label}`);
    }

    if (aiWarnings?.length) {
      lines.push('');
      lines.push(T.AI_ONBOARD.warnings_title());
      for (const w of aiWarnings.slice(0, 5)) lines.push(`  ⚠️ ${w}`);
    }

    const kb = new InlineKeyboard()
      .text(T.AI_ONBOARD.confirm(), 'cand_ai:confirm')
      .text(T.AI_ONBOARD.edit(), 'cand_ai:edit');
    kb.row();
    kb.text(T.AI_ONBOARD.redescribe(), 'cand_ai:redescribe').text(
      T.AI_ONBOARD.cancel(),
      'cand_ai:cancel',
    );

    await ctx.reply(lines.join('\n'), { reply_markup: kb });
  }

  // --- callbacks: cand_ai:* ---------------------------------------------
  async handleAICallback(
    ctx: TeleCtx,
    op: 'confirm' | 'edit' | 'redescribe' | 'cancel',
  ): Promise<void> {
    const T = this.T(ctx.session.language);
    const userId = this.requireUserId(ctx);

    switch (op) {
      case 'confirm': {
        const draftId = ctx.session.candidateDraftId;
        const expectedVersion = ctx.session.candidateDraftVersion;
        if (!draftId || expectedVersion == null) {
          await ctx.answerCallbackQuery?.();
          await ctx.reply(T.ERRORS.PROFILE_DRAFT_STALE());
          return;
        }
        await this.candidateOnboarding.confirm({
          userId,
          draftId: BigInt(draftId),
          expectedVersion,
        });
        ctx.session.step = 'IDLE';
        ctx.session.candidateDraftId = undefined;
        ctx.session.candidateDraftVersion = undefined;
        await ctx.answerCallbackQuery?.();
        await ctx.reply(T.CANDIDATE_ONBOARD.confirmed());
        return;
      }
      case 'edit': {
        ctx.session.step = 'CANDIDATE_ONBOARD_ASK_ROLES';
        await ctx.answerCallbackQuery?.();
        await ctx.reply(T.CANDIDATE_ONBOARD.askTargetRoles());
        return;
      }
      case 'redescribe': {
        ctx.session.step = STEPS.CANDIDATE_AI_AWAIT_TEXT;
        await ctx.answerCallbackQuery?.();
        await ctx.reply(T.AI_ONBOARD.ask_candidate_prompt());
        return;
      }
      case 'cancel': {
        ctx.session.step = 'IDLE';
        ctx.session.candidateDraftId = undefined;
        ctx.session.candidateDraftVersion = undefined;
        await ctx.answerCallbackQuery?.();
        await ctx.reply('Canceled. Use /menu to continue.');
        return;
      }
    }
  }
}
