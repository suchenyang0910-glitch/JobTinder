import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlerTranslationService } from '@src/infrastructure/ai/crawler-translation.service';
import type { DetectedLanguage } from '@src/domain/crawler/crawl-entities';
import {
  AIExtractProvider,
  type AIProviderId,
  type AILanguage,
} from '@src/domain/trust/ai-extract-provider';

class FakeRawProvider extends AIExtractProvider {
  readonly providerId: AIProviderId;
  constructor(
    id: AIProviderId,
    private raw: (msg: string, opts?: unknown) => string,
    private modelLabel: string = 'fake-model',
  ) {
    super();
    this.providerId = id;
  }
  extractCandidateDraft(): never {
    throw new Error('Not used');
  }
  extractJobDraft(): never {
    throw new Error('Not used');
  }
  getModelLabel() {
    return this.modelLabel;
  }
  async callRawPrompt(userMessage: string, opts?: Record<string, unknown>): Promise<string> {
    return this.raw(userMessage, opts);
  }
}

function makeTranslationJSON(
  overrides: Partial<{
    language: string;
    title: string;
    tasks: string[];
    skills: string[];
    industry: string;
    locations: string[];
    salaryText: string;
    shifts: string[];
    benefits: string[];
    warnings: string[];
  }> = {},
) {
  return JSON.stringify({
    language: overrides.language ?? 'en',
    title: overrides.title ?? 'Barista',
    tasks: overrides.tasks ?? ['Make coffee'],
    skills: overrides.skills ?? ['Coffee making'],
    industry: overrides.industry ?? 'Food & Beverage',
    locations: overrides.locations ?? ['Phnom Penh'],
    salaryText: overrides.salaryText ?? '$250-$350',
    shifts: overrides.shifts ?? ['Day'],
    benefits: overrides.benefits ?? ['Meal'],
    warnings: overrides.warnings ?? [],
  });
}

describe('CrawlerTranslationService', () => {
  beforeEach(() => {
    /* noop */
  });

  it('detectLanguage: detects Khmer unicode block as km', () => {
    const svc = new CrawlerTranslationService(new FakeRawProvider('mock', () => '{}'));
    expect(svc.detectLanguage('ការងារសំរាប់បារីស្តា')).toBe('km');
  });

  it('detectLanguage: detects CJK as zh_CN', () => {
    const svc = new CrawlerTranslationService(new FakeRawProvider('mock', () => '{}'));
    expect(svc.detectLanguage('咖啡师招聘 五斗米折腰 餐饮')).toBe('zh_CN');
  });

  it('detectLanguage: detects English ASCII majority as en', () => {
    const svc = new CrawlerTranslationService(new FakeRawProvider('mock', () => '{}'));
    expect(svc.detectLanguage('Barista wanted for Phnom Penh cafe. Experience required.')).toBe(
      'en',
    );
  });

  it('§8 Khmer source → translates into en + zh_CN + identity km', async () => {
    let calledLangs: Array<'en' | 'zh_CN' | 'km' | 'unknown'> = [];
    const p = new FakeRawProvider(
      'mock',
      (msg) => {
        const body = String(msg);
        let lang: 'en' | 'zh_CN' | 'km' = 'en';
        if (/to.*(chinese|中文|zh[_ ]CN)/i.test(body)) lang = 'zh_CN';
        else if (/to.*(khmer|高棉语|高棉|\bkm\b)/i.test(body)) lang = 'km';
        calledLangs.push(lang);
        return makeTranslationJSON({ language: lang, title: `T-${lang}` });
      },
      'deepseek-chat',
    );
    const svc = new CrawlerTranslationService(p);
    const { translations, failedLanguages } = await svc.translateIntoOtherLanguages({
      sourceLanguage: 'km',
      originalText: 'ការងារបារីស្តា ប្រាក់ខែ $250-$350',
      structuredFallback: {
        title: 'បារីស្តា',
        tasks: [],
        skills: [],
        industry: null,
        locations: [],
        salaryText: '$250-$350',
        shifts: [],
        benefits: [],
      },
    });
    expect(failedLanguages).toEqual([]);
    expect(Object.keys(translations)).toEqual(expect.arrayContaining(['km', 'en', 'zh_CN']));
    expect(Object.keys(translations)).toHaveLength(3);
    expect(translations.en.fields.title).toBe('T-en');
    expect(translations.zh_CN.fields.title).toBe('T-zh_CN');
    expect(translations.km.fields.title).toBe('បារីស្តា'); // identity-original not overwritten by AI
  });

  it('§9 English source → translates into km + zh_CN', async () => {
    const p = new FakeRawProvider('mock', (msg) => {
      const body = String(msg);
      let lang: 'en' | 'zh_CN' | 'km' = 'en';
      if (/translate.*to.*chinese|中文|zh_CN/i.test(body)) lang = 'zh_CN';
      else if (/translate.*to.*khmer|高棉|km/i.test(body)) lang = 'km';
      return makeTranslationJSON({ language: lang });
    });
    const svc = new CrawlerTranslationService(p);
    const { translations, failedLanguages } = await svc.translateIntoOtherLanguages({
      sourceLanguage: 'en',
      originalText: 'Barista salary $250-$350 Phnom Penh',
      structuredFallback: {
        title: 'Barista',
        tasks: ['Make drinks'],
        skills: [],
        industry: 'F&B',
        locations: ['Phnom Penh'],
        salaryText: '$250-$350',
        shifts: [],
        benefits: [],
      },
    });
    expect(failedLanguages).toEqual([]);
    expect(translations.en.fields.title).toBe('Barista'); // identity
    expect(translations.km.fields.title).toBeTruthy();
    expect(translations.zh_CN.fields.title).toBeTruthy();
    expect(translations.km.provider).toBe('mock'); // provider id from APP_ENV.AI_DEFAULT_PROVIDER
    expect(translations.km.model).toBeTruthy();
  });

  it('§10 Chinese source → translates into km + en', async () => {
    const p = new FakeRawProvider('mock', (msg) => {
      const body = String(msg);
      let lang: 'en' | 'zh_CN' | 'km' = 'en';
      if (/translate.*to.*khmer|高棉|km/i.test(body)) lang = 'km';
      else lang = 'en';
      return makeTranslationJSON({ language: lang });
    });
    const svc = new CrawlerTranslationService(p);
    const { translations } = await svc.translateIntoOtherLanguages({
      sourceLanguage: 'zh_CN',
      originalText: '咖啡师招聘 月薪 250-350 美元 金边',
      structuredFallback: {
        title: '咖啡师',
        tasks: ['冲煮咖啡'],
        skills: [],
        industry: '餐饮',
        locations: ['金边'],
        salaryText: '$250-$350',
        shifts: [],
        benefits: [],
      },
    });
    expect(translations.zh_CN.fields.title).toBe('咖啡师'); // identity
    expect(translations.en.fields.title).toBeTruthy();
    expect(translations.km.fields.title).toBeTruthy();
  });

  it('§13 AI returns illegal JSON → wraps warning + uses fallback', async () => {
    const p = new FakeRawProvider('mock', () => 'NOT JSON AT ALL <<{{}');
    const svc = new CrawlerTranslationService(p);
    const { translations } = await svc.translateIntoOtherLanguages({
      sourceLanguage: 'en',
      originalText: 'Barista wanted $250',
      structuredFallback: {
        title: 'Barista Fallback',
        tasks: [],
        skills: [],
        industry: null,
        locations: [],
        salaryText: '$250',
        shifts: [],
        benefits: [],
      },
    });
    const ai = translations.km;
    expect(ai.fields.title).toBe('Barista Fallback'); // fallback preserved
    const hasWarn = ai.fields.warnings.some((w) =>
      /TRANSLATION_FAILED_FOR_|FALLBACK_USED/i.test(w),
    );
    if (!hasWarn) {
      throw new Error(
        `Expected warning TRANSLATION_FAILED_FOR_* or FALLBACK_USED, got: ${JSON.stringify(ai.fields.warnings)}`,
      );
    }
    expect(hasWarn).toBe(true);
  });

  it('§14 AI throws during translate → marks translation FAILED (upstream sets REVIEW_REQUIRED)', async () => {
    const p = new FakeRawProvider('mock', () => {
      throw new Error('timeout 504 gateway');
    });
    const svc = new CrawlerTranslationService(p);
    const { failedLanguages, translations } = await svc.translateIntoOtherLanguages({
      sourceLanguage: 'en',
      originalText: 'Welder wanted',
      structuredFallback: {
        title: 'Welder',
        tasks: [],
        skills: [],
        industry: null,
        locations: [],
        salaryText: null,
        shifts: [],
        benefits: [],
      },
    });
    expect(failedLanguages).toContain('km');
    expect(failedLanguages).toContain('zh_CN');
    expect(
      translations.km.fields.warnings.some((w) =>
        /TRANSLATION_FAILED_TIMEOUT|TRANSLATION_FAILED/i.test(w),
      ),
    ).toBe(true);
  });
});
