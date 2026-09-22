import { describe, it, beforeAll, afterAll, expect, beforeEach } from 'vitest';
import { IntegrationTestContext } from '../helpers/integration-test-context';
import { CandidateOnboardingService } from '@src/application/onboarding/candidate-onboarding.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { OutboxRepository } from '@src/infrastructure/queue/outbox.repository';
import { AppError } from '@src/shared/errors/app-error';

const ENABLED = !!process.env.RUN_INTEGRATION;

describe.skipIf(!ENABLED)(
  'CandidateOnboardingService integration (PostgreSQL via Testcontainers)',
  () => {
    let ctx: IntegrationTestContext;
    let clock: FakeClock;
    let svc: CandidateOnboardingService;
    let userId: bigint;

    beforeAll(async () => {
      ctx = await IntegrationTestContext.start();
      await import('node:child_process').then((m) =>
        m.default.execSync('pnpm prisma migrate deploy', {
          env: { ...process.env, DATABASE_URL: ctx.connectionUri },
          stdio: 'pipe',
        }),
      );
    }, 180_000);

    afterAll(async () => {
      await ctx?.stop();
    });

    beforeEach(async () => {
      clock = FakeClock.fromISO('2026-09-21T00:00:00Z');
      svc = new CandidateOnboardingService(
        ctx.prisma,
        clock,
        new AuditRepository(ctx.prisma),
        new OutboxRepository(ctx.prisma),
      );
      const user = await ctx.prisma.users.create({
        data: {
          telegram_user_id: BigInt(1000 + Math.floor(Math.random() * 1_000_000)),
          telegram_username: 'test_user',
          language: 'en',
          status: 'ACTIVE',
        },
      });
      userId = user.id;
    });

    it('createDraft → updateDraft → confirm; audit + outbox present', async () => {
      const a = await svc.createDraft({ userId, source: 'manual' });
      expect(a.status).toBe('DRAFT');

      const b = await svc.createDraft({ userId, source: 'mock' });
      expect(b.id).toBe(a.id);

      const u = await svc.updateDraft({
        userId,
        draftId: a.id,
        expectedVersion: a.version,
        edits: { targetRoles: ['Barista', 'Cashier'], skills: ['English', 'Coffee'] },
      });
      expect(u.fields.targetRoles).toEqual(['Barista', 'Cashier']);

      await expect(
        svc.confirm({ userId, draftId: a.id, expectedVersion: 999 }),
      ).rejects.toBeInstanceOf(AppError);

      const c = await svc.confirm({ userId, draftId: a.id, expectedVersion: u.version });
      expect(c.status).toBe('CONFIRMED');
      expect(c.confirmedAt).toBeDefined();

      const events = await ctx.prisma.audit_events.findMany({
        where: { object_type: 'candidate_profile', object_id: c.id },
        orderBy: { created_at: 'asc' },
      });
      expect(events.map((e) => e.action)).toEqual([
        'PROFILE_DRAFT_CREATED',
        'PROFILE_DRAFT_UPDATED',
        'PROFILE_CONFIRMED',
      ]);

      const notes = await ctx.prisma.notifications.findMany({ where: { recipient_id: userId } });
      expect(notes.length).toBeGreaterThanOrEqual(1);
      expect(notes.some((n) => n.type === 'PROFILE_CONFIRMED')).toBe(true);
    });

    it('confirm throws PROFILE_NOT_CONFIRMED when required fields missing', async () => {
      const d = await svc.createDraft({ userId, source: 'manual' });
      try {
        await svc.confirm({ userId, draftId: d.id, expectedVersion: d.version });
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('PROFILE_NOT_CONFIRMED');
      }
    });
  },
);
