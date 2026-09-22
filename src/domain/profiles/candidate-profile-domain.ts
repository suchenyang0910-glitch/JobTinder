// Candidate profile versioned fields (pure)
// We only compare field presence/semantics; never inline PII in domain objects.

export type ProfileStatus = 'DRAFT' | 'CONFIRMED' | 'PAUSED' | 'DELETED';

export type SalaryStatus = 'PROVIDED' | 'NOT_PROVIDED' | 'NEGOTIABLE';

export type ProfileFieldSource = Record<string, 'ai_extracted' | 'user_confirmed' | 'unknown'>;

export interface CandidateDraftFields {
  skills?: string[];
  industries?: string[];
  targetRoles?: string[];
  taskKeywords?: string[];
  locations?: string[];
  languagesKnown?: string[];
  salaryStatus?: SalaryStatus;
  salaryText?: string;
  availabilityNote?: string;
}

export interface CandidateProfileState {
  id?: bigint | number | string;
  userId: bigint | number | string;
  version: number;
  status: ProfileStatus;
  fields: CandidateDraftFields;
  fieldSources: ProfileFieldSource;
  confirmedAt?: Date;
  draftSource?: 'manual' | 'ai' | 'mock';
}

/**
 * Merge AI draft into existing confirmed profile.
 * Rule: do NOT overwrite any field that is already user_confirmed.
 */
export function mergeAIDraftIntoConfirmed(
  current: CandidateProfileState,
  aiDraft: CandidateDraftFields,
  aiProviderId: string,
): { next: CandidateDraftFields; nextSources: ProfileFieldSource; changedFields: string[] } {
  const next: CandidateDraftFields = { ...current.fields };
  const nextSources: ProfileFieldSource = { ...current.fieldSources };
  const changed: string[] = [];

  const keys = Object.keys(aiDraft) as (keyof CandidateDraftFields)[];
  for (const k of keys) {
    const v = aiDraft[k];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    if (current.fieldSources[k] === 'user_confirmed') continue; // DO NOT OVERWRITE
    (next as Record<string, unknown>)[k] = v;
    nextSources[k] = 'ai_extracted';
    changed.push(k);
  }
  void aiProviderId;
  return { next, nextSources, changedFields: changed };
}

/**
 * Apply user edits onto a draft. Each edited key becomes user_confirmed once persisted.
 */
export function applyUserEdits(
  base: CandidateDraftFields,
  edits: Partial<CandidateDraftFields>,
): { next: CandidateDraftFields; changedFields: string[] } {
  const next: CandidateDraftFields = { ...base };
  const changed: string[] = [];
  const keys = Object.keys(edits) as (keyof CandidateDraftFields)[];
  for (const k of keys) {
    const v = edits[k];
    if (v === undefined) continue;
    (next as Record<string, unknown>)[k] = v;
    changed.push(k);
  }
  return { next, changedFields: changed };
}

export function isProfileReadyToConfirm(fields: CandidateDraftFields): {
  ok: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!fields.targetRoles?.length) missing.push('targetRoles');
  if (!fields.skills?.length) missing.push('skills');
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, missing: [] };
}
