import { Injectable } from '@nestjs/common';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
} from 'docx';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ResumeDraft } from '@src/application/resume/resume.schema';
import type { DetectedResumeLanguage } from '@src/application/resume/resume-language.service';

export interface RenderResult {
  filePath: string;
  sha256: string;
  sizeBytes: number;
}

@Injectable()
export class ResumeDocxRenderer {
  // We'll store resumes in a configured persistent volume or fallback to a local dir.
  private readonly outputDir =
    process.env.RESUME_STORAGE_DIR || path.join(process.cwd(), 'data', 'resumes');

  async onModuleInit() {
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  async render(
    data: ResumeDraft,
    userId: bigint,
    version: number,
    language: DetectedResumeLanguage = 'en',
  ): Promise<RenderResult> {
    const doc = new Document({
      sections: [
        {
          properties: {},
          children: this.buildContent(data, language),
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const sizeBytes = buffer.length;

    const fileName = `JobTinder-Resume-${userId.toString()}-v${version}.docx`;
    const tempFilePath = path.join(this.outputDir, `${fileName}.tmp`);
    const finalFilePath = path.join(this.outputDir, fileName);

    // Write to temp file then rename (atomic)
    await fs.writeFile(tempFilePath, buffer);
    await fs.rename(tempFilePath, finalFilePath);

    return {
      filePath: finalFilePath,
      sha256,
      sizeBytes,
    };
  }

  private buildContent(data: ResumeDraft, language: DetectedResumeLanguage): Paragraph[] {
    const labels = {
      en: {
        summary: 'Professional Summary',
        targetRoles: 'Target Roles',
        experience: 'Experience',
        education: 'Education',
        skills: 'Skills',
        languages: 'Languages',
        certificates: 'Certifications',
        missing: 'Not provided',
      },
      zh_CN: {
        summary: '个人简介',
        targetRoles: '目标岗位',
        experience: '工作经历',
        education: '教育背景',
        skills: '技能',
        languages: '语言',
        certificates: '证书',
        missing: '未提供',
      },
      km: {
        summary: 'ប្រវត្តិរូបសង្ខេប',
        targetRoles: 'មុខតំណែងដែលចង់បាន',
        experience: 'បទពិសោធន៍ការងារ',
        education: 'ការអប់រំ',
        skills: 'ជំនាញ',
        languages: 'ភាសា',
        certificates: 'វិញ្ញាបនបត្រ',
        missing: 'មិនបានផ្តល់',
      },
      mixed: {
        summary: 'Professional Summary',
        targetRoles: 'Target Roles',
        experience: 'Experience',
        education: 'Education',
        skills: 'Skills',
        languages: 'Languages',
        certificates: 'Certifications',
        missing: 'Not provided',
      },
    }[language];
    const children: Paragraph[] = [];

    // Header
    if (data.fullName) {
      children.push(
        new Paragraph({
          text: data.fullName,
          heading: HeadingLevel.TITLE,
          alignment: AlignmentType.CENTER,
        }),
      );
    } else {
      children.push(
        new Paragraph({
          text: labels.missing,
          heading: HeadingLevel.TITLE,
          alignment: AlignmentType.CENTER,
        }),
      );
    }

    if (data.headline) {
      children.push(
        new Paragraph({
          text: data.headline,
          heading: HeadingLevel.HEADING_2,
          alignment: AlignmentType.CENTER,
        }),
      );
    } else {
      children.push(
        new Paragraph({
          text: labels.missing,
          heading: HeadingLevel.HEADING_2,
          alignment: AlignmentType.CENTER,
        }),
      );
    }

    // Contact info
    const contacts = [data.phone, data.email, data.location].filter(Boolean);
    children.push(
      new Paragraph({
        children: [new TextRun(contacts.length ? contacts.join(' | ') : labels.missing)],
        alignment: AlignmentType.CENTER,
      }),
    );
    children.push(this.createDivider());

    // Summary
    children.push(this.createSectionHeading(labels.summary));
    children.push(new Paragraph(data.summary || labels.missing));
    children.push(new Paragraph(''));

    children.push(this.createSectionHeading(labels.targetRoles));
    children.push(
      new Paragraph(data.targetRoles.length ? data.targetRoles.join(', ') : labels.missing),
    );
    children.push(new Paragraph(''));

    // Experience
    children.push(this.createSectionHeading(labels.experience));
    if (data.experiences && data.experiences.length > 0) {
      for (const exp of data.experiences) {
        const titleLine = [exp.title, exp.company].filter(Boolean).join(' at ');
        const dateLine = [exp.start, exp.end].filter(Boolean).join(' - ');

        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: titleLine, bold: true }),
              new TextRun({ text: dateLine ? ` (${dateLine})` : '', italics: true }),
            ],
          }),
        );

        for (const resp of exp.responsibilities) {
          children.push(
            new Paragraph({
              text: resp,
              bullet: { level: 0 },
            }),
          );
        }
        children.push(new Paragraph(''));
      }
    } else children.push(new Paragraph(labels.missing));

    // Education
    children.push(this.createSectionHeading(labels.education));
    if (data.education && data.education.length > 0) {
      for (const edu of data.education) {
        const dateLine = [edu.start, edu.end].filter(Boolean).join(' - ');
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: edu.school || 'School', bold: true }),
              new TextRun({ text: dateLine ? ` (${dateLine})` : '', italics: true }),
            ],
          }),
        );
        const degreeLine = [edu.degree, edu.major].filter(Boolean).join(' in ');
        if (degreeLine) {
          children.push(new Paragraph(degreeLine));
        }
        children.push(new Paragraph(''));
      }
    } else children.push(new Paragraph(labels.missing));

    // Skills & Languages
    const skillsLang: string[] = [];
    if (data.skills && data.skills.length > 0) {
      skillsLang.push(`${labels.skills}: ${data.skills.join(', ')}`);
    }
    if (data.languages && data.languages.length > 0) {
      skillsLang.push(`${labels.languages}: ${data.languages.join(', ')}`);
    }
    children.push(this.createSectionHeading(`${labels.skills} / ${labels.languages}`));
    if (skillsLang.length > 0) {
      for (const line of skillsLang) {
        children.push(new Paragraph({ text: line, bullet: { level: 0 } }));
      }
      children.push(new Paragraph(''));
    } else children.push(new Paragraph(labels.missing));

    // Certificates
    children.push(this.createSectionHeading(labels.certificates));
    if (data.certificates && data.certificates.length > 0) {
      for (const cert of data.certificates) {
        const issuerLine = [cert.issuer, cert.year].filter(Boolean).join(', ');
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: cert.name, bold: true }),
              new TextRun(issuerLine ? ` - ${issuerLine}` : ''),
            ],
            bullet: { level: 0 },
          }),
        );
      }
    } else children.push(new Paragraph(labels.missing));

    return children;
  }

  private createSectionHeading(text: string): Paragraph {
    return new Paragraph({
      text,
      heading: HeadingLevel.HEADING_1,
      border: {
        bottom: { color: 'auto', space: 1, style: BorderStyle.SINGLE, size: 6 },
      },
    });
  }

  private createDivider(): Paragraph {
    return new Paragraph({
      border: {
        bottom: { color: 'auto', space: 1, style: BorderStyle.SINGLE, size: 6 },
      },
      spacing: { after: 200 },
    });
  }
}
