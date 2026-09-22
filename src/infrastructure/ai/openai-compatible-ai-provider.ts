// OpenAI-compatible provider — shareable between OpenAI, anyscale, groq, etc.
// Stage-1: degraded stub only. Stage-2 will issue real requests to
// $AI_OPENAI_BASE_URL/v1/chat/completions with Bearer $AI_OPENAI_API_KEY.

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AIExtractProvider,
  type AIExtractedCandidateDraft,
  type AIExtractedJobDraft,
  type AIProviderId,
  type AILanguage,
  DEFAULT_CANDIDATE_FIELDS,
  DEFAULT_JOB_FIELDS,
} from '@src/domain/trust/ai-extract-provider';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import type { Clock } from '@src/shared/clock/clock';
import { APP_ENV } from '@src/shared/env/app-env';

@Injectable()
export class OpenAICompatibleAIProvider extends AIExtractProvider {
  readonly providerId: AIProviderId = 'openai-compatible';
  private readonly logger = new Logger(OpenAICompatibleAIProvider.name);

  constructor(@Inject(CLOCK_TOKEN) private readonly clock: Clock) {
    super();
  }

  logStartupBanner(): void {
    const base = APP_ENV.AI_OPENAI_COMPATIBLE_BASE_URL || '<not set>';
    const key = APP_ENV.AI_OPENAI_COMPATIBLE_API_KEY;
    const keyState = key
      ? `fingerprint=${key.slice(0, 3)}...${key.slice(-4)}`
      : 'key not configured';
    this.logger.log(`AI provider: openai-compatible | base=${base} | ${keyState}`);
  }

  extractCandidateDraft(_raw: string, _language: AILanguage): Promise<AIExtractedCandidateDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'openai-compatible',
      extractedAt: this.clock.now(),
      fields: { ...DEFAULT_CANDIDATE_FIELDS },
      confidence: {},
      unknownFields: [],
      warnings: [
        'OpenAI-compatible provider is in stage-1 degraded mode — use manual entry or switch providers.',
      ],
      degraded: true,
    });
  }

  extractJobDraft(_raw: string, _language: AILanguage): Promise<AIExtractedJobDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'openai-compatible',
      extractedAt: this.clock.now(),
      fields: { ...DEFAULT_JOB_FIELDS },
      confidence: {},
      unknownFields: [],
      warnings: ['OpenAI-compatible provider is in stage-1 degraded mode.'],
      degraded: true,
    });
  }

  getModelLabel(): string | null {
    return APP_ENV.AI_OPENAI_COMPATIBLE_MODEL || null;
  }

  async callRawPrompt(
    userMessage: string,
    opts?: {
      temperature?: number;
      responseFormat?: 'json_object' | 'text';
      timeoutMs?: number;
      system?: string;
    },
  ): Promise<string> {
    void opts;
    void userMessage;
    throw new Error('OpenAI-compatible callRawPrompt not implemented in stage-1');
  }
}
