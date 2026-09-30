import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResumeDocxRenderer } from '../resume-docx-renderer';

describe('ResumeDocxRenderer', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.RESUME_STORAGE_DIR;
  });

  it.each(['en', 'zh_CN', 'km'] as const)(
    'writes a valid non-empty %s DOCX and reports its hash and size',
    async (language) => {
      dir = await mkdtemp(path.join(tmpdir(), 'jobtinder-resume-'));
      process.env.RESUME_STORAGE_DIR = dir;
      const renderer = new ResumeDocxRenderer();
      await renderer.onModuleInit();
      const result = await renderer.render(
        {
          fullName: 'Test User',
          headline: null,
          summary: null,
          phone: null,
          email: null,
          location: null,
          targetRoles: [],
          experiences: [],
          education: [],
          skills: [],
          languages: [],
          certificates: [],
          warnings: [],
          sourceLanguage: 'en',
        },
        7n,
        1,
        language,
      );
      const bytes = await readFile(result.filePath);
      expect(bytes.subarray(0, 2).toString()).toBe('PK');
      expect(result.sizeBytes).toBe(bytes.length);
      expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(path.basename(result.filePath)).toBe('JobTinder-Resume-7-v1.docx');
    },
  );
});
