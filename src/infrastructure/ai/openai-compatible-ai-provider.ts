// OpenAI-compatible provider (works against any /v1/chat/completions endpoint
// that accepts Bearer tokens, including Groq, Together, xAI, local vLLM, etc.).
// Stage-1: degraded stub only.

import { Inject, Injectable } from '@nestjs/common';
import {
  AIExtractProvider,
  type AIExtractedCandidateDraft,
  type AIExtractedJobDraft,
  type AIProviderId,
} from '@src/domain/trust/ai-extract-provider';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import type { Clock } from '@src/shared/clock/clock';
import { APP_ENV } from '@src/shared/env/app-env';

@Injectable()
export class OpenAICompatibleAIProvider extends AIExtractProvider {
  readonly providerId: AIProviderId = 'openai-compatible';

  constructor(@Inject(CLOCK_TOKEN) private readonly clock: Clock) {
    super();
  }

  private getEndpoint(): string {
    return APP_ENV.AI_OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1';
  }

  private hasKey(): boolean {
    return (
      !!APP_ENV.AI_OPENAI_COMPATIBLE_API_KEY && APP_ENV.AI_OPENAI_COMPATIBLE_API_KEY.length > 8
    );
  }

  extractCandidateDraft(_raw: string): Promise<AIExtractedCandidateDraft> {
    const endpoint = this.getEndpoint();
    return Promise.resolve({
      source: 'ai',
      providerId: 'openai-compatible',
      extractedAt: this.clock.now(),
      fields: {},
      degraded: true,
      warnings: this.hasKey()
        ? [
            `OpenAI-compat endpoint=${endpoint} configured. Stage-1 stub provider — using manual entry.`,
          ]
        : ['OpenAI-compat provider disabled (no API key).'],
    });
  }

  extractJobDraft(_raw: string): Promise<AIExtractedJobDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'openai-compatible',
      extractedAt: this.clock.now(),
      fields: {},
      degraded: true,
      warnings: ['OpenAI-compat provider is stub-only in stage-1.'],
    });
  }
}
