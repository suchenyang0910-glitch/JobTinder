// One-off: connect to 'postgres' default DB and CREATE DATABASE jobtinder.
// Only used during local setup. Loads .env from project root first.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

// Load .env manually so this script works standalone
(function () {
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Critical infra keys MUST be overridden by project .env — never inherit
    // stray system env from sibling projects.
    const alwaysOverride = [
      'DATABASE_URL','TELEGRAM_BOT_TOKEN','TELEGRAM_SESSION_SALT','APP_HASH_PEPPER',
      'AI_DEFAULT_PROVIDER','AI_DEEPSEEK_API_KEY','AI_OLLAMA_BASE_URL','AI_OPENAI_API_KEY',
    ];
    if (process.env[key] === undefined || alwaysOverride.includes(key)) {
      process.env[key] = value;
    }
  }
})();

const u = process.env.DATABASE_URL;
const MATCH = u?.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]*)@([^/:]+)(?::(\d+))?\/([^?]+)/);
if (!MATCH) {
  console.error('[ensure-db] DATABASE_URL missing or invalid:', u);
  process.exit(1);
}
const [, user, pass, host, portStr, database] = MATCH;
const port = Number(portStr || 5432);

const connStr = `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/postgres`;
const client = new Client({ connectionString: connStr });

try {
  await client.connect();
  const res = await client.query(
    `SELECT 1 AS exists FROM pg_database WHERE datname = $1`,
    [database],
  );
  if (res.rows.length > 0) {
    console.log(`[ensure-db] database "${database}" already exists OK`);
  } else {
    await client.query(`CREATE DATABASE "${database}"`);
    console.log(`[ensure-db] CREATED database "${database}" OK`);
  }
  process.exit(0);
} catch (e) {
  console.error('[ensure-db] FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  try { await client.end(); } catch { /* ignore */ }
}
