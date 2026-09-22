import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateEnv } from './env.schema';

// Keys that are ALWAYS overwritten by .env when present there. These are the
// infrastructure-level secrets that almost always live in per-project .env and
// must NOT be inherited from stray system-wide / user-level environment
// variables (e.g. a leftover `DATABASE_URL=postgres://hermes@localhost/paperclip`
// from a sibling project would otherwise silently break JobTinder).
const DOTENV_OVERRIDE_KEYS = new Set([
  'DATABASE_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_URL',
  'TELEGRAM_SESSION_SALT',
  'AI_DEFAULT_PROVIDER',
  'AI_DEEPSEEK_API_KEY',
  'AI_OLLAMA_BASE_URL',
  'AI_OPENAI_API_KEY',
  'AI_OPENAI_BASE_URL',
  'APP_HASH_PEPPER',
]);

(function loadDotEnvIfPresent() {
  // Process-local, idempotent load of <root>/.env — no external dependency.
  // Avoids the common Nest / ts-node gotcha where process.env does not include
  // .env vars unless ConfigModule or `--require dotenv/config` is used.
  const dotEnvPath = resolve(process.cwd(), '.env');
  if (!existsSync(dotEnvPath)) return;
  const raw = readFileSync(dotEnvPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const override = DOTENV_OVERRIDE_KEYS.has(key);
    if (process.env[key] === undefined || override) {
      process.env[key] = value;
    }
  }
})();

export const APP_ENV = validateEnv(process.env);
export type AppEnv = typeof APP_ENV;
