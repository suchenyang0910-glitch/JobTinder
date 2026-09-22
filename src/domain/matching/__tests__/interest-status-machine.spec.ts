import { describe, it, expect } from 'vitest';
import {
  interestStatusTransition,
  isInterestActionable,
  isInterestTerminal,
  type InterestStatus,
} from '@src/domain/matching/interest-status-machine';

const NOW = new Date('2026-09-21T12:00:00Z');

function run(from: InterestStatus, eventType: string): InterestStatus {
  switch (eventType) {
    case 'ACCEPT':
      return interestStatusTransition(from, { type: 'ACCEPT', now: NOW });
    case 'DECLINE':
      return interestStatusTransition(from, { type: 'DECLINE', now: NOW });
    case 'WITHDRAW':
      return interestStatusTransition(from, { type: 'WITHDRAW', now: NOW });
    case 'EXPIRE_PAUSE_72H':
      return interestStatusTransition(from, { type: 'EXPIRE_PAUSE_72H', now: NOW });
    case 'INVALIDATE':
      return interestStatusTransition(from, { type: 'INVALIDATE', reason: 'JOB_CLOSED' });
    case 'MARK_MATCHED':
      return interestStatusTransition(from, { type: 'MARK_MATCHED' });
    default:
      throw new Error(`bad event ${eventType}`);
  }
}

describe('interestStatusTransition', () => {
  it('pending → accepted → matched', () => {
    const s1 = run('PENDING', 'ACCEPT');
    expect(s1).toBe('ACCEPTED');
    expect(run(s1, 'MARK_MATCHED')).toBe('MATCHED');
  });

  it('pending terminal states', () => {
    expect(run('PENDING', 'DECLINE')).toBe('DECLINED');
    expect(run('PENDING', 'WITHDRAW')).toBe('WITHDRAWN');
    expect(run('PENDING', 'EXPIRE_PAUSE_72H')).toBe('EXPIRED');
    expect(run('PENDING', 'INVALIDATE')).toBe('INVALIDATED');
  });

  it('accepted can still be invalidated (job closed before match)', () => {
    expect(run('ACCEPTED', 'INVALIDATE')).toBe('INVALIDATED');
  });

  it('throws for already-declined', () => {
    expect(() => run('DECLINED', 'ACCEPT')).toThrow();
    expect(() => run('EXPIRED', 'ACCEPT')).toThrow();
    expect(() => run('MATCHED', 'DECLINE')).toThrow();
  });
});

describe('interest predicates', () => {
  it('isInterestActionable only on PENDING', () => {
    expect(isInterestActionable('PENDING')).toBe(true);
    (['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'INVALIDATED', 'MATCHED'] as const).forEach(
      (s) => {
        expect(isInterestActionable(s)).toBe(false);
      },
    );
  });

  it('isInterestTerminal', () => {
    expect(isInterestTerminal('MATCHED')).toBe(true);
    expect(isInterestTerminal('PENDING')).toBe(false);
  });
});
