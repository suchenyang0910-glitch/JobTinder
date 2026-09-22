import { z } from 'zod';

export const AppEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_WEBHOOK_URL: z.string().optional().or(z.literal('')),
  TELEGRAM_SESSION_SALT: z
    .string()
    .min(8, 'TELEGRAM_SESSION_SALT must be at least 8 chars')
    .default('dev-salt-change-me'),

  AI_DEFAULT_PROVIDER: z.enum(['mock', 'ollama', 'deepseek', 'openai-compatible']).default('mock'),

  AI_OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  AI_OLLAMA_MODEL: z.string().default('llama3.1'),

  AI_DEEPSEEK_API_KEY: z.string().optional().or(z.literal('')),
  AI_DEEPSEEK_MODEL: z.string().default('deepseek-chat'),

  AI_OPENAI_COMPATIBLE_API_KEY: z.string().optional().or(z.literal('')),
  AI_OPENAI_COMPATIBLE_BASE_URL: z.string().url().optional().or(z.literal('')),
  AI_OPENAI_COMPATIBLE_MODEL: z.string().optional().or(z.literal('')),

  APP_HASH_PEPPER: z
    .string()
    .min(16, 'APP_HASH_PEPPER must be >= 16 chars')
    .default('dev-pepper-change-me-xxxxxxxxxxxxxxxx'),

  OUTBOX_WORKER_ENABLED: z.coerce.boolean().default(true),
  OUTBOX_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  OUTBOX_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  OUTBOX_WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),

  CRAWLER_ENABLED: z.coerce.boolean().default(false),
  CRAWLER_CRON_EXPRESSION: z.string().default('0 */15 * * * *'),
  CRAWLER_INTERNAL_TOKEN: z.string().optional().or(z.literal('')).default(''),
  CRAWLER_DAILY_PAGE_LIMIT_PER_SOURCE: z.coerce.number().int().min(1).max(10000).default(200),
  CRAWLER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(20000),
  CRAWLER_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  CRAWLER_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(3600000).default(2000),
  CRAWLER_MAX_INTERVAL_MS: z.coerce.number().int().min(0).max(3600000).default(5000),
});

export type AppEnv = z.infer<typeof AppEnvSchema>;

export function validateEnv(raw: NodeJS.ProcessEnv): AppEnv {
  const parsed = AppEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const path = i.path.join('.');
      return `[${path}] ${i.message}`;
    });
    throw new Error(`Environment validation failed:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
