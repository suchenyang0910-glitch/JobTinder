// Interest status machine (pure)
// Rule: pending → accepted → matched
//       pending → declined / withdrawn / invalidated / expired

export type InterestStatus =
  'PENDING' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'INVALIDATED' | 'EXPIRED' | 'MATCHED';

export type InterestEvent =
  | { type: 'ACCEPT'; now: Date }
  | { type: 'DECLINE'; now: Date }
  | { type: 'WITHDRAW'; now: Date }
  | {
      type: 'INVALIDATE';
      reason: 'PROFILE_DELETED' | 'JOB_CLOSED' | 'PROFILE_PAUSED' | 'VERSION_STALE';
    }
  | { type: 'EXPIRE_PAUSE_72H'; now: Date }
  | { type: 'MARK_MATCHED' }; // only via transaction when Match created

export function interestStatusTransition(
  current: InterestStatus,
  event: InterestEvent,
): InterestStatus {
  switch (event.type) {
    case 'ACCEPT':
      assertIn(current, ['PENDING']);
      return 'ACCEPTED';
    case 'DECLINE':
      assertIn(current, ['PENDING']);
      return 'DECLINED';
    case 'WITHDRAW':
      assertIn(current, ['PENDING']);
      return 'WITHDRAWN';
    case 'INVALIDATE':
      assertIn(current, ['PENDING', 'ACCEPTED']);
      return 'INVALIDATED';
    case 'EXPIRE_PAUSE_72H':
      assertIn(current, ['PENDING']);
      return 'EXPIRED';
    case 'MARK_MATCHED':
      assertIn(current, ['ACCEPTED']);
      return 'MATCHED';
  }
}

export function isInterestTerminal(s: InterestStatus): boolean {
  return (
    s === 'DECLINED' ||
    s === 'WITHDRAWN' ||
    s === 'INVALIDATED' ||
    s === 'EXPIRED' ||
    s === 'MATCHED'
  );
}

export function isInterestActionable(s: InterestStatus): boolean {
  return s === 'PENDING';
}

function assertIn<T>(actual: T, allowed: readonly T[]): void {
  if (!allowed.includes(actual)) {
    throw new Error(
      `Interest transition invalid: from ${JSON.stringify(actual)} not in [${allowed.map(String).join(', ')}]`,
    );
  }
}
