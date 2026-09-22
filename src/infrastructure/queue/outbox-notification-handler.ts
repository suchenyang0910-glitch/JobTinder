// Outbox Notification handler abstraction. Stage-1 has MockOutboxNotificationHandler
// which always returns success (no-ops with a structured log). Stage-2 will bind
// real transports: TelegramBotSendHandler, EmailSendHandler, etc.
//
// Handlers MUST be side-effect free on errors: if they throw, OutboxWorker will
// increment attempts and either schedule a retry or mark the row as DEAD.

import type { NotificationType } from '@prisma/client';
import type { Prisma } from '@prisma/client';

export interface OutboxNotificationResult {
  ok: boolean;
  /** opaque delivery id, forwarded to outbox.note_succeeded (e.g. telegram msg id) */
  externalRef?: string;
  /** short, safe-for-audit description, not PII */
  summary?: string;
  errorCode?: string;
  errorDesc?: string;
  retryAfterMs?: number;
}

export type OutboxRow = {
  id: bigint | number | string;
  type: NotificationType;
  recipient_id: bigint | number | string;
  dedupe_key: string | null;
  payload: Prisma.JsonValue | null;
  attempts: number;
  max_attempts: number;
};

export abstract class OutboxNotificationHandler {
  /**
   * Stage-2: dispatch the notification to its real transport.
   * Return {ok:true} on success. Return {ok:false} if the call is expected to
   * fail (e.g. blocked user), not a transient network error. Throw only on
   * transient errors that should trigger retry/DEAD logic.
   */
  abstract dispatch(row: Readonly<OutboxRow>): Promise<OutboxNotificationResult>;
}

export const NOTIFY_HANDLER_TOKEN = Symbol('NOTIFY_HANDLER_TOKEN');
