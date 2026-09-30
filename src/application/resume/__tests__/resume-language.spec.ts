import { describe, expect, it, vi } from 'vitest';
import { ResumeLanguageService } from '../resume-language.service';

describe('ResumeLanguageService', () => {
  it('accepts only exact supported language tokens', async () => {
    const ai = { callRawPrompt: vi.fn().mockResolvedValue('"zh_CN"') };
    const service = new ResumeLanguageService(ai as never);
    await expect(service.detect('我曾在金边从事运营工作')).resolves.toBe('zh_CN');
    ai.callRawPrompt.mockResolvedValueOnce('english');
    await expect(service.detect('Some resume text')).resolves.toBe('mixed');
  });
});
