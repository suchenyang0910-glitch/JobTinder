import { Injectable, Inject, Logger } from '@nestjs/common';
import { AI_PROVIDER_TOKEN, type AIExtractProvider } from '@src/domain/trust/ai-extract-provider';

export type DetectedResumeLanguage = 'en' | 'zh_CN' | 'km' | 'mixed';

@Injectable()
export class ResumeLanguageService {
  private readonly logger = new Logger(ResumeLanguageService.name);

  constructor(@Inject(AI_PROVIDER_TOKEN) private readonly ai: AIExtractProvider) {}

  async detect(text: string): Promise<DetectedResumeLanguage> {
    if (!text || text.trim().length === 0) {
      return 'mixed';
    }

    const prompt = `
You are a language detection assistant for JobTinder Cambodia.
Analyze the following text (which is a user's resume or profile input) and determine its primary language.
Reply strictly with ONE of the following exact tokens, and nothing else:
"en" - if it is primarily English
"zh_CN" - if it is primarily Simplified Chinese
"km" - if it is primarily Khmer
"mixed" - if it is heavily mixed or you cannot confidently determine the primary language.

Text:
"""
${text.slice(0, 2000)}
"""
`;
    try {
      const response = await this.ai.callRawPrompt(prompt, {
        temperature: 0.0,
        responseFormat: 'text',
        timeoutMs: 5000,
      });

      const cleaned = response
        .trim()
        .replace(/["'`\s]/g, '')
        .toLowerCase();
      if (cleaned === 'en') return 'en';
      if (cleaned === 'zh_cn') return 'zh_CN';
      if (cleaned === 'km') return 'km';
      return 'mixed';
    } catch (e) {
      this.logger.error(`Language detection failed: ${e instanceof Error ? e.message : String(e)}`);
      return 'mixed'; // Fallback
    }
  }
}
