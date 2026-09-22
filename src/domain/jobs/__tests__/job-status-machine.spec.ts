import { describe, it, expect } from 'vitest';
import {
  jobStatusTransition,
  isJobVisibleInRecommendations,
  isJobClaimable,
  type JobEvent,
  type JobStatus,
} from '@src/domain/jobs/job-status-machine';

type Case = { from: JobStatus; event: JobEvent; expected: JobStatus | 'throws' };

const cases: Case[] = [
  { from: 'DRAFT', event: { type: 'SUBMIT_FOR_REVIEW' }, expected: 'PENDING_REVIEW' },
  { from: 'PENDING_REVIEW', event: { type: 'APPROVE_AS_EXTERNAL' }, expected: 'ACTIVE_EXTERNAL' },
  { from: 'PENDING_REVIEW', event: { type: 'APPROVE_AS_CLAIMED' }, expected: 'ACTIVE_CLAIMED' },
  { from: 'ACTIVE_EXTERNAL', event: { type: 'CLAIM_FROM_EXTERNAL' }, expected: 'ACTIVE_CLAIMED' },
  { from: 'NEEDS_REVIEW', event: { type: 'CLAIM_FROM_EXTERNAL' }, expected: 'ACTIVE_CLAIMED' },
  { from: 'ACTIVE_EXTERNAL', event: { type: 'MARK_AS_NEEDS_REVIEW' }, expected: 'NEEDS_REVIEW' },
  { from: 'ACTIVE_EXTERNAL', event: { type: 'PAUSE', reason: 'MANUAL' }, expected: 'PAUSED' },
  { from: 'ACTIVE_CLAIMED', event: { type: 'PAUSE', reason: 'MANUAL' }, expected: 'PAUSED' },
  { from: 'PAUSED', event: { type: 'RESUME' }, expected: 'ACTIVE_EXTERNAL' },
  { from: 'PAUSED', event: { type: 'CLOSE', reason: 'MANUAL' }, expected: 'CLOSED' },
  { from: 'ACTIVE_CLAIMED', event: { type: 'CLOSE', reason: 'MANUAL' }, expected: 'CLOSED' },
  { from: 'CLOSED', event: { type: 'SUBMIT_FOR_REVIEW' }, expected: 'throws' },
  { from: 'CLOSED', event: { type: 'RESUME' }, expected: 'throws' },
  { from: 'ACTIVE_EXTERNAL', event: { type: 'APPROVE_AS_CLAIMED' }, expected: 'throws' },
];

describe('jobStatusTransition', () => {
  for (const c of cases) {
    it(`${c.from} + ${c.event.type} → ${c.expected}`, () => {
      if (c.expected === 'throws') {
        expect(() => jobStatusTransition(c.from, c.event)).toThrow();
      } else {
        expect(jobStatusTransition(c.from, c.event)).toBe(c.expected);
      }
    });
  }
});

describe('job predicates', () => {
  it('isJobVisibleInRecommendations only active states', () => {
    expect(isJobVisibleInRecommendations('ACTIVE_EXTERNAL')).toBe(true);
    expect(isJobVisibleInRecommendations('ACTIVE_CLAIMED')).toBe(true);
    (['PAUSED', 'NEEDS_REVIEW', 'CLOSED', 'DRAFT', 'PENDING_REVIEW'] as JobStatus[]).forEach(
      (s) => {
        expect(isJobVisibleInRecommendations(s)).toBe(false);
      },
    );
  });
  it('isJobClaimable external/review states', () => {
    expect(isJobClaimable('ACTIVE_EXTERNAL')).toBe(true);
    expect(isJobClaimable('NEEDS_REVIEW')).toBe(true);
    expect(isJobClaimable('ACTIVE_CLAIMED')).toBe(false);
    expect(isJobClaimable('PAUSED')).toBe(false);
  });
});
