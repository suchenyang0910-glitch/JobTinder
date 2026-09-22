import { Global, Module, Type } from '@nestjs/common';
import { PrismaModule } from './db/prisma/prisma.module';
import { AI_PROVIDER_TOKEN, AIExtractProvider } from '@src/domain/trust/ai-extract-provider';
import { MockAIProvider } from './ai/mock-ai-provider';
import { OllamaAIProvider } from './ai/ollama-ai-provider';
import { DeepSeekAIProvider } from './ai/deepseek-ai-provider';
import { OpenAICompatibleAIProvider } from './ai/openai-compatible-ai-provider';
import { APP_ENV } from '@src/shared/env/app-env';
import { AuditRepository } from './db/repositories/audit.repository';
import { OutboxRepository } from './queue/outbox.repository';
import { NOTIFY_HANDLER_TOKEN } from './queue/outbox-notification-handler';
import { MockOutboxNotificationHandler } from './queue/mock-outbox-notification-handler';
import { PostgresSessionStorage } from './telegram/postgres-session-storage';
import { StaticHttpCrawler } from './crawler/static-http-crawler';
import { CrawlerTranslationService } from './ai/crawler-translation.service';

function resolveAIProviderClass(): Type<AIExtractProvider> {
  switch (APP_ENV.AI_DEFAULT_PROVIDER) {
    case 'ollama':
      return OllamaAIProvider;
    case 'deepseek':
      return DeepSeekAIProvider;
    case 'openai-compatible':
      return OpenAICompatibleAIProvider;
    case 'mock':
    default:
      return MockAIProvider;
  }
}

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: AI_PROVIDER_TOKEN,
      useClass: resolveAIProviderClass(),
    },
    {
      provide: NOTIFY_HANDLER_TOKEN,
      useClass: MockOutboxNotificationHandler,
    },
    AuditRepository,
    OutboxRepository,
    PostgresSessionStorage,
    StaticHttpCrawler,
    CrawlerTranslationService,
  ],
  exports: [
    PrismaModule,
    AI_PROVIDER_TOKEN,
    NOTIFY_HANDLER_TOKEN,
    AuditRepository,
    OutboxRepository,
    PostgresSessionStorage,
    StaticHttpCrawler,
    CrawlerTranslationService,
  ],
})
export class InfrastructureModule {
  static resolvedAIProvider = resolveAIProviderClass();
}
