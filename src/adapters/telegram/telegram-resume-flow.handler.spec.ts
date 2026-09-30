import { describe, expect, it, vi } from 'vitest';
import { TelegramResumeFlowHandler } from './telegram-resume-flow.handler';

describe('TelegramResumeFlowHandler', () => {
  it('takes a candidate from /resume through review to a Word document delivery', async () => {
    const draft = {
      id: 7n,
      user_id: 42n,
      status: 'DRAFT',
      output_language: 'en',
      structured_json: {
        fullName: 'Test Candidate',
        headline: 'Retail assistant',
        skills: ['customer service'],
        warnings: [],
      },
      raw_input: 'Test candidate with retail work experience and customer service skills.',
    };
    const prisma = {
      resume_documents: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const resumes = {
      createDraft: vi.fn().mockResolvedValue(draft),
      confirmAndGenerate: vi.fn().mockResolvedValue(undefined),
      getDownloadPath: vi.fn().mockResolvedValue('/tmp/test-resume.docx'),
    };
    const handler = new TelegramResumeFlowHandler(resumes as never, prisma as never);
    const ctx = {
      session: { userId: '42', step: 'IDLE' },
      message: { text: 'Test candidate with retail work experience and customer service skills.' },
      reply: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      replyWithDocument: vi.fn().mockResolvedValue(undefined),
    };

    await handler.handleResumeCommand(ctx as never, {} as never);
    expect(ctx.session.step).toBe('RESUME_AWAIT_TEXT');

    await handler.handleText(ctx as never, {} as never);
    expect(resumes.createDraft).toHaveBeenCalledWith(
      42n,
      'Test candidate with retail work experience and customer service skills.',
    );
    expect(ctx.reply.mock.calls.some(([message]) => String(message).includes('Resume draft'))).toBe(
      true,
    );

    await handler.handleCallback(ctx as never, 'confirm', {} as never);
    expect(resumes.confirmAndGenerate).toHaveBeenCalledWith(42n);
    expect(resumes.getDownloadPath).toHaveBeenCalledWith(42n);
    expect(ctx.replyWithDocument).toHaveBeenCalledOnce();
  });
});
