// Job status machine (pure, no side effects)
// Transition rule from doc: draft → pending_review → active_external / active_claimed → paused → closed
// Additional: active_external → needs_review (crawl failure, NOT closed)

export type JobStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'ACTIVE_EXTERNAL'
  | 'ACTIVE_CLAIMED'
  | 'NEEDS_REVIEW'
  | 'PAUSED'
  | 'CLOSED';

export type JobEvent =
  | { type: 'SUBMIT_FOR_REVIEW' }
  | { type: 'APPROVE_AS_EXTERNAL' }
  | { type: 'APPROVE_AS_CLAIMED' }
  | { type: 'CLAIM_FROM_EXTERNAL' }
  | { type: 'MARK_AS_NEEDS_REVIEW' }
  | { type: 'PAUSE'; reason?: 'MANUAL' | 'INACTIVITY_72H' }
  | { type: 'RESUME' }
  | { type: 'CLOSE'; reason: 'MANUAL' | 'EXPIRED' | 'FILLED' };

export function jobStatusTransition(current: JobStatus, event: JobEvent): JobStatus {
  switch (event.type) {
    case 'SUBMIT_FOR_REVIEW':
      assertIn(current, ['DRAFT', 'NEEDS_REVIEW', 'PAUSED']);
      return 'PENDING_REVIEW';
    case 'APPROVE_AS_EXTERNAL':
      assertIn(current, ['PENDING_REVIEW']);
      return 'ACTIVE_EXTERNAL';
    case 'APPROVE_AS_CLAIMED':
      assertIn(current, ['PENDING_REVIEW']);
      return 'ACTIVE_CLAIMED';
    case 'CLAIM_FROM_EXTERNAL':
      assertIn(current, ['ACTIVE_EXTERNAL', 'NEEDS_REVIEW']);
      return 'ACTIVE_CLAIMED';
    case 'MARK_AS_NEEDS_REVIEW':
      assertIn(current, ['ACTIVE_EXTERNAL', 'ACTIVE_CLAIMED', 'PAUSED']);
      return 'NEEDS_REVIEW';
    case 'PAUSE':
      assertIn(current, ['ACTIVE_EXTERNAL', 'ACTIVE_CLAIMED', 'NEEDS_REVIEW', 'PENDING_REVIEW']);
      return 'PAUSED';
    case 'RESUME':
      assertIn(current, ['PAUSED', 'NEEDS_REVIEW']);
      return current === 'PAUSED' || current === 'NEEDS_REVIEW' ? 'ACTIVE_EXTERNAL' : current;
    case 'CLOSE':
      assertIn(current, [
        'DRAFT',
        'PENDING_REVIEW',
        'ACTIVE_EXTERNAL',
        'ACTIVE_CLAIMED',
        'NEEDS_REVIEW',
        'PAUSED',
      ]);
      return 'CLOSED';
  }
}

export function isJobVisibleInRecommendations(s: JobStatus): boolean {
  return s === 'ACTIVE_EXTERNAL' || s === 'ACTIVE_CLAIMED';
}

export function isJobClaimable(s: JobStatus): boolean {
  return s === 'ACTIVE_EXTERNAL' || s === 'NEEDS_REVIEW';
}

function assertIn<T>(actual: T, allowed: readonly T[]): void {
  if (!allowed.includes(actual)) {
    throw new Error(
      `Job status transition invalid: from ${JSON.stringify(actual)} not in [${allowed.map(String).join(', ')}]`,
    );
  }
}
