import type { AppErrorCodeType } from '@src/shared/errors/app-error-code';
import { AppError } from '@src/shared/errors/app-error';
import type { Translation } from '@src/shared/i18n/locales/en';

/**
 * Prisma engine-level connection codes that always mean "the DB is not ready
 * right now". We deliberately convert these to a friendly retry prompt rather
 * than the generic "Unexpected error" so that local developers (and real users
 * during transient outages) get actionable guidance instead of silent failures.
 */
const DB_UNAVAIL_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1017']);

const DB_UNAVAIL_TEXT =
  '⏳ Service warming up — database not ready yet.\n' +
  'Please retry in 1 minute, or start a local Postgres instance\n' +
  'with DATABASE_URL pointing to the "paperclip" database.\n' +
  '(Your session is kept in memory for now, no data is lost.)';

function looksLikeDbUnavailable(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code ?? (err as { errorCode?: string }).errorCode;
  if (typeof code === 'string' && DB_UNAVAIL_CODES.has(code)) return true;
  const name = (err as Error).name;
  if (
    name === 'PrismaClientInitializationError' ||
    name === 'PrismaClientRustPanicError' ||
    name === 'PrismaClientKnownRequestError'
  ) {
    const msg = (err as Error).message ?? '';
    for (const c of DB_UNAVAIL_CODES) if (msg.includes(c)) return true;
    if (msg.includes('Database `') && msg.includes(' does not exist')) return true;
    if (msg.includes("Can't reach database server")) return true;
  }
  return false;
}

export function translateAppError(
  error: unknown,
  T: Translation,
): { text: string; retryable: boolean } {
  const code: AppErrorCodeType | null = error instanceof AppError ? error.code : null;

  if (code) {
    const known = lookup(code, T);
    if (known) return known;
  }
  // Prisma / engine layer transport errors: surface a retry prompt even when
  // the raw exception never crossed the AppError boundary.
  if (looksLikeDbUnavailable(error)) {
    return { text: DB_UNAVAIL_TEXT, retryable: true };
  }
  return { text: T.ERRORS.default(), retryable: false };
}

function lookup(
  code: AppErrorCodeType,
  T: Translation,
): { text: string; retryable: boolean } | null {
  switch (code) {
    case 'DB_UNAVAILABLE_TRY_LATER':
      return {
        text:
          '⏳ Service warming up — database not ready yet.\n' +
          'Please retry in 1 minute, or start a local Postgres instance\n' +
          'with DATABASE_URL pointing to the "paperclip" database.\n' +
          '(Your session is kept in memory for now, no data is lost.)',
        retryable: true,
      };
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
