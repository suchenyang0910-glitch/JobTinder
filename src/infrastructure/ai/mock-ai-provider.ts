import { Injectable } from '@nestjs/common';
import {
  AIExtractProvider,
  type AIExtractedCandidateDraft,
  type AIExtractedJobDraft,
  type AIProviderId,
} from '@src/domain/trust/ai-extract-provider';
import type { Clock } from '@src/shared/clock/clock';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import { Inject } from '@nestjs/common';

/**
 * MockAIProvider - default for stage-1.
 * Produces empty (degraded) drafts so manual-flow stays available.
 * Never talks to network. Always succeeds (no AI_UNAVAILABLE).
 */
@Injectable()
export class MockAIProvider extends AIExtractProvider {
  readonly providerId: AIProviderId = 'mock';

  constructor(@Inject(CLOCK_TOKEN) private readonly clock: Clock) {
    super();
  }

  extractCandidateDraft(_raw: string): Promise<AIExtractedCandidateDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'mock',
      extractedAt: this.clock.now(),
      fields: {},
      warnings: ['Mock provider enabled. Please enter fields manually.'],
      degraded: true,
    });
  }

  extractJobDraft(_raw: string): Promise<AIExtractedJobDraft> {
    return Promise.resolve({
      source: 'ai',
      providerId: 'mock',
      extractedAt: this.clock.now(),
      fields: {},
      warnings: ['Mock provider enabled. Please enter fields manually.'],
      degraded: true,
    });
  }
}
