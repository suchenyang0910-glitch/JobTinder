import { APP_ENV } from './app-env';

function formatValue(v: unknown): string {
  if (typeof v === 'string' && v.length > 8) {
    return `${v.slice(0, 4)}***${v.slice(-2)}`;
  }
  return typeof v === 'string' && v.length === 0 ? '(empty)' : String(v);
}

const STRICT = process.argv.includes('--strict');

const PLACEHOLDER_RE =
  /(change-?me|example\.com|example|your-?-?key|your-?-?bot|your-?-?token|xxxx|fill|replace|TODO|DEADBEEF|deadbeef)/i;

const REQUIRED_NON_EMPTY = ['DATABASE_URL', 'APP_HASH_PEPPER', 'TELEGRAM_SESSION_SALT'] as const;

// --strict: token required only in non-dev
const strictTokenRequired =
  STRICT && APP_ENV.NODE_ENV !== 'development' && APP_ENV.NODE_ENV !== 'test';

const ENV = APP_ENV as Record<string, unknown>;
const keys = Object.keys(ENV).sort();
for (const k of keys) {
  // eslint-disable-next-line no-console
  console.log(`${k}=${formatValue(ENV[k])}`);
}

const errors: string[] = [];
const strictPlaceholderCheck =
  STRICT && APP_ENV.NODE_ENV !== 'development' && APP_ENV.NODE_ENV !== 'test';

for (const k of REQUIRED_NON_EMPTY) {
  const v = String(ENV[k] ?? '');
  if (!v) {
    errors.push(`[strict] ${k} must not be empty`);
    continue;
  }
  if (strictPlaceholderCheck && PLACEHOLDER_RE.test(v)) {
    errors.push(`[strict] ${k} appears to be a placeholder: "${v.slice(0, 40)}"`);
  }
}

if (strictTokenRequired) {
  const token = String(ENV.TELEGRAM_BOT_TOKEN ?? '');
  if (!token) {
    errors.push('[strict] TELEGRAM_BOT_TOKEN required in staging/production');
  } else if (PLACEHOLDER_RE.test(token)) {
    errors.push('[strict] TELEGRAM_BOT_TOKEN appears to be a placeholder');
  }
}

// eslint-disable-next-line no-console
console.log('');

if (errors.length) {
  console.error('ENVIRONMENT VALIDATION FAILED:');
  for (const e of errors) {
    console.error('  • ' + e);
  }
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log(STRICT ? 'Environment OK (strict).' : 'Environment OK.');
