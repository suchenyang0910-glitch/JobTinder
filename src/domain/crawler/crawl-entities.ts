import type { Language } from '@prisma/client';

export type DetectedLanguage = 'km' | 'en' | 'zh_CN' | 'unknown';

export interface ParsedStagingJobFields {
  title: string | null;
  tasks: string[];
  skills: string[];
  industry: string | null;
  locations: string[];
  salaryText: string | null;
  shifts: string[];
  benefits: string[];
  headcount: number | null;
  workPermitRequired: boolean | null;
  availability: string | null;
  applyMethod: string | null;
}

export interface TranslatedJobFields {
  title: string;
  tasks: string[];
  skills: string[];
  industry: string | null;
  locations: string[];
  salaryText: string | null;
  shifts: string[];
  benefits: string[];
  warnings: string[];
}

export interface TranslationOutput {
  language: Language;
  fields: TranslatedJobFields;
  provider: string;
  model: string | null;
  version: string;
}

export interface QAResult {
  passed: boolean;
  flags: string[];
  requiresReview: boolean;
  structuralIssues: string[];
  consistencyIssues: string[];
  riskIssues: string[];
}

export const QA_FLAG_CODES = {
  TITLE_MISSING: 'TITLE_MISSING',
  LOCATION_MISSING: 'LOCATION_MISSING',
  CONTENT_TOO_SHORT: 'CONTENT_TOO_SHORT',
  SALARY_MISMATCH: 'SALARY_MISMATCH',
  HEADCOUNT_MISMATCH: 'HEADCOUNT_MISMATCH',
  EXTRA_BENEFITS_ADDED: 'EXTRA_BENEFITS_ADDED',
  FACTS_COUNT_MISMATCH: 'FACTS_COUNT_MISMATCH',
  MARKETING_NOT_JOB: 'MARKETING_NOT_JOB',
  STALE_SOURCE: 'STALE_SOURCE',
  SOURCE_INACCESSIBLE: 'SOURCE_INACCESSIBLE',
  LANGUAGE_UNKNOWN: 'LANGUAGE_UNKNOWN',
  JSON_INVALID: 'JSON_INVALID',
  DUPLICATE_CLUSTER: 'DUPLICATE_CLUSTER',
  WORK_PERMIT_MISSING_IN_TRANSLATION: 'WORK_PERMIT_MISSING_IN_TRANSLATION',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
} as const;

export type QAFlagCode = (typeof QA_FLAG_CODES)[keyof typeof QA_FLAG_CODES];
