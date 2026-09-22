import type { Language } from '@prisma/client';
import type { Translation } from './locales/en';
import { en } from './locales/en';
import { zh } from './locales/zh-CN';
import { km } from './locales/km';

export type LocaleCode = 'en' | 'zh_CN' | 'km';

const LOCALES: Record<LocaleCode, Translation> = {
  en,
  zh_CN: zh,
  km,
};

export function localeFromPrisma(lang: Language): LocaleCode {
  switch (lang) {
    case 'zh_CN':
      return 'zh_CN';
    case 'km':
      return 'km';
    case 'en':
    default:
      return 'en';
  }
}

/**
 * Deep-resolves any function-valued leaf to a callable function;
 * plain strings remain strings.
 *
 * Usage:
 *   const T = pickT('zh_CN');
 *   await ctx.reply(T.START.welcome_new('Ming'));
 *   await ctx.reply(T.COMMON.version(3));
 */
export function pickT(lang: Language | LocaleCode): Translation {
  const code: LocaleCode =
    typeof lang === 'string' && lang in LOCALES ? lang : localeFromPrisma(lang);
  return LOCALES[code];
}

export { en, zh, km, LOCALES };
export type { Translation };
