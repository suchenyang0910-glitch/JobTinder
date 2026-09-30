import { Injectable, Inject, Logger } from '@nestjs/common';
import { AI_PROVIDER_TOKEN, type AIExtractProvider } from '@src/domain/trust/ai-extract-provider';
import { ResumeDraftZod, type ResumeDraft } from './resume.schema';

@Injectable()
export class ResumeAiService {
  private readonly logger = new Logger(ResumeAiService.name);

  constructor(@Inject(AI_PROVIDER_TOKEN) private readonly ai: AIExtractProvider) {}

  async extractDraft(text: string, outputLanguage: string): Promise<ResumeDraft> {
    const prompt = `
You are an expert Resume/CV writer for JobTinder Cambodia.
Your task is to extract, structure, and translate the provided user input into a professional resume.
You MUST output ONLY valid JSON matching the exact schema below.

Output Language Requirement:
You must translate/write all content into: ${outputLanguage}

Rules:
1. ONLY use the information provided by the user. Do NOT hallucinate or invent companies, dates, skills, or achievements.
2. If a field is missing or cannot be inferred from the text, leave it as null or empty array.
3. If you find contact info (phone, email, location), put them in the correct fields.
4. "sourceLanguage" should be the language the user primarily used in the input (en, zh_CN, km, mixed).
5. If the user input contains obvious garbage, spam, or no useful resume information, put a warning string in the "warnings" array.

Schema format (JSON):
{
  "fullName": "string or null",
  "headline": "string or null (e.g., Software Engineer)",
  "summary": "string or null (Professional summary)",
  "phone": "string or null",
  "email": "string or null",
  "location": "string or null",
  "targetRoles": ["role1", "role2"],
  "experiences": [
    {
      "company": "string or null",
      "title": "string or null",
      "start": "string or null (e.g. 2020-01)",
      "end": "string or null (e.g. 2023-05 or Present)",
      "responsibilities": ["bullet 1", "bullet 2"]
    }
  ],
  "education": [
    {
      "school": "string or null",
      "degree": "string or null",
      "major": "string or null",
      "start": "string or null",
      "end": "string or null"
    }
  ],
  "skills": ["skill1", "skill2"],
  "languages": ["lang1", "lang2"],
  "certificates": [
    {
      "name": "string",
      "issuer": "string or null",
      "year": "string or null"
    }
  ],
  "warnings": ["warning1"],
  "sourceLanguage": "en" | "zh_CN" | "km" | "mixed"
}

Input Text:
"""
${text}
"""
`;

    try {
      const response = await this.ai.callRawPrompt(prompt, {
        temperature: 0.1,
        responseFormat: 'json_object',
        timeoutMs: 60000,
      });

      const parsed = JSON.parse(response);
      return ResumeDraftZod.parse(parsed);
    } catch (e) {
      this.logger.warn('Resume extraction failed; returning an empty draft for manual completion.');
      return ResumeDraftZod.parse({
        warnings: [
          'AI could not structure this input. Please review and complete the draft manually.',
        ],
      });
    }
  }
}
