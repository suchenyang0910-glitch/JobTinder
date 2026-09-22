// Match status machine (pure)
// Rule: matched → contact_available → ended / blocked / needs_reconfirmation
// Stage-1: default Match creation lands directly at CONTACT_AVAILABLE (per doc)

export type MatchStatus =
  'MATCHED' | 'CONTACT_AVAILABLE' | 'ENDED' | 'BLOCKED' | 'NEEDS_RECONFIRMATION';

export type MatchEvent =
  | { type: 'OPEN_CONTACT' } // auto happens when match created (stage-1 default)
  | { type: 'END'; reason: 'FILLED' | 'NOT_INTERESTED' | 'OTHER' }
  | { type: 'BLOCK'; actorSide: 'CANDIDATE' | 'COMPANY' }
  | { type: 'REQUEST_RECONFIRMATION'; cause: 'JOB_UPDATED' | 'PROFILE_UPDATED' | 'TIMEOUT' }
  | { type: 'RECONFIRM' };

export function matchStatusTransition(current: MatchStatus, event: MatchEvent): MatchStatus {
  switch (event.type) {
    case 'OPEN_CONTACT':
      assertIn(current, ['MATCHED']);
      return 'CONTACT_AVAILABLE';
    case 'END':
      assertIn(current, ['CONTACT_AVAILABLE', 'MATCHED', 'NEEDS_RECONFIRMATION']);
      return 'ENDED';
    case 'BLOCK':
      assertIn(current, ['CONTACT_AVAILABLE', 'MATCHED', 'NEEDS_RECONFIRMATION']);
      return 'BLOCKED';
    case 'REQUEST_RECONFIRMATION':
      assertIn(current, ['CONTACT_AVAILABLE']);
      return 'NEEDS_RECONFIRMATION';
    case 'RECONFIRM':
      assertIn(current, ['NEEDS_RECONFIRMATION']);
      return 'CONTACT_AVAILABLE';
  }
}

export function isMatchActive(s: MatchStatus): boolean {
  return s === 'CONTACT_AVAILABLE' || s === 'NEEDS_RECONFIRMATION';
}

export function isContactReleasable(s: MatchStatus): boolean {
  return s === 'CONTACT_AVAILABLE';
}

function assertIn<T>(actual: T, allowed: readonly T[]): void {
  if (!allowed.includes(actual)) {
    throw new Error(
      `Match transition invalid: from ${JSON.stringify(actual)} not in [${allowed.map(String).join(', ')}]`,
    );
  }
}
