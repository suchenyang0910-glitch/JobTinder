import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateOnboardingService } from '@src/application/onboarding/candidate-onboarding.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import type { candidate_profiles, users } from '@prisma/client';
import type { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import type { OutboxRepository } from '@src/infrastructure/queue/outbox.repository';
import type { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';

function makeUser(uid: bigint): users {
  return {
    id: uid,
    telegram_user_id: uid,
    telegram_username: null,
    telegram_first_name: 'U',
    telegram_last_name: null,
    language: 'en',
    preferred_role: 'CANDIDATE',
    status: 'ACTIVE',
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    hash_pepper_version: 1,
  } as users;
}

function makeDraft(over: Partial<candidate_profiles> = {}): candidate_profiles {
  return {
    id: 100n,
    user_id: 1n,
    version: 3,
    status: 'DRAFT',
    skills: ['a'],
    industries: [],
    target_roles: [],
    task_keywords: [],
    locations: [],
    languages_known: [],
    salary_status: 'NOT_PROVIDED',
    salary_text: null,
    availability_note: null,
    job_search_status: 'LOOKING_JOB',
    job_search_status_updated_at: null,
    job_search_status_source: 'MANUAL',
    field_sources: {},
    draft_source: 'manual',
    ai_provider_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    confirmed_at: null,
    deleted_at: null,
    ...over,
  };
}

type PrismaStub = {
  users: { findUnique: ReturnType<typeof vi.fn> };
  candidate_profiles: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

describe('CandidateOnboardingService version guards', () => {
  let service: CandidateOnboardingService;
  const clock = new FakeClock(new Date('2025-01-01T00:00:00Z'));
  let prismaUserFindUnique: ReturnType<typeof vi.fn>;
  let prismaDraftFindUnique: ReturnType<typeof vi.fn>;
  let prismaStub: PrismaStub;

  beforeEach(() => {
    prismaUserFindUnique = vi.fn();
    prismaDraftFindUnique = vi.fn();

    const fakeTx = {
      users: { findUnique: prismaUserFindUnique },
      candidate_profiles: {
        findUnique: prismaDraftFindUnique,
        update: vi.fn(() => Promise.resolve({})),
        updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
      },
    };

    prismaStub = {
      users: { findUnique: prismaUserFindUnique },
      candidate_profiles: { findUnique: prismaDraftFindUnique },
      $transaction: vi.fn(<T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
        return callback(fakeTx);
      }),
    };

    const auditStub = {
      record: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as AuditRepository;
    const outboxStub = {
      createInTx: vi.fn(() => Promise.resolve({ id: 1n })),
    } as unknown as OutboxRepository;

    service = new CandidateOnboardingService(
      prismaStub as unknown as PrismaService,
      clock,
      auditStub,
      outboxStub,
    );
  });

  it('updateDraft throws VERSION_MISMATCH when expectedVersion != row.version', async () => {
    prismaUserFindUnique.mockResolvedValue(makeUser(1n));
    const draft = makeDraft({ version: 5 });
    prismaDraftFindUnique.mockResolvedValue(draft);

    await expect(
      service.updateDraft({
        userId: 1n,
        draftId: draft.id,
        expectedVersion: 4,
        edits: { skills: ['new'] },
      }),
    ).rejects.toBeInstanceOf(AppError);

    try {
      await service.updateDraft({
        userId: 1n,
        draftId: draft.id,
        expectedVersion: 4,
        edits: { skills: ['new'] },
      });
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(AppErrorCode.VERSION_MISMATCH);
    }
  });

  it('updateDraft passes when expectedVersion matches', async () => {
    prismaUserFindUnique.mockResolvedValue(makeUser(1n));
    const draft = makeDraft({
      id: 9n,
      user_id: 1n,
      version: 2,
      target_roles: ['r'],
      skills: ['s'],
    });
    prismaDraftFindUnique.mockResolvedValue(draft);

    await expect(
      service.updateDraft({ userId: 1n, draftId: 9n, expectedVersion: 2, edits: {} }),
    ).resolves.toBeDefined();
  });

  it('confirm throws PROFILE_NOT_CONFIRMED if required fields missing', async () => {
    prismaUserFindUnique.mockResolvedValue(makeUser(1n));
    const draft = makeDraft({
      id: 12n,
      user_id: 1n,
      version: 1,
      target_roles: [],
      skills: [],
    });
    prismaDraftFindUnique.mockResolvedValue(draft);

    try {
      await service.confirm({ userId: 1n, draftId: 12n, expectedVersion: 1 });
      expect.fail('expected AppError');
    } catch (e) {
      expect((e as AppError).code).toBe(AppErrorCode.PROFILE_NOT_CONFIRMED);
    }
  });

  it('confirm throws VERSION_MISMATCH on draft before even checking fields', async () => {
    prismaUserFindUnique.mockResolvedValue(makeUser(1n));
    const draft = makeDraft({
      id: 13n,
      user_id: 1n,
      version: 7,
      target_roles: ['Barista'],
      skills: ['a', 'b'],
    });
    prismaDraftFindUnique.mockResolvedValue(draft);

    try {
      await service.confirm({ userId: 1n, draftId: 13n, expectedVersion: 6 });
      expect.fail('expected AppError');
    } catch (e) {
      expect((e as AppError).code).toBe(AppErrorCode.VERSION_MISMATCH);
    }
  });
});
