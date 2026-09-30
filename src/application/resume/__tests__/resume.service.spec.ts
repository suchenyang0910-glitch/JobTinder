import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ResumeService } from '../resume.service';

const makeService = (doc: Record<string, unknown> | null) => {
  const prisma = {
    resume_documents: {
      findUnique: vi.fn().mockResolvedValue(doc),
      create: vi.fn().mockResolvedValue({ id: 9n, user_id: 3n, status: 'DRAFT' }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  const audits = { record: vi.fn().mockResolvedValue(undefined) };
  const ai = { extractDraft: vi.fn() };
  const language = { detect: vi.fn().mockResolvedValue('en') };
  const renderer = { render: vi.fn() };
  return {
    service: new ResumeService(
      prisma as never,
      audits as never,
      ai as never,
      language as never,
      renderer as never,
    ),
    prisma,
    ai,
    renderer,
  };
};

describe('ResumeService', () => {
  it('refuses a second free resume for the same user', async () => {
    const { service, prisma } = makeService({ id: 9n, status: 'READY' });
    await expect(
      service.createDraft(3n, 'A sufficiently detailed resume input'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.resume_documents.create).not.toHaveBeenCalled();
  });

  it('does not render if another request already claimed generation', async () => {
    const { service, prisma, renderer } = makeService({
      id: 9n,
      user_id: 3n,
      status: 'DRAFT',
      generation_version: 1,
      structured_json: {},
    });
    await expect(service.confirmAndGenerate(3n)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.resume_documents.updateMany).toHaveBeenCalledOnce();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('releases quota when deleting an ungenerated draft but keeps the limit after generation', async () => {
    const pending = makeService({ id: 9n, user_id: 3n, status: 'DRAFT', file_path: null });
    await expect(pending.service.delete(3n)).resolves.toBe(false);
    expect(pending.prisma.resume_documents.delete).toHaveBeenCalledOnce();

    const ready = makeService({ id: 9n, user_id: 3n, status: 'READY', file_path: null });
    await expect(ready.service.delete(3n)).resolves.toBe(true);
    expect(ready.prisma.resume_documents.update).toHaveBeenCalledOnce();
  });
});
