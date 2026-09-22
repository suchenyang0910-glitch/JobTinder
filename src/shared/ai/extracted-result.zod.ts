// Zod schemas for validating AI provider JSON output. The provider may be
// unreliable; we validate every field aggressively and silently discard
// non-conformant values rather than propagating the error upstream.
// The validation goal is NOT to make the AI "correct" — only to make its
// output type-safe so callers can never ingest a hallucinated shape.

import { z } from 'zod';

const MAX_FIELD_ITEMS = 50;
const MAX_FIELD_STR_LEN = 120;
const MAX_TEXT_STR_LEN = 512;

const safeStringArray = (field: string) =>
  z
    .array(
      z
        .string()
        .max(MAX_FIELD_STR_LEN)
        .transform((v) => v.trim())
        .refine((v) => v.length > 0, `${field}: empty item disallowed`),
    )
    .max(MAX_FIELD_ITEMS, `${field}: too many items (max ${MAX_FIELD_ITEMS})`)
    .default([]);

const salaryStatusSchema = z
  .enum(['PROVIDED', 'NOT_PROVIDED', 'NEGOTIABLE'])
  .default('NOT_PROVIDED');

const candidateExperienceSchema = z.object({
  company: z.string().max(MAX_FIELD_STR_LEN).optional(),
  role: z.string().max(MAX_FIELD_STR_LEN).optional(),
  durationMonths: z.number().int().min(0).max(480).optional(),
  note: z.string().max(MAX_TEXT_STR_LEN).optional(),
});

const candidateCertSchema = z.object({
  name: z.string().max(MAX_FIELD_STR_LEN),
  issuer: z.string().max(MAX_FIELD_STR_LEN).optional(),
  year: z.number().int().min(1950).max(2100).optional(),
});

export const candidateAIResponseSchema = z.object({
  targetRoles: safeStringArray('targetRoles'),
  skills: safeStringArray('skills'),
  industries: safeStringArray('industries'),
  taskKeywords: safeStringArray('taskKeywords'),
  locations: safeStringArray('locations'),
  languagesKnown: safeStringArray('languagesKnown'),
  salaryStatus: salaryStatusSchema,
  salaryText: z.string().max(MAX_FIELD_STR_LEN).nullable().default(null),
  availabilityNote: z.string().max(MAX_TEXT_STR_LEN).nullable().default(null),
  workExperience: z
    .array(candidateExperienceSchema)
    .max(30, 'workExperience: up to 30 items allowed')
    .default([]),
  certifications: z
    .array(candidateCertSchema)
    .max(50, 'certifications: up to 50 items allowed')
    .default([]),
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
  unknownFields: safeStringArray('unknownFields'),
  warnings: safeStringArray('warnings'),
});

export type CandidateAIResponseDTO = z.infer<typeof candidateAIResponseSchema>;

const jobResponseSchema = z.object({
  title: z.string().max(MAX_FIELD_STR_LEN).nullable().default(null),
  tasks: safeStringArray('tasks'),
  skills: safeStringArray('skills'),
  industry: z.string().max(MAX_FIELD_STR_LEN).nullable().default(null),
  locations: safeStringArray('locations'),
  languagesRequired: safeStringArray('languagesRequired'),
  shifts: safeStringArray('shifts'),
  salaryStatus: salaryStatusSchema,
  salaryText: z.string().max(MAX_FIELD_STR_LEN).nullable().default(null),
  availabilityStart: z.string().max(MAX_FIELD_STR_LEN).nullable().default(null),
  housingProvided: z.boolean().nullable().default(null),
  mealsProvided: z.boolean().nullable().default(null),
  transportProvided: z.boolean().nullable().default(null),
  workPermitRequired: z.boolean().nullable().default(null),
  headcount: z.number().int().min(1).max(10000).nullable().default(null),
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
  unknownFields: safeStringArray('unknownFields'),
  warnings: safeStringArray('warnings'),
});

export type JobAIResponseDTO = z.infer<typeof jobResponseSchema>;

/**
 * Strip Markdown code fences (```json ... ``` or ``` ... ```) and any stray
 * surrounding explanation text the model likes to add. Only the JSON body
 * between the first `{` and the last `}` is kept. We NEVER try to interpret
 * explanatory text as data.
 */
export function extractJsonBody(raw: string): string {
  if (!raw) return '{}';
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenceMatch ? (fenceMatch[1] ?? trimmed) : trimmed;
  const firstBrace = body.indexOf('{');
  const lastBrace = body.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return '{}';
  }
  return body.slice(firstBrace, lastBrace + 1);
}

export function parseCandidateAI(raw: string):
  | {
      ok: true;
      value: CandidateAIResponseDTO;
      discarded?: string[];
    }
  | { ok: false; errors: string[] } {
  try {
    const jsonBody = extractJsonBody(raw);
    // PRD §X / §XIII: never silently produce an empty Profile from garbage input.
    // If extractJsonBody had to fall back to {} (no JSON found), treat as failed.
    if (jsonBody === '{}') {
      return { ok: false, errors: ['parse: no valid JSON object found in AI response'] };
    }
    const parsed = JSON.parse(jsonBody);
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length === 0) {
      return { ok: false, errors: ['parse: AI returned empty JSON object'] };
    }
    const result = candidateAIResponseSchema.safeParse(parsed);
    if (result.success) {
      return { ok: true, value: result.data };
    }
    const errs: string[] = [];
    for (const issue of result.error.issues) {
      errs.push(`${issue.path.join('.') || '/'}: ${issue.code} ${issue.message}`);
    }
    return { ok: false, errors: errs };
  } catch (e) {
    return { ok: false, errors: [`parse: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

export function parseJobAI(raw: string):
  | {
      ok: true;
      value: JobAIResponseDTO;
    }
  | { ok: false; errors: string[] } {
  try {
    const jsonBody = extractJsonBody(raw);
    if (jsonBody === '{}') {
      return { ok: false, errors: ['parse: no valid JSON object found in AI job response'] };
    }
    const parsed = JSON.parse(jsonBody);
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length === 0) {
      return { ok: false, errors: ['parse: AI returned empty job JSON object'] };
    }
    const result = jobResponseSchema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data };
    const errs: string[] = [];
    for (const issue of result.error.issues) {
      errs.push(`${issue.path.join('.') || '/'}: ${issue.code} ${issue.message}`);
    }
    return { ok: false, errors: errs };
  } catch (e) {
    return { ok: false, errors: [`parse: ${e instanceof Error ? e.message : String(e)}`] };
  }
}
