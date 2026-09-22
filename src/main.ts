import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { APP_ENV } from './shared/env/app-env';

process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e?.message, e?.stack);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e instanceof Error ? e.stack : String(e));
});

const logger = new Logger('Bootstrap');

const STARTED_AT = Date.now();

async function bootstrap() {
  let app: NestFastifyApplication | null = null;
  try {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ logger: false }),
      {
        bufferLogs: false,
        abortOnError: false,
        logger: ['log', 'warn', 'error', 'debug', 'verbose'],
      },
    );
    app.enableShutdownHooks();
  } catch (bootstrapErr) {
    // eslint-disable-next-line no-console
    console.error(
      '[FATAL] NestFactory.create failed — before Nest logger was ready:',
      bootstrapErr instanceof Error ? bootstrapErr.stack : String(bootstrapErr),
    );
    process.exitCode = 1;
    return;
  }

  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/health', (_req: unknown, res: unknown) => {
    const response = res as { status: (code: number) => unknown; send: (body: unknown) => unknown };
    void response.status(200);
    void response.send({
      status: 'ok',
      uptimeS: Math.floor((Date.now() - STARTED_AT) / 1000),
      nodeEnv: APP_ENV.NODE_ENV,
      version: '0.1.0',
    });
  });

  const port = APP_ENV.PORT;
  await app.listen(port, '0.0.0.0');
  logger.log(`HTTP listening on :${port} [${APP_ENV.NODE_ENV}]`);
  if (!APP_ENV.TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN is empty; Telegram bot is offline.');
  }
}

bootstrap().catch((e) => {
  logger.error('Bootstrap FAILED', e?.stack ?? undefined);
  process.exit(1);
});
