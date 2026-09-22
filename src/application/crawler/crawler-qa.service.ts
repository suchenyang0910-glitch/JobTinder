import { Injectable, Logger } from '@nestjs/common';
import type { Language } from '@prisma/client';
import { QA_FLAG_CODES, type QAFlagCode, type QAResult } from '@src/domain/crawler/crawl-entities';

export interface QAStagingInput {
  titleSource: string | null;
  tasksSource: string[];
  skillsSource: string[];
  industrySource: string | null;
  locationsSource: string[];
  salarySource: string | null;
  shiftSource: string[];
  benefitsSource: string[];
  parsedJsonHeadcount: number | null;
  detectedLanguage: string | null;
  sourceJobSnapshotHttpStatus: number | null;
  totalChars: number;
}

export interface QATranslationInput {
  language: Language;
  title: string;
  tasks: string[];
  skills: string[];
  industry: string | null;
  locations: string[];
  salaryText: string | null;
  shifts: string[];
  benefits: string[];
}

@Injectable()
export class CrawlerQAService {
  private readonly logger = new Logger(CrawlerQAService.name);

  private extractNumberPairs(
    text: string | null,
  ): Array<{ raw: string; value: number; symbol: string | null }> {
    if (!text) return [];
    const out: Array<{ raw: string; value: number; symbol: string | null }> = [];
    const re =
      /([$€£¥៛]|USD|KHR|CNY|RMB|EUR)?\s*(\d{1,5}(?:[,.]\d+)*)\s*([$€£¥៛]|USD|KHR|CNY|RMB|EUR)?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0].trim();
      const numStr = (m[2] ?? '').replace(/,/g, '');
      const value = Number(numStr);
      if (!Number.isFinite(value)) continue;
      const symbol = m[1] ?? m[3] ?? null;
      out.push({ raw, value, symbol });
    }
    return out;
  }

  private salarySignature(text: string | null): string {
    if (!text) return '__NULL__';
    const pairs = this.extractNumberPairs(text);
    if (pairs.length === 0) return '__NO_NUMBER__';
    return pairs
      .map((p) => `${p.symbol ?? 'X'}:${Math.round(p.value)}`)
      .sort()
      .join('|');
  }

  private sanitizeArray(arr: string[]): string[] {
    return arr.map((s) => s.trim()).filter((s) => s.length > 0);
  }

  runStructuralQA(row: QAStagingInput): { flags: QAFlagCode[]; issues: string[] } {
    const flags: QAFlagCode[] = [];
    const issues: string[] = [];
    if (!row.titleSource || row.titleSource.trim().length < 2) {
      flags.push(QA_FLAG_CODES.TITLE_MISSING);
      issues.push('title missing or too short (< 2 chars)');
    }
    const locs = this.sanitizeArray(row.locationsSource);
    if (locs.length === 0) {
      flags.push(QA_FLAG_CODES.LOCATION_MISSING);
      issues.push('no locations extracted');
    }
    if (row.totalChars < 80) {
      flags.push(QA_FLAG_CODES.CONTENT_TOO_SHORT);
      issues.push(`content too short (${row.totalChars} chars, need >= 80)`);
    }
    if (row.detectedLanguage === 'unknown') {
      flags.push(QA_FLAG_CODES.LANGUAGE_UNKNOWN);
      issues.push('could not detect source language');
    }
    if (
      row.sourceJobSnapshotHttpStatus != null &&
      (row.sourceJobSnapshotHttpStatus === 410 || row.sourceJobSnapshotHttpStatus === 404)
    ) {
      flags.push(QA_FLAG_CODES.STALE_SOURCE);
      issues.push(`source page returned HTTP ${row.sourceJobSnapshotHttpStatus}`);
    }
    if (row.sourceJobSnapshotHttpStatus != null && row.sourceJobSnapshotHttpStatus >= 500) {
      flags.push(QA_FLAG_CODES.SOURCE_INACCESSIBLE);
      issues.push(`source page HTTP ${row.sourceJobSnapshotHttpStatus}`);
    }
    // Marketing detection: many emoji / huge cap words / no job keywords.
    const noJobKeywords =
      !row.titleSource ||
      !/(招|聘|hiring|job|position|vacanc|work|career|岗位|职位|អាជីព|ការងារ)/i.test(
        `${row.titleSource} ${(row.tasksSource || []).join(' ')}`,
      );
    const manyEmojis =
      /[\u{1F300}-\u{1FAFF}]/gu.test(
        `${row.titleSource ?? ''} ${(row.tasksSource || []).join(' ')} ${(row.benefitsSource || []).join(' ')}`,
      ) &&
      (`${row.titleSource ?? ''} ${(row.tasksSource || []).join(' ')} ${(row.benefitsSource || []).join(' ')}`.match(
        /[\u{1F300}-\u{1FAFF}]/gu,
      )?.length ?? 0) > 6;
    if (noJobKeywords && manyEmojis) {
      flags.push(QA_FLAG_CODES.MARKETING_NOT_JOB);
      issues.push('content looks like marketing rather than a job posting');
    }
    return { flags, issues };
  }

  runConsistencyQA(params: {
    original: QAStagingInput;
    translations: Record<Language, QATranslationInput>;
  }): { flags: QAFlagCode[]; issues: string[] } {
    const { original, translations } = params;
    const flags: QAFlagCode[] = [];
    const issues: string[] = [];
    const langs: Language[] = ['km', 'en', 'zh_CN'];

    const origSalarySig = this.salarySignature(original.salarySource);
    for (const lang of langs) {
      const t = translations[lang];
      if (!t) continue;
      const ts = this.salarySignature(t.salaryText);
      if (
        origSalarySig !== '__NULL__' &&
        ts !== '__NULL__' &&
        ts !== '__NO_NUMBER__' &&
        origSalarySig !== ts
      ) {
        flags.push(QA_FLAG_CODES.SALARY_MISMATCH);
        issues.push(`salary mismatch original=${origSalarySig} vs ${lang}=${ts}`);
        break;
      }
    }

    const origHeadcount = original.parsedJsonHeadcount ?? null;
    if (origHeadcount != null) {
      for (const lang of langs) {
        const t = translations[lang];
        if (!t) continue;
        const allText = `${t.title} ${t.tasks.join(' ')} ${t.shifts.join(' ')} ${t.benefits.join(' ')}`;
        const nums = this.extractNumberPairs(allText).map((p) => Math.round(p.value));
        if (
          nums.length > 0 &&
          !nums.includes(Math.round(origHeadcount)) &&
          /^(people|person|staff|名|人|នាក់|个)$/.test(allText)
        ) {
          flags.push(QA_FLAG_CODES.HEADCOUNT_MISMATCH);
          issues.push(`headcount ${origHeadcount} not present in ${lang} translation`);
        }
      }
    }

    const origBenefitsCount = this.sanitizeArray(original.benefitsSource).length;
    for (const lang of langs) {
      const t = translations[lang];
      if (!t) continue;
      const translatedBenefits = this.sanitizeArray(t.benefits);
      if (translatedBenefits.length > origBenefitsCount + 1) {
        flags.push(QA_FLAG_CODES.EXTRA_BENEFITS_ADDED);
        issues.push(
          `${lang} added extra benefits: ${translatedBenefits.length - origBenefitsCount} more than source`,
        );
      }
    }

    const langFacts: Record<Language, number> = {
      km: 0,
      en: 0,
      zh_CN: 0,
    };
    for (const lang of langs) {
      const t = translations[lang];
      if (!t) continue;
      langFacts[lang] =
        (t.title ? 1 : 0) +
        this.sanitizeArray(t.tasks).length +
        this.sanitizeArray(t.skills).length +
        this.sanitizeArray(t.locations).length +
        this.sanitizeArray(t.shifts).length +
        this.sanitizeArray(t.benefits).length +
        (t.salaryText ? 1 : 0) +
        (t.industry ? 1 : 0);
    }
    const counts = Object.values(langFacts).filter((v) => v > 0);
    if (counts.length >= 2) {
      const max = Math.max(...counts);
      const min = Math.min(...counts);
      if (max > 0 && min / max < 0.5) {
        flags.push(QA_FLAG_CODES.FACTS_COUNT_MISMATCH);
        issues.push(`fact count imbalance across translations: ${JSON.stringify(langFacts)}`);
      }
    }

    return { flags, issues };
  }

  aggregateForStaging(params: {
    structural: ReturnType<CrawlerQAService['runStructuralQA']>;
    consistency: ReturnType<CrawlerQAService['runConsistencyQA']>;
    translationFailedLanguages: Language[];
  }): QAResult {
    const { structural, consistency, translationFailedLanguages } = params;
    const flagSet = new Set<QAFlagCode>([...structural.flags, ...consistency.flags]);
    if (translationFailedLanguages.length > 0) {
      flagSet.add(QA_FLAG_CODES.JSON_INVALID);
    }
    const requiresReview = flagSet.size > 0;
    const flags: string[] = [...flagSet];
    const structuralIssues = structural.issues;
    const consistencyIssues = consistency.issues;
    const riskIssues: string[] = [];
    if (flagSet.has(QA_FLAG_CODES.TITLE_MISSING))
      riskIssues.push('job title missing — may prevent matches');
    if (flagSet.has(QA_FLAG_CODES.MARKETING_NOT_JOB))
      riskIssues.push('possible spam — marketing material mislabeled as a job');
    if (flagSet.has(QA_FLAG_CODES.STALE_SOURCE))
      riskIssues.push('source page appears to be stale (404/410)');
    return {
      passed: !requiresReview,
      flags,
      requiresReview,
      structuralIssues,
      consistencyIssues,
      riskIssues,
    };
  }
}
