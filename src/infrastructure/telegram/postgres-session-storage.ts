import type { StorageAdapter } from 'grammy';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../db/prisma/prisma.service';
import type { Clock } from '@src/shared/clock/clock';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import { Inject } from '@nestjs/common';

type FallbackEntry<S> = { data: S; expireAtMs: number };

/**
 * PostgreSQL-backed grammY StorageAdapter (session persistence) with an
 * in-memory fallback for when Postgres is unreachable.
 *
 * Guarantees:
 * - The read/write/delete calls NEVER throw. Any DB error is swallowed with a
 *   warn log and falls back to an in-process LRU-style Map. This is critical
 *   for grammY: the session middleware is the first in the chain, so if it
 *   throws then /start (and every command) looks like "bot has no reaction".
 * - When PG comes back up, writes transparently go to PG again (best-effort;
 *   pending in-memory state is NOT flushed back — acceptable for session
 *   step state, which is ephemeral per conversation anyway).
 * - Expires after 30 days of inactivity (both PG rows and in-memory entries).
 * - Session data ONLY stores internal IDs / step state; never PII.
 */
@Injectable()
export class PostgresSessionStorage<S extends object> implements StorageAdapter<S> {
  private static readonly SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  private static readonly FALLBACK_MAX = 2000;
  private readonly logger = new Logger(PostgresSessionStorage.name);
  private readonly memory: Map<string, FallbackEntry<S>> = new Map();
  private pgWarnedOnce = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------
  // Public API: never throws
  // ------------------------------------------------------------------

  async read(key: string): Promise<S | undefined> {
    try {
      const row = await this.prisma.sessions.findUnique({
        where: { session_key: key },
        select: { session_data: true, expires_at: true },
      });
      if (!row) return this.memoryGet(key);
      if (row.expires_at.getTime() < this.clock.now().getTime()) {
        void this.prisma.sessions.delete({ where: { session_key: key } }).catch(() => undefined);
        this.memory.delete(key);
        return undefined;
      }
      return row.session_data as S;
    } catch (e) {
      this.warnOncePgUnavailable('read', e);
      return this.memoryGet(key);
    }
  }

  async write(key: string, value: S): Promise<void> {
    const userIdRaw = (value as { userId?: unknown })?.userId;
    const userId =
      userIdRaw == null
        ? null
        : typeof userIdRaw === 'bigint'
          ? userIdRaw
          : BigInt(String(userIdRaw));
    const now = this.clock.now();
    const expireAtMs = now.getTime() + PostgresSessionStorage.SESSION_TTL_MS;
    const expires = new Date(expireAtMs);

    try {
      await this.prisma.sessions.upsert({
        where: { session_key: key },
        update: {
          session_data: value,
          expires_at: expires,
          user_id: userId,
        },
        create: {
          session_key: key,
          session_data: value,
          expires_at: expires,
          user_id: userId,
        },
      });
    } catch (e) {
      this.warnOncePgUnavailable('write', e);
      this.memorySet(key, value, expireAtMs);
      return;
    }
    // PG write succeeded: keep in-memory copy consistent too (cheap)
    this.memorySet(key, value, expireAtMs);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.prisma.sessions.delete({ where: { session_key: key } });
    } catch (e) {
      this.warnOncePgUnavailable('delete', e);
    } finally {
      this.memory.delete(key);
    }
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private memoryGet(key: string): S | undefined {
    const e = this.memory.get(key);
    if (!e) return undefined;
    if (e.expireAtMs < this.clock.now().getTime()) {
      this.memory.delete(key);
      return undefined;
    }
    return e.data;
  }

  private memorySet(key: string, data: S, expireAtMs: number): void {
    // Evict oldest to keep bounded
    if (this.memory.size >= PostgresSessionStorage.FALLBACK_MAX) {
      const first = this.memory.keys().next();
      if (!first.done) this.memory.delete(first.value);
    }
    this.memory.set(key, { data, expireAtMs });
  }

  private warnOncePgUnavailable(op: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (this.pgWarnedOnce) {
      this.logger.debug(`Session ${op}: PG unavailable (cached), first-err: ${msg}`);
      return;
    }
    this.pgWarnedOnce = true;
    this.logger.warn(
      `Session ${op}: Postgres unreachable — session falling back to IN-MEMORY MAP. ` +
        `State WILL be lost on process restart. First error: ${msg}. ` +
        `Start Postgres with DATABASE_URL pointing to "paperclip" DB to restore persistence.`,
    );
  }
}
