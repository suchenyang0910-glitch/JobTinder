// DeepSeek provider stub. Real implementation uses /chat/completions on
// https://api.deepseek.com with DeepSeek-API-Key header. Stage-1: degraded stub.

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
export class DeepSeekAIProvider extends AIExtractProvider {
  readonly providerId: AIProviderId = 'deepseek';

  constructor(@Inject(CLOCK_TOKEN) private readonly clock: Clock) {
    super();
  }

  private hasKey(): boolean {
    return !!APP_ENV.AI_DEEPSEEK_API_KEY && APP_ENV.AI_DEEPSEEK_API_KEY.length > 8;
  }

  extractCandidateDraft(_raw: string): Promise<AIExtractedCandidateDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'deepseek',
      extractedAt: this.clock.now(),
      fields: {},
      degraded: true,
      warnings: this.hasKey()
        ? ['DeepSeek API key configured. Stage-1 provider is degraded/stub — manual entry used.']
        : ['DeepSeek provider is disabled (no API key). AI_OLLAMA_FALLBACK=mock activated.'],
    });
  }

  extractJobDraft(_raw: string): Promise<AIExtractedJobDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'deepseek',
      extractedAt: this.clock.now(),
      fields: {},
      degraded: true,
      warnings: ['DeepSeek provider is stub-only in stage-1.'],
    });
  }
}
