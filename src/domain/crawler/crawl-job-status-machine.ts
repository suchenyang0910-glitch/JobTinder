import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';

export const CRAWL_JOB_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  DISCOVERED: ['FETCHED', 'REJECTED', 'STALE', 'DEFERRED'],
  FETCHED: ['PARSED', 'REVIEW_REQUIRED', 'REJECTED', 'STALE', 'DEFERRED'],
  PARSED: ['TRANSLATED', 'REVIEW_REQUIRED', 'REJECTED', 'STALE', 'DEFERRED'],
  TRANSLATED: ['QA_PENDING', 'REVIEW_REQUIRED', 'REJECTED', 'STALE', 'DEFERRED'],
  QA_PENDING: ['APPROVED', 'REVIEW_REQUIRED', 'REJECTED', 'STALE', 'DEFERRED', 'TRANSLATED'],
  REVIEW_REQUIRED: ['APPROVED', 'REJECTED', 'TRANSLATED', 'STALE', 'DEFERRED'],
  DEFERRED: [
    'QA_PENDING',
    'REVIEW_REQUIRED',
    'APPROVED',
    'REJECTED',
    'TRANSLATED',
    'STALE',
    'PAUSED',
    'EXPIRED',
    'CLOSED',
  ],
  APPROVED: ['PUBLISHED', 'STALE', 'PAUSED', 'EXPIRED', 'CLOSED', 'DEFERRED'],
  REJECTED: ['DEFERRED', 'QA_PENDING', 'REVIEW_REQUIRED'],
  PUBLISHED: ['STALE', 'PAUSED', 'EXPIRED', 'CLOSED', 'DEFERRED'],
  PAUSED: ['PUBLISHED', 'STALE', 'EXPIRED', 'CLOSED', 'DEFERRED'],
  STALE: ['CLOSED', 'EXPIRED', 'PUBLISHED', 'DEFERRED'],
  EXPIRED: ['CLOSED', 'PUBLISHED', 'DEFERRED'],
  CLOSED: [],
} as const;

export type CrawlJobStatusValue =
  | 'DISCOVERED'
  | 'FETCHED'
  | 'PARSED'
  | 'TRANSLATED'
  | 'QA_PENDING'
  | 'REVIEW_REQUIRED'
  | 'DEFERRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'PUBLISHED'
  | 'PAUSED'
  | 'STALE'
  | 'EXPIRED'
  | 'CLOSED';

export function canTransitionCrawlJob(from: CrawlJobStatusValue, to: CrawlJobStatusValue): boolean {
  const allowed = CRAWL_JOB_STATUS_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

export function assertCrawlJobTransition(from: CrawlJobStatusValue, to: CrawlJobStatusValue): void {
  if (!canTransitionCrawlJob(from, to)) {
    throw new AppError({
      code: AppErrorCode.CRAWL_INVALID_STATUS_TRANSITION,
      message: `Crawl job status transition ${from} → ${to} is not allowed`,
      metadata: { from, to },
    });
  }
}

export function isPublishable(status: CrawlJobStatusValue): boolean {
  return status === 'APPROVED' || status === 'PUBLISHED';
}

export function isVisibleToMatches(status: CrawlJobStatusValue): boolean {
  return status === 'PUBLISHED';
}

export function isLifecycleTerminal(status: CrawlJobStatusValue): boolean {
  return status === 'CLOSED' || status === 'EXPIRED' || status === 'STALE';
}
