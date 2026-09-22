import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateEnv } from './env.schema';

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
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
})();

export const APP_ENV = validateEnv(process.env);
export type AppEnv = typeof APP_ENV;
