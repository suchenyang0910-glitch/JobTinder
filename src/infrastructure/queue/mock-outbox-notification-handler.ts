// Mock handler used in stage-1. Always returns {ok: true} without any network call.
// The summary field records "dispatched" with type+recipient_id_hash so audit can
// observe that the pipeline executed. Recipient is hashed (not PII).

import { Logger } from '@nestjs/common';
import {
  OutboxNotificationHandler,
  type OutboxNotificationResult,
  type OutboxRow,
} from './outbox-notification-handler';
import { createHash } from 'node:crypto';

export class MockOutboxNotificationHandler extends OutboxNotificationHandler {
  private readonly logger = new Logger(MockOutboxNotificationHandler.name);

  dispatch(row: Readonly<OutboxRow>): Promise<OutboxNotificationResult> {
    const recipientHash = hash6(String(row.recipient_id));
    const summary = `mock dispatch: type=${row.type} recipient=${recipientHash} attempts=${row.attempts}`;
    this.logger.log(`[notify] ${summary} key=${row.dedupe_key ?? '-'}`);
    return Promise.resolve({
      ok: true,
      externalRef: `mock-${String(row.id)}-${Date.now().toString(36)}`,
      summary,
    });
  }
}

function hash6(plain: string): string {
  return createHash('sha256').update(plain).digest('hex').slice(0, 6);
}
