import { describe, it, expect } from 'vitest';
import {
  CRAWL_JOB_STATUS_TRANSITIONS,
  canTransitionCrawlJob,
  assertCrawlJobTransition,
  isPublishable,
  isVisibleToMatches,
  type CrawlJobStatusValue,
} from '@src/domain/crawler/crawl-job-status-machine';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';

const ALL_STATUSES: CrawlJobStatusValue[] = [
  'DISCOVERED',
  'FETCHED',
  'PARSED',
  'TRANSLATED',
  'QA_PENDING',
  'REVIEW_REQUIRED',
  'APPROVED',
  'REJECTED',
  'PUBLISHED',
  'STALE',
];

describe('CrawlJobStatus machine (§ transitions + §15 visibility)', () => {
  it('declares exactly 10 statuses with STALE included (10 total keys)', () => {
    expect(Object.keys(CRAWL_JOB_STATUS_TRANSITIONS)).toHaveLength(10);
  });

  it('DISCOVERED → FETCHED / REJECTED / STALE allowed, disallows QA_PENDING', () => {
    expect(canTransitionCrawlJob('DISCOVERED', 'FETCHED')).toBe(true);
    expect(canTransitionCrawlJob('DISCOVERED', 'REJECTED')).toBe(true);
    expect(canTransitionCrawlJob('DISCOVERED', 'STALE')).toBe(true);
    expect(canTransitionCrawlJob('DISCOVERED', 'QA_PENDING')).toBe(false);
  });

  it('QA_PENDING → APPROVED / REVIEW_REQUIRED / REJECTED / STALE allowed', () => {
    expect(canTransitionCrawlJob('QA_PENDING', 'APPROVED')).toBe(true);
    expect(canTransitionCrawlJob('QA_PENDING', 'REVIEW_REQUIRED')).toBe(true);
    expect(canTransitionCrawlJob('QA_PENDING', 'REJECTED')).toBe(true);
    expect(canTransitionCrawlJob('QA_PENDING', 'STALE')).toBe(true);
    expect(canTransitionCrawlJob('QA_PENDING', 'PUBLISHED')).toBe(false);
  });

  it('REVIEW_REQUIRED → APPROVED / REJECTED / TRANSLATED (retry translation) / STALE allowed', () => {
    expect(canTransitionCrawlJob('REVIEW_REQUIRED', 'APPROVED')).toBe(true);
    expect(canTransitionCrawlJob('REVIEW_REQUIRED', 'REJECTED')).toBe(true);
    expect(canTransitionCrawlJob('REVIEW_REQUIRED', 'TRANSLATED')).toBe(true);
    expect(canTransitionCrawlJob('REVIEW_REQUIRED', 'STALE')).toBe(true);
  });

  it('APPROVED → PUBLISHED / STALE only (not to REJECTED)', () => {
    expect(canTransitionCrawlJob('APPROVED', 'PUBLISHED')).toBe(true);
    expect(canTransitionCrawlJob('APPROVED', 'STALE')).toBe(true);
    expect(canTransitionCrawlJob('APPROVED', 'REJECTED')).toBe(false);
    expect(canTransitionCrawlJob('APPROVED', 'QA_PENDING')).toBe(false);
  });

  it('PUBLISHED → STALE only', () => {
    expect(canTransitionCrawlJob('PUBLISHED', 'STALE')).toBe(true);
    const otherStatuses = ALL_STATUSES.filter((x) => x !== 'STALE');
    for (const s of otherStatuses) {
      if (s === 'PUBLISHED') {
        expect(canTransitionCrawlJob('PUBLISHED', s)).toBe(false);
      } else {
        expect(canTransitionCrawlJob('PUBLISHED', s)).toBe(false);
      }
    }
  });

  it('REJECTED & STALE are terminal (no outgoing transitions)', () => {
    for (const s of ALL_STATUSES) {
      expect(canTransitionCrawlJob('REJECTED', s)).toBe(false);
      expect(canTransitionCrawlJob('STALE', s)).toBe(false);
    }
  });

  it('assertCrawlJobTransition throws AppError CRAWL_INVALID_STATUS_TRANSITION on illegal', () => {
    let caught: AppError | null = null;
    try {
      assertCrawlJobTransition('REJECTED', 'APPROVED');
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.code).toBe(AppErrorCode.CRAWL_INVALID_STATUS_TRANSITION);

    let caught2: AppError | null = null;
    try {
      assertCrawlJobTransition('APPROVED', 'FETCHED');
    } catch (e) {
      caught2 = e as AppError;
    }
    expect(caught2).toBeInstanceOf(AppError);
  });

  it('assertCrawlJobTransition does not throw on legal', () => {
    expect(() => assertCrawlJobTransition('PARSED', 'TRANSLATED')).not.toThrow();
    expect(() => assertCrawlJobTransition('QA_PENDING', 'APPROVED')).not.toThrow();
  });

  it('§15 isPublishable (APPROVED/PUBLISHED returns true; others false)', () => {
    expect(isPublishable('APPROVED')).toBe(true);
    expect(isPublishable('PUBLISHED')).toBe(true);
    for (const s of ALL_STATUSES.filter((x) => x !== 'APPROVED' && x !== 'PUBLISHED')) {
      const got = isPublishable(s);
      expect(got).toBe(false);
      if (got !== false) throw new Error(`status=${s} expected isPublishable=false got ${got}`);
    }
  });

  it('§15 isVisibleToMatches (only PUBLISHED enters recommendation/matches)', () => {
    expect(isVisibleToMatches('PUBLISHED')).toBe(true);
    for (const s of ALL_STATUSES.filter((x) => x !== 'PUBLISHED')) {
      const got = isVisibleToMatches(s);
      expect(got).toBe(false);
      if (got !== false)
        throw new Error(`status=${s} expected isVisibleToMatches=false got ${got}`);
    }
  });
});
