// Ollama provider —— always runs at HTTP endpoint (default http://localhost:11434).
// If the endpoint is unreachable or no model is specified, the methods return
// a degraded empty result rather than throwing. This keeps the pipeline always
// runnable even without AI.

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
export class OllamaAIProvider extends AIExtractProvider {
  readonly providerId: AIProviderId = 'ollama';

  constructor(@Inject(CLOCK_TOKEN) private readonly clock: Clock) {
    super();
  }

  private getEndpoint(): string {
    return APP_ENV.AI_OLLAMA_BASE_URL || 'http://localhost:11434';
  }

  private getModel(): string | null {
    return APP_ENV.AI_OLLAMA_MODEL || null;
  }

  /**
   * Stage-1 placeholder: no actual LLM calls are issued (to keep the pipeline
   * deterministic & free). Callers always get degraded=true with empty fields
   * + a warning telling them to enable networking calls later.
   *
   * To enable real Ollama in stage-2:
   *   - POST /api/generate at ${endpoint} with model=${model} and prompt=${raw}
   *   - parse JSON structured output into CandidateDraftFields
   *   - wrap in try/catch and return degraded=true on any network error.
   */
  extractCandidateDraft(_raw: string): Promise<AIExtractedCandidateDraft> {
    const model = this.getModel();
    return Promise.resolve({
      source: 'ai',
      providerId: 'ollama',
      extractedAt: this.clock.now(),
      fields: {},
      degraded: true,
      warnings: [
        model
          ? `Ollama model configured (${model}) but provider is in degraded/stub mode for stage-1 — using manual entry.`
          : 'Ollama provider is stub-only in stage-1. Set AI_OLLAMA_MODEL and enable provider for LLM extraction.',
      ],
    });
  }

  extractJobDraft(_raw: string): Promise<AIExtractedJobDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'ollama',
      extractedAt: this.clock.now(),
      fields: {},
      degraded: true,
      warnings: ['Ollama provider is stub-only in stage-1 — using manual entry.'],
    });
  }
}
