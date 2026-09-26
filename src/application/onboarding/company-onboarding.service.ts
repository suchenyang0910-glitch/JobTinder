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

export interface CompanyJobDraftInput {
  title: string;
  industry?: string | null;
  tasks?: string[];
  skills?: string[];
  locations?: string[];
  languagesRequired?: string[];
  shifts?: string[];
  salaryStatus?: 'PROVIDED' | 'NOT_PROVIDED' | 'NEGOTIABLE';
  salaryText?: string | null;
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
          industry: f.industry ?? null,
          size: f.size ?? null,
          location: f.location ?? null,
          recruiter_name: f.recruiterName ?? null,
          recruiter_role: f.recruiterRole ?? 'owner',
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
        industry: result.industry ?? f.industry,
        size: result.size ?? f.size,
        location: result.location ?? f.location,
        recruiterName: result.recruiter_name ?? f.recruiterName,
        recruiterRole: result.recruiter_role ?? f.recruiterRole ?? 'owner',
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
        industry: c.industry ?? undefined,
        size: c.size ?? undefined,
        location: c.location ?? undefined,
        recruiterName: c.recruiter_name ?? undefined,
        recruiterRole: c.recruiter_role ?? undefined,
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
        industry: c.industry ?? undefined,
        size: c.size ?? undefined,
        location: c.location ?? undefined,
        recruiterName: c.recruiter_name ?? undefined,
        recruiterRole: c.recruiter_role ?? undefined,
      },
      verificationStatus: c.verification_status,
      createdAt: c.created_at,
      verifiedAt: c.verified_at ?? undefined,
      isOwner: membership.is_owner,
    };
  }

  async updateProfile(
    userId: bigint | number,
    edits: CompanyDraftFields,
  ): Promise<CompanyProfileView> {
    const current = await this.getLatest(userId);
    if (!current || !current.isOwner)
      throw new AppError({ code: AppErrorCode.COMPANY_MEMBERSHIP_REQUIRED });
    const c = await this.prisma.companies.update({
      where: { id: current.id },
      data: {
        ...(edits.name !== undefined ? { name: edits.name } : {}),
        ...(edits.website !== undefined ? { website: edits.website || null } : {}),
        ...(edits.description !== undefined ? { description: edits.description || null } : {}),
        ...(edits.industry !== undefined ? { industry: edits.industry || null } : {}),
        ...(edits.size !== undefined ? { size: edits.size || null } : {}),
        ...(edits.location !== undefined ? { location: edits.location || null } : {}),
        ...(edits.recruiterName !== undefined
          ? { recruiter_name: edits.recruiterName || null }
          : {}),
        ...(edits.recruiterRole !== undefined
          ? { recruiter_role: edits.recruiterRole || null }
          : {}),
      },
    });
    return {
      ...current,
      fields: {
        name: c.name,
        website: c.website ?? undefined,
        description: c.description ?? undefined,
        industry: c.industry ?? undefined,
        size: c.size ?? undefined,
        location: c.location ?? undefined,
        recruiterName: c.recruiter_name ?? undefined,
        recruiterRole: c.recruiter_role ?? undefined,
      },
    };
  }

  async createJobDraft(userId: bigint | number, input: CompanyJobDraftInput) {
    const company = await this.getLatest(userId);
    if (!company || !company.isOwner)
      throw new AppError({ code: AppErrorCode.COMPANY_MEMBERSHIP_REQUIRED });
    return this.prisma.jobs.create({
      data: {
        company_id: company.id,
        source_type: 'CLAIMED',
        status: 'DRAFT',
        title: input.title,
        industry: input.industry ?? null,
        tasks: input.tasks ?? [],
        skills: input.skills ?? [],
        locations: input.locations ?? [],
        languages_required: input.languagesRequired ?? [],
        shifts: input.shifts ?? [],
        salary_status: input.salaryStatus ?? 'NOT_PROVIDED',
        salary_text: input.salaryText ?? null,
      },
    });
  }

  async updateJob(
    userId: bigint | number,
    jobId: bigint | number,
    edits: Partial<CompanyJobDraftInput>,
  ) {
    const company = await this.getLatest(userId);
    const job = await this.prisma.jobs.findFirst({
      where: { id: BigInt(jobId), company_id: company?.id },
    });
    if (!company?.isOwner || !job)
      throw new AppError({ code: AppErrorCode.COMPANY_MEMBERSHIP_REQUIRED });
    return this.prisma.jobs.update({
      where: { id: job.id },
      data: {
        ...(edits.title !== undefined ? { title: edits.title } : {}),
        ...(edits.industry !== undefined ? { industry: edits.industry } : {}),
        ...(edits.tasks !== undefined ? { tasks: edits.tasks } : {}),
        ...(edits.skills !== undefined ? { skills: edits.skills } : {}),
        ...(edits.locations !== undefined ? { locations: edits.locations } : {}),
        ...(edits.languagesRequired !== undefined
          ? { languages_required: edits.languagesRequired }
          : {}),
        ...(edits.shifts !== undefined ? { shifts: edits.shifts } : {}),
        ...(edits.salaryStatus !== undefined ? { salary_status: edits.salaryStatus } : {}),
        ...(edits.salaryText !== undefined ? { salary_text: edits.salaryText } : {}),
        version: { increment: 1 },
      },
    });
  }

  async publishJob(userId: bigint | number, jobId: bigint | number) {
    const company = await this.getLatest(userId);
    const job = await this.prisma.jobs.findFirst({
      where: { id: BigInt(jobId), company_id: company?.id },
    });
    if (!company?.isOwner || !job)
      throw new AppError({ code: AppErrorCode.COMPANY_MEMBERSHIP_REQUIRED });
    return this.prisma.jobs.update({
      where: { id: job.id },
      data: { status: 'ACTIVE_CLAIMED', version: { increment: 1 } },
    });
  }

  async listJobs(userId: bigint | number) {
    const company = await this.getLatest(userId);
    if (!company) return [];
    return this.prisma.jobs.findMany({
      where: { company_id: company.id },
      orderBy: { updated_at: 'desc' },
      take: 20,
    });
  }
}
