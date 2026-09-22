import type { AppErrorCodeType } from '@src/shared/errors/app-error-code';
import { AppError } from '@src/shared/errors/app-error';
import type { Translation } from '@src/shared/i18n/locales/en';

export function translateAppError(
  error: unknown,
  T: Translation,
): { text: string; retryable: boolean } {
  const code: AppErrorCodeType | null = error instanceof AppError ? error.code : null;

  if (code) {
    const known = lookup(code, T);
    if (known) return known;
    return { text: T.ERRORS.default(), retryable: false };
  }
  return { text: T.ERRORS.default(), retryable: false };
}

function lookup(
  code: AppErrorCodeType,
  T: Translation,
): { text: string; retryable: boolean } | null {
  switch (code) {
    case 'AUTH_UNAUTHORIZED':
      return { text: T.ERRORS.AUTH_UNAUTHORIZED(), retryable: false };
    case 'PROFILE_NOT_FOUND':
      return { text: T.ERRORS.PROFILE_NOT_FOUND(), retryable: false };
    case 'PROFILE_NOT_CONFIRMED':
      return { text: T.ERRORS.PROFILE_NOT_CONFIRMED(''), retryable: false };
    case 'PROFILE_DRAFT_STALE':
      return { text: T.ERRORS.PROFILE_DRAFT_STALE(), retryable: false };
    case 'VERSION_MISMATCH':
      return { text: T.ERRORS.VERSION_MISMATCH(), retryable: false };
    case 'INTERNAL_UNKNOWN':
    case 'INTERNAL_DB_ERROR':
    case 'INTERNAL_TX_FAILED':
      return { text: T.ERRORS.INTERNAL_UNKNOWN(), retryable: true };
    case 'AI_UNAVAILABLE':
    case 'AI_RATE_LIMITED':
    case 'AI_PROVIDER_UNKNOWN':
      return { text: T.ERRORS.AI_UNAVAILABLE(), retryable: false };
    default:
      return null;
  }
}
