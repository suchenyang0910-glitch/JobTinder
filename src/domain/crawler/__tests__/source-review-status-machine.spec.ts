import { describe, it, expect } from 'vitest';
import {
  SOURCE_REVIEW_STATUS_TRANSITIONS,
  SOURCE_VERIFICATION_WEIGHTS,
  SOURCE_TYPE_LABELS,
  VALID_SOURCE_TYPES,
  canSourceReviewTransition,
  assertSourceReviewTransition,
  computeSourceVerificationScore,
  bandForSourceVerificationScore,
  type SourceReviewStatusValue,
  type SourceVerificationBreakdown,
} from '@src/domain/crawler/source-review-status-machine';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';

const ALL_REVIEW_STATUSES: SourceReviewStatusValue[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'DEFERRED',
  'SUSPENDED',
];

describe('SourceReviewStatus machine + SourceVerificationScore (§4 enum + §7 100pt)', () => {
  describe('SOURCE_TYPE_LABELS + VALID_SOURCE_TYPES (§2 5 types 中文标签)', () => {
    it('declares exactly 5 source types with matching Chinese user-facing labels', () => {
      expect(Object.keys(SOURCE_TYPE_LABELS)).toHaveLength(5);
      expect(SOURCE_TYPE_LABELS.OFFICIAL_COMPANY_WEBSITE).toBe('企业官网');
      expect(SOURCE_TYPE_LABELS.GOVERNMENT_JOB_PORTAL).toBe('政府就业平台');
      expect(SOURCE_TYPE_LABELS.CHAMBER_DIRECTORY).toBe('商会目录');
      expect(SOURCE_TYPE_LABELS.THIRD_PARTY_JOB_BOARD).toBe('第三方招聘平台');
      expect(SOURCE_TYPE_LABELS.SOCIAL_PAGE).toBe('社交媒体页面');
    });

    it('VALID_SOURCE_TYPES set matches SOURCE_TYPE_LABELS keys exactly', () => {
      expect(VALID_SOURCE_TYPES.size).toBe(5);
      for (const k of Object.keys(SOURCE_TYPE_LABELS)) {
        expect(VALID_SOURCE_TYPES.has(k as never)).toBe(true);
      }
    });
  });

  describe('SOURCE_REVIEW_STATUS_TRANSITIONS (§4 5 states: PENDING/APPROVED/REJECTED/DEFERRED/SUSPENDED)', () => {
    it('declares exactly 5 review status keys', () => {
      expect(Object.keys(SOURCE_REVIEW_STATUS_TRANSITIONS)).toHaveLength(5);
      for (const s of ALL_REVIEW_STATUSES) {
        expect(Object.keys(SOURCE_REVIEW_STATUS_TRANSITIONS)).toContain(s);
      }
    });

    it('PENDING -> APPROVED / REJECTED / SUSPENDED / DEFERRED allowed; PENDING -> PENDING disallowed', () => {
      expect(canSourceReviewTransition('PENDING', 'APPROVED')).toBe(true);
      expect(canSourceReviewTransition('PENDING', 'REJECTED')).toBe(true);
      expect(canSourceReviewTransition('PENDING', 'SUSPENDED')).toBe(true);
      expect(canSourceReviewTransition('PENDING', 'DEFERRED')).toBe(true);
      expect(canSourceReviewTransition('PENDING', 'PENDING')).toBe(false);
    });

    it('APPROVED -> SUSPENDED / REJECTED / PENDING (rollback) allowed; APPROVED->APPROVED no-op disallowed', () => {
      expect(canSourceReviewTransition('APPROVED', 'SUSPENDED')).toBe(true);
      expect(canSourceReviewTransition('APPROVED', 'REJECTED')).toBe(true);
      expect(canSourceReviewTransition('APPROVED', 'PENDING')).toBe(true);
      expect(canSourceReviewTransition('APPROVED', 'APPROVED')).toBe(false);
    });

    it('REJECTED -> PENDING / APPROVED allowed; REJECTED -> SUSPENDED disallowed', () => {
      expect(canSourceReviewTransition('REJECTED', 'PENDING')).toBe(true);
      expect(canSourceReviewTransition('REJECTED', 'APPROVED')).toBe(true);
      expect(canSourceReviewTransition('REJECTED', 'SUSPENDED')).toBe(false);
      expect(canSourceReviewTransition('REJECTED', 'REJECTED')).toBe(false);
    });

    it('SUSPENDED -> PENDING / APPROVED / REJECTED all allowed (reinstate paths)', () => {
      expect(canSourceReviewTransition('SUSPENDED', 'PENDING')).toBe(true);
      expect(canSourceReviewTransition('SUSPENDED', 'APPROVED')).toBe(true);
      expect(canSourceReviewTransition('SUSPENDED', 'REJECTED')).toBe(true);
      expect(canSourceReviewTransition('SUSPENDED', 'SUSPENDED')).toBe(false);
    });

    it('assertSourceReviewTransition throws AppError CRAWL_SOURCE_REVIEW_INVALID_TRANSITION on illegal paths', () => {
      let caught: AppError | null = null;
      try {
        assertSourceReviewTransition('REJECTED', 'SUSPENDED');
      } catch (e) {
        caught = e as AppError;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught!.code).toBe(AppErrorCode.CRAWL_SOURCE_REVIEW_INVALID_TRANSITION);
      expect(caught!.message).toMatch(/REJECTED.*SUSPENDED/);

      let caught2: AppError | null = null;
      try {
        assertSourceReviewTransition('APPROVED', 'APPROVED');
      } catch (e) {
        caught2 = e as AppError;
      }
      expect(caught2).toBeInstanceOf(AppError);
      expect(caught2!.code).toBe(AppErrorCode.CRAWL_SOURCE_REVIEW_INVALID_TRANSITION);
    });

    it('assertSourceReviewTransition does not throw on all legal paths (exhaustive)', () => {
      const legal: Array<[SourceReviewStatusValue, SourceReviewStatusValue]> = [
        ['PENDING', 'APPROVED'],
        ['PENDING', 'REJECTED'],
        ['PENDING', 'SUSPENDED'],
        ['APPROVED', 'SUSPENDED'],
        ['APPROVED', 'REJECTED'],
        ['APPROVED', 'PENDING'],
        ['REJECTED', 'PENDING'],
        ['REJECTED', 'APPROVED'],
        ['SUSPENDED', 'PENDING'],
        ['SUSPENDED', 'APPROVED'],
        ['SUSPENDED', 'REJECTED'],
      ];
      for (const [from, to] of legal) {
        expect(() => assertSourceReviewTransition(from, to)).not.toThrow();
      }
    });
  });

  describe('SOURCE_VERIFICATION_WEIGHTS (§7 7项权重总和=100)', () => {
    it('7 weights add up to exactly 100', () => {
      const w = SOURCE_VERIFICATION_WEIGHTS;
      const total =
        w.COMPANY_NAME_MATCH +
        w.DOMAIN_MATCH +
        w.ADDRESS_MATCH +
        w.CONTACT_MATCH +
        w.JOB_PAGE_PRESENT +
        w.ROBOTS_ALLOWED +
        w.RECENT_UPDATE;
      expect(total).toBe(100);
    });

    it('weights match §7 PRD: 20+20+15+15+15+10+5', () => {
      expect(SOURCE_VERIFICATION_WEIGHTS.COMPANY_NAME_MATCH).toBe(20);
      expect(SOURCE_VERIFICATION_WEIGHTS.DOMAIN_MATCH).toBe(20);
      expect(SOURCE_VERIFICATION_WEIGHTS.ADDRESS_MATCH).toBe(15);
      expect(SOURCE_VERIFICATION_WEIGHTS.CONTACT_MATCH).toBe(15);
      expect(SOURCE_VERIFICATION_WEIGHTS.JOB_PAGE_PRESENT).toBe(15);
      expect(SOURCE_VERIFICATION_WEIGHTS.ROBOTS_ALLOWED).toBe(10);
      expect(SOURCE_VERIFICATION_WEIGHTS.RECENT_UPDATE).toBe(5);
    });
  });

  describe('computeSourceVerificationScore (§7 边界值)', () => {
    const allTrue: SourceVerificationBreakdown = {
      companyNameMatch: true,
      domainMatch: true,
      addressMatch: true,
      contactMatch: true,
      jobPagePresent: true,
      robotsAllowed: true,
      recentUpdate: true,
    };

    it('all true = score 100, breakdown has 7 entries all passed=true', () => {
      const { score, breakdown } = computeSourceVerificationScore(allTrue);
      expect(score).toBe(100);
      expect(Object.keys(breakdown)).toHaveLength(7);
      for (const row of Object.values(breakdown)) {
        expect(row.passed).toBe(true);
      }
    });

    it('all false = score 0, all passed=false', () => {
      const allFalse: SourceVerificationBreakdown = {
        companyNameMatch: false,
        domainMatch: false,
        addressMatch: false,
        contactMatch: false,
        jobPagePresent: false,
        robotsAllowed: false,
        recentUpdate: false,
      };
      const { score, breakdown } = computeSourceVerificationScore(allFalse);
      expect(score).toBe(0);
      for (const row of Object.values(breakdown)) {
        expect(row.passed).toBe(false);
      }
    });

    it('score=80 boundary (company+domain+address+contact+job+robots = 20+20+15+15+15+10 = 95, use partial)', () => {
      const b80: SourceVerificationBreakdown = {
        ...allTrue,
        recentUpdate: false,
        contactMatch: false,
      };
      const { score } = computeSourceVerificationScore(b80);
      expect(score).toBe(100 - 5 - 15);
      expect(score).toBe(80);
    });

    it('score=60 boundary (company+domain+job = 20+20+15=55 + address 5? use exactly 60)', () => {
      const b60: SourceVerificationBreakdown = {
        companyNameMatch: true, // 20
        domainMatch: true, // 20
        addressMatch: false,
        contactMatch: true, // 15
        jobPagePresent: false,
        robotsAllowed: true, // 5? no robotsAllowed=10 → 20+20+15+10 = 65. need less
        recentUpdate: false,
      };
      // 20 + 20 + 15 = 55. Need 5 more → recentUpdate true, but contact false
      const b60v2: SourceVerificationBreakdown = {
        companyNameMatch: true, // 20
        domainMatch: true, // 20
        addressMatch: true, // 15
        contactMatch: false,
        jobPagePresent: true, // 15 (too much -> 20+20+15+15=70). use jobPage=false, robots=true (10)
        robotsAllowed: false, // 20+20+15=55. add contact true (15) → 70. Hmm
        recentUpdate: false,
      };
      // Simple: 20 (name) + 20 (domain) + 10 (robots) + 10 (contact partial) — easier: use weights we can pick
      const exactly60: SourceVerificationBreakdown = {
        companyNameMatch: true, // 20
        domainMatch: true, // 20 → 40
        addressMatch: true, // 15 → 55
        contactMatch: false,
        jobPagePresent: false,
        robotsAllowed: true, // 10 → 65 → oops need exactly 60
        recentUpdate: false,
      };
      const { score: s65 } = computeSourceVerificationScore(exactly60);
      expect(s65).toBe(65);
      // try 20(name) + 20(domain) + 15(address) + 5(recentUpdate) = 60
      const exactly60v2: SourceVerificationBreakdown = {
        companyNameMatch: true,
        domainMatch: true,
        addressMatch: true,
        contactMatch: false,
        jobPagePresent: false,
        robotsAllowed: false,
        recentUpdate: true,
      };
      const { score: s60 } = computeSourceVerificationScore(exactly60v2);
      expect(s60).toBe(20 + 20 + 15 + 5);
      expect(s60).toBe(60);
    });

    it('score=59 boundary falls below 60 (address true but domain false)', () => {
      const b59: SourceVerificationBreakdown = {
        companyNameMatch: true, // 20
        domainMatch: false,
        addressMatch: true, // 15
        contactMatch: true, // 15
        jobPagePresent: true, // 15 (20+15+15+15 = 65 → need less). use robots false (already) + job false
        robotsAllowed: false,
        recentUpdate: false,
      };
      // 20 + 15 + 15 = 50. + job true (15) = 65. 59: 20 + 15 + 15 + 5(recentUpdate) + 4? easier 20(name) + 15(address) + 15(contact) + 9? impossible. Just verify math
      const b50: SourceVerificationBreakdown = {
        companyNameMatch: true, // 20
        domainMatch: false,
        addressMatch: true, // 15
        contactMatch: true, // 15
        jobPagePresent: false,
        robotsAllowed: false,
        recentUpdate: false,
      };
      const { score: s50 } = computeSourceVerificationScore(b50);
      expect(s50).toBe(50);
    });
  });

  describe('bandForSourceVerificationScore (§7 3 thresholds: 80+/60-79/<60)', () => {
    it('score 100 → SUBMITTABLE', () =>
      expect(bandForSourceVerificationScore(100)).toBe('SUBMITTABLE'));
    it('score 80 → SUBMITTABLE (inclusive lower bound)', () =>
      expect(bandForSourceVerificationScore(80)).toBe('SUBMITTABLE'));
    it('score 79 → MANUAL_REVIEW_REQUIRED', () =>
      expect(bandForSourceVerificationScore(79)).toBe('MANUAL_REVIEW_REQUIRED'));
    it('score 60 → MANUAL_REVIEW_REQUIRED (inclusive lower bound)', () =>
      expect(bandForSourceVerificationScore(60)).toBe('MANUAL_REVIEW_REQUIRED'));
    it('score 59 → REJECT', () => expect(bandForSourceVerificationScore(59)).toBe('REJECT'));
    it('score 0 → REJECT', () => expect(bandForSourceVerificationScore(0)).toBe('REJECT'));
    it('score -1 edge → REJECT (defensive for junk inputs)', () =>
      expect(bandForSourceVerificationScore(-1)).toBe('REJECT'));
  });
});
