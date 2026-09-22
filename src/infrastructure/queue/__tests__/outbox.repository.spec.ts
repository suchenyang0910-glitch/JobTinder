// Unit tests for OutboxRepository DEAD/forceDead/retry transitions.
// No real Postgres — Prisma methods are manually stubbed via a mock PrismaService.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboxRepository } from '@src/infrastructure/queue/outbox.repository';
import type { notifications } from '@prisma/client';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';

type Tx = Parameters<OutboxRepository['markAttemptFailed']>[0];

function buildRow(overrides: Partial<notifications> = {}): notifications {
  return {
    id: 1n,
    dedupe_key: 'demo',
    recipient_id: 100n,
    type: 'PROFILE_CONFIRMED',
    payload: {},
    status: 'PROCESSING',
    attempts: 1,
    max_attempts: 5,
    last_error_code: null,
    last_error_desc: null,
    external_ref: null,
    note_succeeded: null,
    available_after: new Date('2025-01-01T00:00:00Z'),
    created_at: new Date('2025-01-01T00:00:00Z'),
    processed_at: null,
    ...overrides,
  };
}

describe('OutboxRepository markAttemptFailed', () => {
  const clock = new FakeClock(new Date('2025-01-01T00:00:00Z'));
  let lastUpdatePayload: Partial<notifications> | null = null;

  const txStub = {
    notifications: {
      findUnique: vi.fn<(args: unknown) => Promise<notifications | null>>(),
      update: vi.fn((_args: { where: unknown; data: unknown }) => {
        lastUpdatePayload = _args.data as Partial<notifications>;
        return Promise.resolve(buildRow({ status: lastUpdatePayload?.status ?? 'PENDING' }));
      }),
    },
  };
  const prismaStub = {
    notifications: txStub.notifications,
    $transaction: vi.fn(async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
      return fn(txStub as unknown as Tx);
    }),
  };
  const repo = new OutboxRepository(
    prismaStub as unknown as ConstructorParameters<typeof OutboxRepository>[0],
  );

  beforeEach(() => {
    vi.clearAllMocks();
    lastUpdatePayload = null;
  });

  it('marks DEAD when attempts >= maxAttempts after incremented in pollBatch', async () => {
    const row = buildRow({ id: 1n, attempts: 5, max_attempts: 5 });
    txStub.notifications.findUnique.mockResolvedValue(row);

    const status = await repo.markAttemptFailed(txStub as unknown as Tx, row.id, {
      errorCode: 'X_NET',
      errorDesc: 'boom',
      nextAvailableAfter: new Date(clock.now().getTime() + 1000),
      maxAttempts: 5,
      now: clock.now(),
    });

    expect(status).toEqual('DEAD');
    expect(lastUpdatePayload?.status).toEqual('DEAD');
    expect(lastUpdatePayload?.last_error_code).toEqual('X_NET');
    expect(lastUpdatePayload?.processed_at).toEqual(clock.now());
  });

  it('keeps PENDING and bumps available_after if attempts < maxAttempts', async () => {
    const row = buildRow({ id: 2n, attempts: 2, max_attempts: 8 });
    txStub.notifications.findUnique.mockResolvedValue(row);
    const nextDate = new Date(clock.now().getTime() + 4000);

    const status = await repo.markAttemptFailed(txStub as unknown as Tx, row.id, {
      errorCode: 'TRANSIENT',
      errorDesc: 'later',
      nextAvailableAfter: nextDate,
      maxAttempts: 8,
      now: clock.now(),
    });

    expect(status).toEqual('PENDING');
    expect(lastUpdatePayload?.status).toEqual('PENDING');
    expect(lastUpdatePayload?.available_after).toEqual(nextDate);
    expect(lastUpdatePayload?.processed_at).toEqual(null);
  });

  it('forceDead=true instantly marks DEAD regardless of attempts count', async () => {
    const row = buildRow({ id: 3n, attempts: 1, max_attempts: 8 });
    txStub.notifications.findUnique.mockResolvedValue(row);

    const status = await repo.markAttemptFailed(txStub as unknown as Tx, row.id, {
      errorCode: 'LOGIC_FAILED',
      errorDesc: 'handler said nope',
      nextAvailableAfter: new Date(0),
      maxAttempts: 8,
      forceDead: true,
      now: clock.now(),
    });

    expect(status).toEqual('DEAD');
    expect(lastUpdatePayload?.status).toEqual('DEAD');
    expect(lastUpdatePayload?.last_error_code).toEqual('LOGIC_FAILED');
    expect(lastUpdatePayload?.processed_at).toEqual(clock.now());
  });
});
