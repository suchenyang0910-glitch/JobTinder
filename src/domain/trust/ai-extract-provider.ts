// AI Provider abstraction defined in domain (infrastructure implements it).
// The provider must never hallucinate: when uncertain, return null/[] + populate
// the unknownFields list. Callers always confirm results with the end user
// before writing to any confirmed (matchable) state.

export type AIProviderId = 'ollama' | 'deepseek' | 'openai-compatible' | 'mock';

export type SalaryStatus = 'PROVIDED' | 'NOT_PROVIDED' | 'NEGOTIABLE';

export interface CandidateExperienceItem {
  company?: string;
  role?: string;
  durationMonths?: number;
  note?: string;
}

export interface CandidateCertificationItem {
  name: string;
  issuer?: string;
  year?: number;
}

export interface ExtractedCandidateFields {
  targetRoles: string[];
  skills: string[];
  industries: string[];
  taskKeywords: string[];
  locations: string[];
  languagesKnown: string[];
  salaryStatus: SalaryStatus;
  salaryText: string | null;
  availabilityNote: string | null;
  workExperience: CandidateExperienceItem[];
  certifications: CandidateCertificationItem[];
}

export interface AIExtractedCandidateDraft {
  source: 'ai';
  providerId: AIProviderId;
  extractedAt: Date;
  fields: ExtractedCandidateFields;
  confidence: Record<string, number>;
  unknownFields: string[];
  warnings: string[];
  degraded: boolean;
}

export interface ExtractedJobFields {
  title: string | null;
  tasks: string[];
  skills: string[];
  industry: string | null;
  locations: string[];
  languagesRequired: string[];
  shifts: string[];
  salaryStatus: SalaryStatus;
  salaryText: string | null;
  availabilityStart: string | null;
  housingProvided: boolean | null;
  mealsProvided: boolean | null;
  transportProvided: boolean | null;
  workPermitRequired: boolean | null;
  headcount: number | null;
}

export interface AIExtractedJobDraft {
  source: 'ai';
  providerId: AIProviderId;
  extractedAt: Date;
  fields: ExtractedJobFields;
  confidence: Record<string, number>;
  unknownFields: string[];
  warnings: string[];
  degraded: boolean;
}

export type AILanguage = 'en' | 'zh_CN' | 'km';

export interface RawPromptOptions {
  system?: string;
  temperature?: number;
  responseFormat?: 'json_object' | 'text';
  timeoutMs?: number;
}

export abstract class AIExtractProvider {
  abstract readonly providerId: AIProviderId;
  abstract extractCandidateDraft(
    raw: string,
    language: AILanguage,
  ): Promise<AIExtractedCandidateDraft>;
  abstract extractJobDraft(raw: string, language: AILanguage): Promise<AIExtractedJobDraft>;
  abstract callRawPrompt(userMessage: string, opts?: RawPromptOptions): Promise<string>;
  getModelLabel?(): string | null;
  logStartupBanner?(logger: { log: (m: string) => void }): void;
}

export const AI_PROVIDER_TOKEN = Symbol('AI_PROVIDER_TOKEN');

export const DEFAULT_CANDIDATE_FIELDS: ExtractedCandidateFields = {
  targetRoles: [],
  skills: [],
  industries: [],
  taskKeywords: [],
  locations: [],
  languagesKnown: [],
  salaryStatus: 'NOT_PROVIDED',
  salaryText: null,
  availabilityNote: null,
  workExperience: [],
  certifications: [],
};

export const DEFAULT_JOB_FIELDS: ExtractedJobFields = {
  title: null,
  tasks: [],
  skills: [],
  industry: null,
  locations: [],
  languagesRequired: [],
  shifts: [],
  salaryStatus: 'NOT_PROVIDED',
  salaryText: null,
  availabilityStart: null,
  housingProvided: null,
  mealsProvided: null,
  transportProvided: null,
  workPermitRequired: null,
  headcount: null,
};
