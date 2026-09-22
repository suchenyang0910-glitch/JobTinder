import { Injectable } from '@nestjs/common';
import {
  AIExtractProvider,
  type AIExtractedCandidateDraft,
  type AIExtractedJobDraft,
  type AIProviderId,
  type AILanguage,
  DEFAULT_CANDIDATE_FIELDS,
  DEFAULT_JOB_FIELDS,
} from '@src/domain/trust/ai-extract-provider';
import type { Clock } from '@src/shared/clock/clock';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import { Inject, Logger } from '@nestjs/common';

@Injectable()
export class MockAIProvider extends AIExtractProvider {
  readonly providerId: AIProviderId = 'mock';
  private readonly logger = new Logger(MockAIProvider.name);

  constructor(@Inject(CLOCK_TOKEN) private readonly clock: Clock) {
    super();
  }

  logStartupBanner(): void {
    this.logger.log('AI provider: mock');
  }

  extractCandidateDraft(_raw: string, _language: AILanguage): Promise<AIExtractedCandidateDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'mock',
      extractedAt: this.clock.now(),
      fields: { ...DEFAULT_CANDIDATE_FIELDS },
      confidence: {},
      unknownFields: [],
      warnings: [
        'Mock provider enabled. AI results always empty. You can still fill manually or switch providers.',
      ],
      degraded: true,
    });
  }

  extractJobDraft(_raw: string, _language: AILanguage): Promise<AIExtractedJobDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'mock',
      extractedAt: this.clock.now(),
      fields: { ...DEFAULT_JOB_FIELDS },
      confidence: {},
      unknownFields: [],
      warnings: ['Mock provider enabled. AI results always empty.'],
      degraded: true,
    });
  }
}
