import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import type { SourceReviewStatus as PrismaStatus } from '@prisma/client';

export type SourceReviewStatusValue = PrismaStatus;

export const SOURCE_TYPE_LABELS = {
  OFFICIAL_COMPANY_WEBSITE: '企业官网',
  GOVERNMENT_JOB_PORTAL: '政府就业平台',
  CHAMBER_DIRECTORY: '商会目录',
  THIRD_PARTY_JOB_BOARD: '第三方招聘平台',
  SOCIAL_PAGE: '社交媒体页面',
} as const;

export type SourceType = keyof typeof SOURCE_TYPE_LABELS;

export const VALID_SOURCE_TYPES = new Set<SourceType>([
  'OFFICIAL_COMPANY_WEBSITE',
  'GOVERNMENT_JOB_PORTAL',
  'CHAMBER_DIRECTORY',
  'THIRD_PARTY_JOB_BOARD',
  'SOCIAL_PAGE',
]);

export interface SourceReviewTransition {
  from: SourceReviewStatusValue;
  to: Exclude<SourceReviewStatusValue, never>;
  reasonRequired?: boolean;
}

export const SOURCE_REVIEW_STATUS_TRANSITIONS: Record<
  SourceReviewStatusValue,
  SourceReviewStatusValue[]
> = {
  PENDING: ['APPROVED', 'REJECTED', 'SUSPENDED'],
  APPROVED: ['SUSPENDED', 'REJECTED', 'PENDING'],
  REJECTED: ['PENDING', 'APPROVED'],
  SUSPENDED: ['PENDING', 'APPROVED', 'REJECTED'],
};

export function canSourceReviewTransition(
  from: SourceReviewStatusValue,
  to: SourceReviewStatusValue,
): boolean {
  return SOURCE_REVIEW_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertSourceReviewTransition(
  from: SourceReviewStatusValue,
  to: SourceReviewStatusValue,
): void {
  if (!canSourceReviewTransition(from, to)) {
    throw new AppError({
      code: AppErrorCode.CRAWL_SOURCE_REVIEW_INVALID_TRANSITION,
      message: `Invalid source review transition: ${from} -> ${to}`,
    });
  }
}

export const SOURCE_VERIFICATION_WEIGHTS = Object.freeze({
  COMPANY_NAME_MATCH: 20,
  DOMAIN_MATCH: 20,
  ADDRESS_MATCH: 15,
  CONTACT_MATCH: 15,
  JOB_PAGE_PRESENT: 15,
  ROBOTS_ALLOWED: 10,
  RECENT_UPDATE: 5,
} as const);

export interface SourceVerificationBreakdown {
  companyNameMatch: boolean;
  domainMatch: boolean;
  addressMatch: boolean;
  contactMatch: boolean;
  jobPagePresent: boolean;
  robotsAllowed: boolean;
  recentUpdate: boolean;
}

export function computeSourceVerificationScore(b: SourceVerificationBreakdown): {
  score: number;
  breakdown: Record<string, { passed: boolean; weight: number }>;
} {
  const weights = SOURCE_VERIFICATION_WEIGHTS;
  const scoreMatrix = {
    companyNameMatch: { passed: b.companyNameMatch, weight: weights.COMPANY_NAME_MATCH },
    domainMatch: { passed: b.domainMatch, weight: weights.DOMAIN_MATCH },
    addressMatch: { passed: b.addressMatch, weight: weights.ADDRESS_MATCH },
    contactMatch: { passed: b.contactMatch, weight: weights.CONTACT_MATCH },
    jobPagePresent: { passed: b.jobPagePresent, weight: weights.JOB_PAGE_PRESENT },
    robotsAllowed: { passed: b.robotsAllowed, weight: weights.ROBOTS_ALLOWED },
    recentUpdate: { passed: b.recentUpdate, weight: weights.RECENT_UPDATE },
  };
  const score = Object.values(scoreMatrix).reduce(
    (acc, row) => acc + (row.passed ? row.weight : 0),
    0,
  );
  return { score, breakdown: scoreMatrix };
}

export type SourceVerificationBand = 'SUBMITTABLE' | 'MANUAL_REVIEW_REQUIRED' | 'REJECT';
export function bandForSourceVerificationScore(score: number): SourceVerificationBand {
  if (score >= 80) return 'SUBMITTABLE';
  if (score >= 60) return 'MANUAL_REVIEW_REQUIRED';
  return 'REJECT';
}
