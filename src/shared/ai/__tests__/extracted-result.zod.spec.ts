import { describe, it, expect } from 'vitest';
import { extractJsonBody, parseCandidateAI, parseJobAI } from '@src/shared/ai/extracted-result.zod';

// ────────────────────────────────────────────────────────────────────────────
// PRD §XII UT-6: 非法 JSON 自动失败
// ────────────────────────────────────────────────────────────────────────────
describe('parseCandidateAI handles malformed AI output safely', () => {
  it('returns ok=false when response is plain text apology', () => {
    const r = parseCandidateAI('Sorry I cannot help with that request.');
    expect(r.ok).toBe(false);
  });

  it('returns ok=false when JSON is missing closing braces', () => {
    const r = parseCandidateAI('{"targetRoles": ["waiter"');
    expect(r.ok).toBe(false);
  });

  it('returns ok=false when salaryStatus is outside enum', () => {
    const r = parseCandidateAI(
      JSON.stringify({ salaryStatus: 'GUARANTEED', targetRoles: [], skills: [] }),
    );
    expect(r.ok).toBe(false);
  });

  it('discards unknown top-level keys (does not throw)', () => {
    const r = parseCandidateAI(
      JSON.stringify({
        targetRoles: ['Waiter'],
        skills: ['Customer service'],
        industries: [],
        taskKeywords: [],
        locations: [],
        languagesKnown: [],
        salaryStatus: 'NOT_PROVIDED',
        salaryText: null,
        availabilityNote: null,
        workExperience: [],
        certifications: [],
        confidence: {},
        unknownFields: [],
        warnings: [],
        SHOULD_NOT_EXIST: 42,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(
        (r.value as unknown as { SHOULD_NOT_EXIST?: number }).SHOULD_NOT_EXIST,
      ).toBeUndefined();
    }
  });

  it('truncates skill items longer than 120 chars to zod default [] via transform or error', () => {
    const long = 'a'.repeat(150);
    const body = JSON.stringify({
      targetRoles: [],
      skills: [long],
      industries: [],
      taskKeywords: [],
      locations: [],
      languagesKnown: [],
      salaryStatus: 'NOT_PROVIDED',
    });
    const r = parseCandidateAI(body);
    // Either fail or strip. Either is fine; the invariant is it never reaches DB
    if (r.ok) {
      expect(r.value.skills.every((s) => s.length <= 120)).toBe(true);
    } else {
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('PRD §XII UT-4: salary NOT_PROVIDED when no explicit salary', () => {
    const body = JSON.stringify({
      targetRoles: ['waiter'],
      skills: [],
      industries: [],
      taskKeywords: [],
      locations: [],
      languagesKnown: [],
      salaryStatus: 'NOT_PROVIDED',
    });
    const r = parseCandidateAI(body);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.salaryStatus).toBe('NOT_PROVIDED');
      expect(r.value.salaryText).toBeNull();
    }
  });

  it('NEGOTIABLE salary is accepted', () => {
    const body = JSON.stringify({
      targetRoles: [],
      skills: [],
      industries: [],
      taskKeywords: [],
      locations: [],
      languagesKnown: [],
      salaryStatus: 'NEGOTIABLE',
      salaryText: null,
    });
    const r = parseCandidateAI(body);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.salaryStatus).toBe('NEGOTIABLE');
  });
});

describe('extractJsonBody strips markdown fences', () => {
  it('strips ```json ... ``` and keeps only JSON inside', () => {
    const raw =
      'Here is the result:\n```json\n{"targetRoles":["waiter"],"skills":[]}\n```\nThanks!';
    const cleaned = extractJsonBody(raw);
    expect(cleaned).toContain('"targetRoles"');
    expect(cleaned).not.toContain('```');
    expect(cleaned).not.toContain('Here is');
  });

  it('handles triple backticks without json hint', () => {
    const raw = '```\n{"salaryStatus":"PROVIDED"}\n```';
    const cleaned = extractJsonBody(raw);
    expect(JSON.parse(cleaned).salaryStatus).toBe('PROVIDED');
  });

  it('returns {} when no JSON present', () => {
    expect(extractJsonBody('hello world')).toBe('{}');
    expect(extractJsonBody('')).toBe('{}');
  });
});

describe('parseJobAI validates job output', () => {
  it('returns ok=false for invalid shape', () => {
    void parseJobAI('{"notAJobField":true}');
    const r2 = parseJobAI('{"salaryStatus":"MAYBE"}');
    expect(r2.ok).toBe(false);
  });

  it('accepts a full job response with headcount and benefits', () => {
    const r = parseJobAI(
      JSON.stringify({
        title: 'Waiter',
        tasks: ['Serve food', 'Clean tables'],
        skills: ['Khmer'],
        industry: 'F&B',
        locations: ['Phnom Penh'],
        languagesRequired: ['Khmer'],
        shifts: ['Day'],
        salaryStatus: 'PROVIDED',
        salaryText: '$250',
        availabilityStart: '2025-01-08',
        housingProvided: false,
        mealsProvided: true,
        transportProvided: false,
        workPermitRequired: false,
        headcount: 3,
        confidence: {},
        unknownFields: [],
        warnings: [],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.headcount).toBe(3);
      expect(r.value.mealsProvided).toBe(true);
    }
  });
});
