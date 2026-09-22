import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';

export const CRAWL_JOB_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  DISCOVERED: ['FETCHED', 'REJECTED', 'STALE'],
  FETCHED: ['PARSED', 'REVIEW_REQUIRED', 'REJECTED', 'STALE'],
  PARSED: ['TRANSLATED', 'REVIEW_REQUIRED', 'REJECTED', 'STALE'],
  TRANSLATED: ['QA_PENDING', 'REVIEW_REQUIRED', 'REJECTED', 'STALE'],
  QA_PENDING: ['APPROVED', 'REVIEW_REQUIRED', 'REJECTED', 'STALE'],
  REVIEW_REQUIRED: ['APPROVED', 'REJECTED', 'TRANSLATED', 'STALE'],
  APPROVED: ['PUBLISHED', 'STALE'],
  REJECTED: [],
  PUBLISHED: ['STALE'],
  STALE: [],
} as const;

export type CrawlJobStatusValue =
  | 'DISCOVERED'
  | 'FETCHED'
  | 'PARSED'
  | 'TRANSLATED'
  | 'QA_PENDING'
  | 'REVIEW_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'PUBLISHED'
  | 'STALE';

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
