import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResumeDraftZod } from '../resume.schema';

describe('ResumeDraftZod', () => {
  it('should parse valid resume and provide defaults', () => {
    const res = ResumeDraftZod.parse({ fullName: 'John' });
    expect(res.fullName).toBe('John');
    expect(res.skills).toEqual([]);
    expect(res.experiences).toEqual([]);
  });

  it('should trim or fail on super long fields', () => {
    const longString = 'a'.repeat(300);
    const res = ResumeDraftZod.safeParse({ fullName: longString });
    expect(res.success).toBe(false);
  });
});
