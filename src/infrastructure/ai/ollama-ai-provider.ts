// Ollama provider. In stage-2 this issues a real POST /api/chat at
// $AI_OLLAMA_BASE_URL with model=$AI_OLLAMA_MODEL. In stage-1 (the safe default)
// it returns a degraded empty result so manual onboarding stays available.

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
export class OllamaAIProvider extends AIExtractProvider {
  readonly providerId: AIProviderId = 'ollama';
  private readonly logger = new Logger(OllamaAIProvider.name);

  constructor(@Inject(CLOCK_TOKEN) private readonly clock: Clock) {
    super();
  }

  private getEndpoint(): string {
    return APP_ENV.AI_OLLAMA_BASE_URL || 'http://localhost:11434';
  }

  private getModel(): string | null {
    return APP_ENV.AI_OLLAMA_MODEL || null;
  }

  logStartupBanner(): void {
    const model = this.getModel();
    this.logger.log(
      `AI provider: ollama | endpoint=${this.getEndpoint()} model=${model ?? '<not set, degraded>'}`,
    );
  }

  extractCandidateDraft(_raw: string, _language: AILanguage): Promise<AIExtractedCandidateDraft> {
    const model = this.getModel();
    return Promise.resolve({
      source: 'ai',
      providerId: 'ollama',
      extractedAt: this.clock.now(),
      fields: { ...DEFAULT_CANDIDATE_FIELDS },
      confidence: {},
      unknownFields: [],
      warnings: [
        model
          ? `Ollama model configured (${model}) but stage-1 provider is degraded — use manual entry or switch AI provider.`
          : 'Ollama: AI_OLLAMA_MODEL not set — using degraded result, please fill manually.',
      ],
      degraded: true,
    });
  }

  extractJobDraft(_raw: string, _language: AILanguage): Promise<AIExtractedJobDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'ollama',
      extractedAt: this.clock.now(),
      fields: { ...DEFAULT_JOB_FIELDS },
      confidence: {},
      unknownFields: [],
      warnings: ['Ollama stage-1 provider is degraded — use manual entry.'],
      degraded: true,
    });
  }
}
