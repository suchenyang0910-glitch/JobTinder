import { Injectable } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import type { Language, UserRole, UserStatus } from '@prisma/client';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import { Inject } from '@nestjs/common';
import type { Clock } from '@src/shared/clock/clock';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { AuditActionEnum } from '@src/shared/audit/audit-action-enum';

export interface UpsertTelegramUserInput {
  telegramUserId: number | bigint;
  telegramUsername?: string | null;
  telegramFirstName?: string | null;
  telegramLastName?: string | null;
  languageFromTg?: Language;
  initialPreference?: { language?: Language; role?: UserRole };
}

export interface UserView {
  id: bigint;
  telegramUserId: bigint;
  telegramUsername?: string | null;
  language: Language;
  preferredRole: UserRole | null;
  status: UserStatus;
  createdAt: Date;
}

@Injectable()
export class UserIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Idempotent upsert. The same telegram_user_id always maps to one internal user.
   * Deleted users (status=DELETED) are re-activated only if explicitly requested (not here).
   */
  async upsertFromTelegram(
    input: UpsertTelegramUserInput,
  ): Promise<{ user: UserView; isNew: boolean }> {
    const now = this.clock.now();
    const tgUid = BigInt(input.telegramUserId);
    const prefLang = input.initialPreference?.language;
    const userPrefLang = prefLang ?? input.languageFromTg ?? 'en';

    const existing = await this.prisma.users.findUnique({ where: { telegram_user_id: tgUid } });
    if (existing) {
      if (existing.status === 'DELETED') {
        throw new AppError({ code: AppErrorCode.AUTH_UNAUTHORIZED, message: 'Account deleted' });
      }
      const nextLang = prefLang ?? existing.language;
      let updated = existing;
      if (
        nextLang !== existing.language ||
        (input.initialPreference?.role &&
          input.initialPreference.role !== existing.preferred_role) ||
        input.telegramUsername !== existing.telegram_username ||
        input.telegramFirstName !== existing.telegram_first_name ||
        input.telegramLastName !== existing.telegram_last_name
      ) {
        updated = await this.prisma.users.update({
          where: { id: existing.id },
          data: {
            language: nextLang,
            preferred_role: input.initialPreference?.role ?? existing.preferred_role,
            telegram_username: input.telegramUsername ?? existing.telegram_username,
            telegram_first_name: input.telegramFirstName ?? existing.telegram_first_name,
            telegram_last_name: input.telegramLastName ?? existing.telegram_last_name,
            updated_at: now,
          },
        });
        if (nextLang !== existing.language) {
          await this.audit.record({
            actorId: updated.id,
            action: AuditActionEnum.USER_LANGUAGE_CHANGED,
            objectType: 'user',
            objectId: updated.id,
            now,
            metadata: { from: existing.language, to: updated.language },
          });
        }
      }
      return { user: this.toView(updated), isNew: false };
    }

    // Create new user (in transaction + audit)
    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.users.create({
        data: {
          telegram_user_id: tgUid,
          telegram_username: input.telegramUsername ?? null,
          telegram_first_name: input.telegramFirstName ?? null,
          telegram_last_name: input.telegramLastName ?? null,
          language: userPrefLang,
          preferred_role: input.initialPreference?.role ?? null,
          status: 'ACTIVE',
          created_at: now,
          updated_at: now,
        },
      });
      await this.audit.record({
        actorId: user.id,
        action: AuditActionEnum.USER_CREATED,
        objectType: 'user',
        objectId: user.id,
        now,
        metadata: {
          telegram_user_id_hash: this.fingerprint(String(tgUid)),
          initial_language: user.language,
        },
      });
      return user;
    });

    return { user: this.toView(created), isNew: true };
  }

  async getById(userId: bigint | number): Promise<UserView> {
    const u = await this.prisma.users.findUnique({ where: { id: BigInt(userId) } });
    if (!u) throw new AppError({ code: AppErrorCode.AUTH_UNAUTHORIZED });
    if (u.status === 'DELETED') {
      throw new AppError({ code: AppErrorCode.AUTH_UNAUTHORIZED, message: 'Account deleted' });
    }
    return this.toView(u);
  }

  private toView(u: {
    id: bigint;
    telegram_user_id: bigint;
    telegram_username: string | null;
    language: Language;
    preferred_role: UserRole | null;
    status: UserStatus;
    created_at: Date;
  }): UserView {
    return {
      id: u.id,
      telegramUserId: u.telegram_user_id,
      telegramUsername: u.telegram_username,
      language: u.language,
      preferredRole: u.preferred_role,
      status: u.status,
      createdAt: u.created_at,
    };
  }

  /**
   * Non-reversible deterministic fingerprint for audit metadata only.
   * Uses APP_HASH_PEPPER so raw telegram IDs never land in audit_events.
   */
  private fingerprint(plain: string): string {
    const pepper = (process.env.APP_HASH_PEPPER as string) ?? 'jobtinder-dev-pepper';
    let hash = 0;
    const s = `${pepper}:${plain}`;
    for (let i = 0; i < s.length; i++) {
      hash = (hash << 5) - hash + s.charCodeAt(i);
      hash |= 0;
    }
    return `h${Math.abs(hash).toString(16)}`;
  }
}
