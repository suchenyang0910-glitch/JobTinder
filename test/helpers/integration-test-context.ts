import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';

export class IntegrationTestContext {
  private constructor(
    public readonly container: StartedPostgreSqlContainer,
    public readonly prisma: PrismaService,
  ) {}

  static async start(): Promise<IntegrationTestContext> {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('jobtinder_test')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.APP_HASH_PEPPER = 'test-pepper-32-chars-minimum-xxxxxxxx';
    process.env.TELEGRAM_SESSION_SALT = 'test-salt-change-me';
    process.env.TELEGRAM_BOT_TOKEN = '';
    process.env.AI_DEFAULT_PROVIDER = 'mock';

    const prisma = new PrismaService();
    await prisma.$connect();
    // Deploy migrations via raw SQL dump of schema — or better: `prisma migrate deploy`
    // We execute the SQL schema baseline via $executeRawUnsafe after reading migration.
    return new IntegrationTestContext(container, prisma);
  }

  async stop(): Promise<void> {
    await this.prisma.$disconnect().catch(() => undefined);
    await this.container.stop().catch(() => undefined);
  }

  get connectionUri(): string {
    return this.container.getConnectionUri();
  }
}
