// Prisma CLI / `prisma migrate` wrapper that loads .env and OVERRIDES
// process.env for the set of critical keys before invoking the sub-command.
// Rationale: Prisma's built-in dotenv loader respects "already set" env vars,
// so system-wide / other-project DATABASE_URL (or TELEGRAM_BOT_TOKEN, etc.)
// silently shadow project .env, leading to "paperclip DB not found"-type bugs.
//
// Usage:
//   node scripts/with-dotenv-override.cjs prisma migrate deploy
//   node scripts/with-dotenv-override.cjs ts-node prisma/seed.ts
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const OVERRIDE_KEYS = new Set([
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

const dotEnvPath = resolve(process.cwd(), '.env');
if (existsSync(dotEnvPath)) {
  const raw = readFileSync(dotEnvPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (OVERRIDE_KEYS.has(key)) {
      process.env[key] = value;
    } else if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  // eslint-disable-next-line no-console
  console.error('Usage: with-dotenv-override.cjs <command> [args...]');
  process.exit(2);
}
const cmd = args[0];
const rest = args.slice(1);
// Prepend local node_modules/.bin to PATH so we find locally-installed tools
// like `prisma`, `ts-node` regardless of global installation state.
const binDir = resolve(process.cwd(), 'node_modules', '.bin');
const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
process.env[pathKey] =
  binDir + (process.platform === 'win32' ? ';' : ':') + (process.env[pathKey] || '');
const result = spawnSync(cmd, rest, {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
