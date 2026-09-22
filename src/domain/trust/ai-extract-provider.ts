// AI Provider abstraction defined in domain (infrastructure implements it).
// Stage-1 default: MockAIProvider. Real providers bound later; never leak SDK objects.

export type AIProviderId = 'ollama' | 'deepseek' | 'openai-compatible' | 'mock';

export interface AIExtractedCandidateDraft {
  source: 'ai';
  providerId: AIProviderId;
  extractedAt: Date;
  fields: {
    skills?: string[];
    industries?: string[];
    targetRoles?: string[];
    taskKeywords?: string[];
    locations?: string[];
    languages?: string[];
    salaryExpectation?: {
      status: 'provided' | 'not_provided' | 'negotiable';
      text?: string;
    };
  };
  warnings: string[];
  degraded: boolean;
}

export interface AIExtractedJobDraft {
  source: 'ai';
  providerId: AIProviderId;
  extractedAt: Date;
  fields: {
    title?: string;
    industry?: string;
    skills?: string[];
    tasks?: string[];
    locations?: string[];
    languages?: string[];
    shifts?: string[];
    salaryExpectation?: {
      status: 'provided' | 'not_provided' | 'negotiable';
      text?: string;
    };
  };
  warnings: string[];
  degraded: boolean;
}

export abstract class AIExtractProvider {
  abstract readonly providerId: AIProviderId;
  abstract extractCandidateDraft(raw: string): Promise<AIExtractedCandidateDraft>;
  abstract extractJobDraft(raw: string): Promise<AIExtractedJobDraft>;
}

export const AI_PROVIDER_TOKEN = Symbol('AI_PROVIDER_TOKEN');
