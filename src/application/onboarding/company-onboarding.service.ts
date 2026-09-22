// Stage-1 skeleton of company (recruiter-side) onboarding.
// Model shape follows prisma/schema.prisma:
//   companies: id, name, website, description, verification_status, verified_at.
//   companies_members: company_id + user_id (N:M, role/is_owner/joined_at).
// Stage-1 only implements non-nullable scaffolding — no versioning, no audit, no
// outbox, all coming in stage-2 when mirroring CandidateOnboardingService.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { CLOCK_TOKEN } from '@src/shared/clock/clock';
import type { Clock } from '@src/shared/clock/clock';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import type { VerifiedStatus } from '@prisma/client';

export interface CompanyDraftFields {
  name?: string;
  industry?: string;
  size?: string;
  location?: string;
  website?: string;
  description?: string;
  recruiterName?: string;
  recruiterRole?: string;
}

export interface CreateCompanyDraftInput {
  userId: bigint | number;
  initialFields?: CompanyDraftFields;
  source: 'manual' | 'ai' | 'mock';
}

export interface CompanyProfileView {
  id: bigint;
  fields: CompanyDraftFields;
  verificationStatus: VerifiedStatus;
  createdAt: Date;
  verifiedAt?: Date;
  /** True if the user owns a companies_members row with is_owner=true for this company */
  isOwner: boolean;
}

@Injectable()
export class CompanyOnboardingService {
  private readonly logger = new Logger(CompanyOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  /**
   * Stage-1: if user already owns a company (companies_members.is_owner=true)
   * return it. Otherwise create a new UNVERIFIED company + a membership row
   * with is_owner=true.
   */
  async createDraft(input: CreateCompanyDraftInput): Promise<CompanyProfileView> {
    const userId = BigInt(input.userId);
    const existing = await this.getLatest(userId);
    if (existing) return existing;

    const f = input.initialFields ?? {};
    const now = this.clock.now();

    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.companies.create({
        data: {
          name: f.name ?? `Untitled company (user ${userId.toString()})`,
          website: f.website ?? null,
          description: f.description ?? null,
          verification_status: 'UNVERIFIED',
          created_at: now,
        },
      });
      await tx.companies_members.create({
        data: {
          company_id: created.id,
          user_id: userId,
          role: f.recruiterRole ?? 'owner',
          is_owner: true,
          joined_at: now,
        },
      });
      return created;
    });

    this.logger.log(
      `[company-draft] created id=${String(result.id)} owner=${String(userId)} source=${input.source}`,
    );
    return {
      id: result.id,
      fields: {
        name: result.name ?? undefined,
        website: result.website ?? undefined,
        description: result.description ?? undefined,
        industry: f.industry,
        size: f.size,
        location: f.location,
        recruiterName: f.recruiterName,
        recruiterRole: f.recruiterRole ?? 'owner',
      },
      verificationStatus: result.verification_status,
      createdAt: result.created_at,
      verifiedAt: result.verified_at ?? undefined,
      isOwner: true,
    };
  }

  async getLatest(userId: bigint | number): Promise<CompanyProfileView | null> {
    const membership = await this.prisma.companies_members.findFirst({
      where: { user_id: BigInt(userId), is_owner: true },
      include: { company: true },
      orderBy: { joined_at: 'desc' },
    });
    if (!membership) return null;
    const c = membership.company;
    return {
      id: c.id,
      fields: {
        name: c.name ?? undefined,
        website: c.website ?? undefined,
        description: c.description ?? undefined,
      },
      verificationStatus: c.verification_status,
      createdAt: c.created_at,
      verifiedAt: c.verified_at ?? undefined,
      isOwner: membership.is_owner,
    };
  }

  async getOrThrow(id: bigint | number, userId: bigint | number): Promise<CompanyProfileView> {
    const membership = await this.prisma.companies_members.findFirst({
      where: { company_id: BigInt(id), user_id: BigInt(userId) },
      include: { company: true },
    });
    if (!membership || !membership.company) {
      throw new AppError({ code: AppErrorCode.COMPANY_MEMBERSHIP_REQUIRED });
    }
    const c = membership.company;
    return {
      id: c.id,
      fields: {
        name: c.name ?? undefined,
        website: c.website ?? undefined,
        description: c.description ?? undefined,
      },
      verificationStatus: c.verification_status,
      createdAt: c.created_at,
      verifiedAt: c.verified_at ?? undefined,
      isOwner: membership.is_owner,
    };
  }
}
