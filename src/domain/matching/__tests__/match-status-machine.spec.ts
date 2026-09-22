import { describe, it, expect } from 'vitest';
import {
  matchStatusTransition,
  isContactReleasable,
  isMatchActive,
  type MatchStatus,
} from '@src/domain/matching/match-status-machine';

function run(from: MatchStatus, eventType: string): MatchStatus {
  switch (eventType) {
    case 'OPEN_CONTACT':
      return matchStatusTransition(from, { type: 'OPEN_CONTACT' });
    case 'END':
      return matchStatusTransition(from, { type: 'END', reason: 'FILLED' });
    case 'BLOCK':
      return matchStatusTransition(from, { type: 'BLOCK', actorSide: 'CANDIDATE' });
    case 'REQUEST_RECONFIRMATION':
      return matchStatusTransition(from, { type: 'REQUEST_RECONFIRMATION', cause: 'JOB_UPDATED' });
    case 'RECONFIRM':
      return matchStatusTransition(from, { type: 'RECONFIRM' });
    default:
      throw new Error(`bad event ${eventType}`);
  }
}

describe('matchStatusTransition', () => {
  it('stage-1 default path: MATCHED → CONTACT_AVAILABLE (immediate open)', () => {
    expect(run('MATCHED', 'OPEN_CONTACT')).toBe('CONTACT_AVAILABLE');
  });

  it('end and block from active', () => {
    expect(run('CONTACT_AVAILABLE', 'END')).toBe('ENDED');
    expect(run('CONTACT_AVAILABLE', 'BLOCK')).toBe('BLOCKED');
  });

  it('reconfirmation flow', () => {
    const s1 = run('CONTACT_AVAILABLE', 'REQUEST_RECONFIRMATION');
    expect(s1).toBe('NEEDS_RECONFIRMATION');
    expect(run(s1, 'RECONFIRM')).toBe('CONTACT_AVAILABLE');
    expect(run(s1, 'END')).toBe('ENDED');
  });

  it('BLOCKED is terminal', () => {
    expect(() => run('BLOCKED', 'RECONFIRM')).toThrow();
    expect(() => run('BLOCKED', 'END')).toThrow();
  });

  it('ENDED is terminal', () => {
    expect(() => run('ENDED', 'OPEN_CONTACT')).toThrow();
  });
});

describe('match predicates', () => {
  it('isContactReleasable only when CONTACT_AVAILABLE', () => {
    expect(isContactReleasable('CONTACT_AVAILABLE')).toBe(true);
    expect(isContactReleasable('MATCHED')).toBe(false);
    expect(isContactReleasable('BLOCKED')).toBe(false);
    expect(isContactReleasable('ENDED')).toBe(false);
  });

  it('isMatchActive covers CONTACT_AVAILABLE and NEEDS_RECONFIRMATION', () => {
    expect(isMatchActive('CONTACT_AVAILABLE')).toBe(true);
    expect(isMatchActive('NEEDS_RECONFIRMATION')).toBe(true);
    expect(isMatchActive('MATCHED')).toBe(false);
    expect(isMatchActive('ENDED')).toBe(false);
  });
});
