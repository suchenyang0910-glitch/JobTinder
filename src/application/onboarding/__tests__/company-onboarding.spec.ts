import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompanyOnboardingService } from '@src/application/onboarding/company-onboarding.service';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import type { companies, companies_members, users } from '@prisma/client';
import type { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';

function makeUser(uid: bigint): users {
  return {
    id: uid,
    telegram_user_id: uid,
    telegram_username: null,
    telegram_first_name: 'U',
    telegram_last_name: null,
    language: 'en',
    preferred_role: 'COMPANY',
    status: 'ACTIVE',
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    hash_pepper_version: 1,
  } as users;
}

function makeCompany(over: Partial<companies> = {}): companies {
  const now = new Date('2025-01-01T00:00:00Z');
  return {
    id: 100n,
    name: 'Demo Co',
    website: null,
    description: null,
    industry: null,
    size: null,
    location: null,
    recruiter_name: null,
    recruiter_role: null,
    verification_status: 'UNVERIFIED',
    verified_at: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function makeMembership(
  over: Omit<Partial<companies_members>, 'company_id' | 'user_id'> & {
    company_id: bigint;
    user_id: bigint;
    company?: companies;
  },
): companies_members & { company: companies } {
  const now = new Date('2025-01-01T00:00:00Z');
  const { company, ...rest } = over;
  const base = {
    id: 1n,
    role: 'owner',
    is_owner: true,
    joined_at: now,
  } satisfies Partial<companies_members>;
  return {
    ...base,
    ...rest,
    company: company ?? makeCompany({ id: over.company_id }),
  };
}

type PrismaStub = {
  companies_members: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  companies: {
    create: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

describe('CompanyOnboardingService', () => {
  let service: CompanyOnboardingService;
  const clock = new FakeClock(new Date('2025-01-01T00:00:00Z'));
  let prisma: PrismaStub;
  let prismaMemberFindFirst: ReturnType<typeof vi.fn>;
  let prismaCompanyCreate: ReturnType<typeof vi.fn>;
  let prismaMemberCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    prismaMemberFindFirst = vi.fn();
    prismaCompanyCreate = vi.fn();
    prismaMemberCreate = vi.fn();

    const fakeTx = {
      companies: { create: prismaCompanyCreate },
      companies_members: { create: prismaMemberCreate },
    };

    prisma = {
      companies_members: { findFirst: prismaMemberFindFirst, create: prismaMemberCreate },
      companies: { create: prismaCompanyCreate },
      $transaction: vi.fn(<T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
        return callback(fakeTx);
      }),
    };

    service = new CompanyOnboardingService(prisma as unknown as PrismaService, clock);
  });

  it('createDraft returns existing membership when user already owns a company', async () => {
    const user = makeUser(1n);
    const co = makeCompany({ id: 20n, name: 'Existing Co' });
    prismaMemberFindFirst.mockResolvedValue(
      makeMembership({ company_id: co.id, user_id: user.id, company: co }),
    );
    prismaCompanyCreate.mockResolvedValue(makeCompany({ id: 999n }));

    const result = await service.createDraft({ userId: user.id, source: 'manual' });

    expect(result.id).toEqual(co.id);
    expect(result.isOwner).toEqual(true);
    expect(prismaCompanyCreate).not.toHaveBeenCalled();
  });

  it('createDraft creates new UNVERIFIED company + membership when user owns nothing', async () => {
    const user = makeUser(7n);
    prismaMemberFindFirst.mockResolvedValueOnce(null);
    const newCo = makeCompany({ id: 50n, name: 'New Co', verification_status: 'UNVERIFIED' });
    prismaCompanyCreate.mockResolvedValueOnce(newCo);
    prismaMemberCreate.mockResolvedValueOnce(
      makeMembership({ id: 2n, company_id: newCo.id, user_id: user.id, company: newCo }),
    );

    const result = await service.createDraft({
      userId: user.id,
      source: 'manual',
      initialFields: {
        name: 'New Co',
        website: 'https://newco.example.invalid',
        description: 'hello',
        recruiterName: 'Alice',
        recruiterRole: 'hr',
      },
    });

    expect(prismaCompanyCreate).toHaveBeenCalledTimes(1);
    const createArg = prismaCompanyCreate.mock.calls[0]?.[0] as {
      data: { name: string; website?: string | null };
    };
    expect(createArg.data.name).toEqual('New Co');
    expect(createArg.data.website).toEqual('https://newco.example.invalid');
    expect(createArg).toBeDefined();

    expect(prismaMemberCreate).toHaveBeenCalledTimes(1);
    const memberArg = prismaMemberCreate.mock.calls[0]?.[0] as {
      data: { is_owner: boolean; role: string };
    };
    expect(memberArg.data.is_owner).toEqual(true);
    expect(memberArg.data.role).toEqual('hr');

    expect(result.verificationStatus).toEqual('UNVERIFIED');
    expect(result.fields.recruiterRole).toEqual('hr');
    expect(result.isOwner).toEqual(true);
  });

  it('getLatest returns null when user has no companies_members', async () => {
    prismaMemberFindFirst.mockResolvedValue(null);
    expect(await service.getLatest(99n)).toBeNull();
  });

  it('getOrThrow throws COMPANY_MEMBERSHIP_REQUIRED when user not a member', async () => {
    prismaMemberFindFirst.mockResolvedValue(null);
    try {
      await service.getOrThrow(5n, 12n);
      expect.fail('expected AppError');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(AppErrorCode.COMPANY_MEMBERSHIP_REQUIRED);
    }
  });

  it('getOrThrow returns profile with isOwner=false when member but not owner', async () => {
    const co = makeCompany({ id: 8n });
    prismaMemberFindFirst.mockResolvedValue({
      ...makeMembership({ company_id: co.id, user_id: 3n, company: co }),
      is_owner: false,
      role: 'recruiter',
    });
    const view = await service.getOrThrow(8n, 3n);
    expect(view.id).toEqual(8n);
    expect(view.isOwner).toEqual(false);
    expect(view.verificationStatus).toEqual('UNVERIFIED');
  });
});
