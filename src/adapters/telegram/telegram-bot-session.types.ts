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
  | 'CANDIDATE_ONBOARD_ASK_ROLES'
  | 'CANDIDATE_ONBOARD_ASK_SKILLS'
  | 'CANDIDATE_ONBOARD_ASK_INDUSTRIES'
  | 'CANDIDATE_ONBOARD_CONFIRM';

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
}

export function createEmptySession(): TelegramBotSession {
  return {
    step: 'IDLE',
  };
}
