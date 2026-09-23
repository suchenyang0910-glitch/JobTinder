import type { Language, UserRole } from '@prisma/client';

/**
 * GrammY session state for the Telegram adapter.
 *
 * CRITICAL: Never store PII here (phone, full resume text, salary text).
 * We only keep IDs, step enum, and the in-progress draft references which point to DB.
 * Salary text goes straight to candidate_profiles via application service.
 */
export type TelegramBotStep =
  | 'IDLE'
  | 'CHOOSE_LANGUAGE'
  | 'CHOOSE_ROLE'
  | 'CANDIDATE_MODE_PICK'
  | 'CANDIDATE_AI_AWAIT_TEXT'
  | 'CANDIDATE_AI_CONFIRM'
  | 'CANDIDATE_ONBOARD_ASK_ROLES'
  | 'CANDIDATE_ONBOARD_ASK_SKILLS'
  | 'CANDIDATE_ONBOARD_ASK_INDUSTRIES'
  | 'CANDIDATE_ONBOARD_CONFIRM'
  | 'COMPANY_MODE_PICK'
  | 'COMPANY_AI_AWAIT_JD_TEXT'
  | 'COMPANY_AI_PREVIEW'
  | 'COMPANY_EDIT_NAME'
  | 'COMPANY_EDIT_INDUSTRY'
  | 'COMPANY_EDIT_SIZE'
  | 'COMPANY_EDIT_LOCATION'
  | 'COMPANY_EDIT_WEBSITE'
  | 'COMPANY_EDIT_RECRUITER'
  | 'COMPANY_JOB_EDIT_TITLE'
  | 'COMPANY_JOB_EDIT_SALARY';

export interface TelegramBotSession {
  // Identity — populated right after /start upsert. Only IDs, no PII.
  userId?: string;
  language?: Language;
  preferredRole?: UserRole;

  // Flow state machine
  step: TelegramBotStep;
  lastUpdatedAtMs?: number;

  // Candidate onboarding — only holds reference to the candidate_profiles DB row.
  candidateDraftId?: string;
  candidateDraftVersion?: number;
  companyId?: string;
  companyEditField?: string;
  companyJobDraftId?: string;
  companyJobEditId?: string;
}

export function createEmptySession(): TelegramBotSession {
  return {
    step: 'IDLE',
  };
}
