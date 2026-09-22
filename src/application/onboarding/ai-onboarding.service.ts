// AI onboarding application service.
//
// Responsibilities:
//  1. Invoke the pluggable AIExtractProvider (mock / ollama / deepseek / openai)
//     with user-supplied free-form text.
//  2. Map the extracted result onto CandidateDraftFields for
//     CandidateOnboardingService.createDraft() — so we never write to
//     candidate_profiles directly; the existing versioning, optimistic locks,
//     audit events and outbox messages all apply unchanged.
//  3. Write field_sources = {<field>: { source: 'ai', confirmed: false }} for
//     every single field that came from the AI, as required by the PRD.
//  4. Idempotency: if the user already has an ACTIVE DRAFT created by the
//     SAME provider from the SAME raw text (normalised + hashed) we update
//     that draft rather than creating a new one — so repeated sends from a
//     user do not spawn multiple draft rows.
//
// CRITICAL INVARIANTS (per PRD §VII / §XIII):
//  - NEVER confirm a profile here. The draft is always DRAFT.
//  - degraded=true results still result in a DRAFT (not a no-op); the
//    downstream Telegram handler offers manual fallback.
//  - Confidence is NEVER written to the DB; only the adapter layer may use
//    it to decide the "needs confirmation" flag presentation.

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_PROVIDER_TOKEN,
  AIExtractProvider,
  type AILanguage,
  type AIExtractedCandidateDraft,
  type AIExtractedJobDraft,
  type AIProviderId,
} from '@src/domain/trust/ai-extract-provider';
import type { CandidateDraftFields } from '@src/domain/profiles/candidate-profile-domain';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import type { Clock } from '@src/shared/clock/clock';
import { createHash } from 'node:crypto';
import { CandidateOnboardingService } from './candidate-onboarding.service';

export type SourceKind = 'ai' | 'manual' | 'mock';

export interface FieldSourceMeta {
  source: SourceKind;
  confirmed: boolean;
}

export type FieldSourcesRecord = Record<string, FieldSourceMeta>;

const CANDIDATE_AI_FIELD_MAP: Array<keyof CandidateDraftFields> = [
  'targetRoles',
  'skills',
  'industries',
  'taskKeywords',
  'locations',
  'languagesKnown',
  'salaryStatus',
  'salaryText',
  'availabilityNote',
];

@Injectable()
export class AIOnboardingService {
  private readonly logger = new Logger(AIOnboardingService.name);

  constructor(
    @Inject(AI_PROVIDER_TOKEN) private readonly provider: AIExtractProvider,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    private readonly candidate: CandidateOnboardingService,
  ) {}

  private static contentHash(raw: string): string {
    const cleaned = raw.trim().replace(/\s+/g, ' ').slice(0, 8192);
    return createHash('sha1').update(cleaned).digest('base64url').slice(0, 12);
  }

  get providerId(): AIProviderId {
    return this.provider.providerId;
  }

  logStartupBanner(): void {
    const any = this.provider as unknown as { logStartupBanner?: () => void };
    if (typeof any.logStartupBanner === 'function') {
      any.logStartupBanner();
    } else {
      this.logger.log(`AI provider: ${this.provider.providerId} (banner not implemented)`);
    }
  }

  /**
   * Extract + write a candidate DRAFT from free-form text.
   * Returns the draft id/version that the adapter should anchor its state to,
   * plus the unknownFields + warnings from the provider (used for the "needs
   * confirmation" UI card). NEVER returns a CONFIRMED profile.
   */
  async createOrUpdateCandidateDraftFromAI(params: {
    userId: bigint;
    rawText: string;
    language: AILanguage;
  }): Promise<{
    draftId: bigint;
    draftVersion: number;
    degraded: boolean;
    unknownFields: string[];
    warnings: string[];
    hadActiveDraft: boolean;
    source: AIProviderId;
  }> {
    const { userId, rawText, language } = params;
    const extracted: AIExtractedCandidateDraft = await this.provider.extractCandidateDraft(
      rawText,
      language,
    );

    const fieldSources: FieldSourcesRecord = {};
    const kind: SourceKind = extracted.providerId === 'mock' ? 'mock' : 'ai';
    for (const f of CANDIDATE_AI_FIELD_MAP) {
      fieldSources[f] = { source: kind, confirmed: false };
    }

    const mapped: CandidateDraftFields = this.mapCandidateFields(extracted, fieldSources);
    const draftSource = kind;
    const aiProviderId: AIProviderId = extracted.providerId;

    const activeDraft = await this.candidate.getActiveDraft(userId);
    const hash = AIOnboardingService.contentHash(rawText);

    if (
      activeDraft &&
      activeDraft.aiContentHash === hash &&
      activeDraft.aiProviderId === aiProviderId
    ) {
      // Same user, same normalised text, same provider — idempotently reuse.
      this.logger.debug(
        `AI idempotent reuse: userId=${String(userId)} draft=${String(activeDraft.id)} hash=${hash}`,
      );
      return {
        draftId: activeDraft.id,
        draftVersion: activeDraft.version,
        degraded: extracted.degraded,
        unknownFields: extracted.unknownFields,
        warnings: extracted.warnings,
        hadActiveDraft: true,
        source: aiProviderId,
      };
    }

    const created = await this.candidate.createDraft({
      userId,
      source: draftSource,
      initialFields: mapped,
      initialFieldSources: fieldSources,
      aiProviderId,
      aiContentHash: hash,
      aiExtractedAt: extracted.extractedAt,
    });

    return {
      draftId: created.id,
      draftVersion: created.version,
      degraded: extracted.degraded,
      unknownFields: extracted.unknownFields,
      warnings: extracted.warnings,
      hadActiveDraft: !!activeDraft,
      source: aiProviderId,
    };
  }

  /**
   * Extract only — used for company job AI previews where we might not
   * have a draft row yet. Does NOT touch the database. Idempotent.
   */
  async extractJobDraftOnly(raw: string, language: AILanguage): Promise<AIExtractedJobDraft> {
    return this.provider.extractJobDraft(raw, language);
  }

  private mapCandidateFields(
    ex: AIExtractedCandidateDraft,
    _sources: FieldSourcesRecord,
  ): CandidateDraftFields {
    return {
      targetRoles: [...ex.fields.targetRoles],
      skills: [...ex.fields.skills],
      industries: [...ex.fields.industries],
      taskKeywords: [...ex.fields.taskKeywords],
      locations: [...ex.fields.locations],
      languagesKnown: [...ex.fields.languagesKnown],
      salaryStatus: ex.fields.salaryStatus,
      salaryText: ex.fields.salaryText ?? undefined,
      availabilityNote: ex.fields.availabilityNote ?? undefined,
    };
  }
}
