import { describe, it, expect } from 'vitest';
import {
  CrawlerQAService,
  type QAStagingInput,
  type QATranslationInput,
} from '@src/application/crawler/crawler-qa.service';
import { QA_FLAG_CODES } from '@src/domain/crawler/crawl-entities';

function emptyStaging(overrides: Partial<QAStagingInput> = {}): QAStagingInput {
  return {
    titleSource: 'Barista',
    tasksSource: ['Make coffee'],
    skillsSource: ['Coffee'],
    industrySource: 'F&B',
    locationsSource: ['Phnom Penh'],
    salarySource: '$250-$350',
    shiftSource: ['Day'],
    benefitsSource: ['Meal'],
    parsedJsonHeadcount: 2,
    detectedLanguage: 'en',
    sourceJobSnapshotHttpStatus: 200,
    totalChars: 400,
    ...overrides,
  };
}
function emptyTrans(
  language: 'km' | 'en' | 'zh_CN',
  overrides: Partial<QATranslationInput> = {},
): QATranslationInput {
  return {
    language,
    title: 'Barista',
    tasks: ['Make coffee'],
    skills: ['Coffee'],
    industry: 'F&B',
    locations: ['Phnom Penh'],
    salaryText: '$250-$350',
    shifts: ['Day'],
    benefits: ['Meal'],
    ...overrides,
  };
}

describe('CrawlerQAService', () => {
  const svc = new CrawlerQAService();

  it('structural QA flags missing title → TITLE_MISSING + requiresReview', () => {
    const s = emptyStaging({ titleSource: null });
    const res = svc.runStructuralQA(s);
    expect(res.flags).toContain(QA_FLAG_CODES.TITLE_MISSING);
  });

  it('structural QA flags missing location → LOCATION_MISSING', () => {
    const s = emptyStaging({ locationsSource: [] });
    const res = svc.runStructuralQA(s);
    expect(res.flags).toContain(QA_FLAG_CODES.LOCATION_MISSING);
  });

  it('structural QA flags short content → CONTENT_TOO_SHORT', () => {
    const s = emptyStaging({ totalChars: 10 });
    const res = svc.runStructuralQA(s);
    expect(res.flags).toContain(QA_FLAG_CODES.CONTENT_TOO_SHORT);
  });

  it('structural QA flags unknown language → LANGUAGE_UNKNOWN', () => {
    const s = emptyStaging({ detectedLanguage: 'unknown' });
    const res = svc.runStructuralQA(s);
    expect(res.flags).toContain(QA_FLAG_CODES.LANGUAGE_UNKNOWN);
  });

  it('structural QA flags 404/410 → STALE_SOURCE, 5xx → SOURCE_INACCESSIBLE', () => {
    expect(svc.runStructuralQA(emptyStaging({ sourceJobSnapshotHttpStatus: 404 })).flags).toContain(
      QA_FLAG_CODES.STALE_SOURCE,
    );
    expect(svc.runStructuralQA(emptyStaging({ sourceJobSnapshotHttpStatus: 410 })).flags).toContain(
      QA_FLAG_CODES.STALE_SOURCE,
    );
    expect(svc.runStructuralQA(emptyStaging({ sourceJobSnapshotHttpStatus: 500 })).flags).toContain(
      QA_FLAG_CODES.SOURCE_INACCESSIBLE,
    );
    expect(
      svc.runStructuralQA(emptyStaging({ sourceJobSnapshotHttpStatus: 200 })).flags,
    ).not.toContain(QA_FLAG_CODES.STALE_SOURCE);
    expect(
      svc.runStructuralQA(emptyStaging({ sourceJobSnapshotHttpStatus: 200 })).flags,
    ).not.toContain(QA_FLAG_CODES.SOURCE_INACCESSIBLE);
  });

  it('structural QA flags marketing (too many emojis) → MARKETING_NOT_JOB', () => {
    const s = emptyStaging({
      titleSource: '🔥🔥🔥 WIN IPHONE NOW 🎁🎁🎁 🌟🌟',
      tasksSource: ['Sign up and get gifts 💎💎💎'],
      totalChars: 80,
    });
    const res = svc.runStructuralQA(s);
    expect(res.flags).toContain(QA_FLAG_CODES.MARKETING_NOT_JOB);
  });

  it('§11 consistency QA detects salary mismatch → SALARY_MISMATCH', () => {
    const translations = {
      en: emptyTrans('en', { salaryText: '$250-$350' }),
      zh_CN: emptyTrans('zh_CN', { salaryText: '$400-$500' }),
      km: emptyTrans('km', { salaryText: '$250-$350' }),
    };
    const res = svc.runConsistencyQA({ original: emptyStaging(), translations });
    expect(res.flags).toContain(QA_FLAG_CODES.SALARY_MISMATCH);
  });

  it('§11 consistency QA: salary matches across en/zh/km → no SALARY_MISMATCH', () => {
    const translations = {
      en: emptyTrans('en', { salaryText: '$250-$350' }),
      zh_CN: emptyTrans('zh_CN', { salaryText: '$250-$350' }),
      km: emptyTrans('km', { salaryText: '$250-$350' }),
    };
    const res = svc.runConsistencyQA({ original: emptyStaging(), translations });
    expect(res.flags).not.toContain(QA_FLAG_CODES.SALARY_MISMATCH);
  });

  it('§12 consistency QA benefits added in translation → EXTRA_BENEFITS_ADDED', () => {
    const translations = {
      en: emptyTrans('en', { benefits: ['Meal'] }),
      zh_CN: emptyTrans('zh_CN', {
        benefits: ['Meal', 'Free iPhone 15', 'Yearly bonus 13th month'],
      }),
      km: emptyTrans('km', { benefits: ['Meal'] }),
    };
    const res = svc.runConsistencyQA({ original: emptyStaging(), translations });
    expect(res.flags).toContain(QA_FLAG_CODES.EXTRA_BENEFITS_ADDED);
  });

  it('§12 consistency QA tasks/skills/locations imbalance → FACTS_COUNT_MISMATCH', () => {
    const translations = {
      en: emptyTrans('en', {
        tasks: [
          'Make coffee',
          'Clean tables',
          'Handle cash',
          'Manage inventory',
          'Train new staff',
          'Order supplies',
          'Manage staff schedule',
        ],
        skills: [
          'Espresso',
          'Latte art',
          'Customer service',
          'Cash handling',
          'Inventory management',
        ],
        locations: ['Phnom Penh', 'Siem Reap', 'Sihanoukville', 'Battambang'],
        shifts: ['Morning', 'Afternoon', 'Night', 'Weekend'],
        benefits: ['Meal', 'Free coffee', 'Tips', 'Uniform', 'Transport', '13th month'],
      }),
      zh_CN: emptyTrans('zh_CN', { tasks: ['Make coffee'] }),
      km: emptyTrans('km', { tasks: ['Make coffee'] }),
    };
    const res = svc.runConsistencyQA({ original: emptyStaging(), translations });
    expect(res.flags).toContain(QA_FLAG_CODES.FACTS_COUNT_MISMATCH);
  });

  it('aggregateForStaging combines structural + consistency + translation failures → requiresReview=true', () => {
    const structural = svc.runStructuralQA(emptyStaging({ titleSource: null }));
    const consistency = svc.runConsistencyQA({
      original: emptyStaging(),
      translations: {
        en: emptyTrans('en'),
        zh_CN: emptyTrans('zh_CN'),
        km: emptyTrans('km'),
      },
    });
    const agg = svc.aggregateForStaging({
      structural,
      consistency,
      translationFailedLanguages: [],
    });
    expect(agg.requiresReview).toBe(true);
    expect(agg.flags).toContain(QA_FLAG_CODES.TITLE_MISSING);
  });

  it('aggregateForStaging translation failures → JSON_INVALID flag + requiresReview', () => {
    const structural = svc.runStructuralQA(emptyStaging());
    const consistency = svc.runConsistencyQA({
      original: emptyStaging(),
      translations: {
        en: emptyTrans('en'),
        zh_CN: emptyTrans('zh_CN'),
        km: emptyTrans('km'),
      },
    });
    const agg = svc.aggregateForStaging({
      structural,
      consistency,
      translationFailedLanguages: ['zh_CN'],
    });
    expect(agg.requiresReview).toBe(true);
    expect(agg.flags).toContain(QA_FLAG_CODES.JSON_INVALID);
  });
});
