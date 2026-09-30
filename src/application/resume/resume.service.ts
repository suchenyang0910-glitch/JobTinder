import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { AuditRepository } from '@src/infrastructure/db/repositories/audit.repository';
import { ResumeAiService } from './resume-ai.service';
import { ResumeLanguageService, type DetectedResumeLanguage } from './resume-language.service';
import { ResumeDocxRenderer } from '@src/infrastructure/resume/resume-docx-renderer';
import { ResumeDraftZod, type ResumeDraft } from './resume.schema';
import * as crypto from 'crypto';
import * as fs from 'node:fs/promises';

@Injectable()
export class ResumeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditRepo: AuditRepository,
    private readonly aiService: ResumeAiService,
    private readonly languageService: ResumeLanguageService,
    private readonly docxRenderer: ResumeDocxRenderer,
  ) {}

  async createDraft(userId: bigint, input: string, outputLanguage?: DetectedResumeLanguage) {
    if (input.length > 20000) throw new BadRequestException('Resume input is too long');
    const existing = await this.prisma.resume_documents.findUnique({
      where: { user_id: userId },
    });
    if (existing) {
      throw new ConflictException('User already has a resume document');
    }

    const detectedLang = await this.languageService.detect(input);
    const selectedLanguage = outputLanguage ?? detectedLang;
    const hash = crypto.createHash('sha256').update(input).digest('hex');

    const draft = await this.prisma.resume_documents.create({
      data: {
        user_id: userId,
        status: 'DRAFT',
        input_language: detectedLang,
        output_language: selectedLanguage === 'mixed' ? null : selectedLanguage,
        source_text_hash: hash,
        raw_input: input,
        structured_json: {},
      },
    });

    await this.auditRepo.record({
      action: 'RESUME_DRAFT_CREATED',
      objectType: 'resume_document',
      objectId: draft.id,
      actorId: userId,
      now: new Date(),
      metadata: { status: detectedLang },
    });
    if (selectedLanguage !== 'mixed')
      return (await this.completeDraft(userId, selectedLanguage)) ?? draft;
    return draft;
  }

  async completeDraft(userId: bigint, language: Exclude<DetectedResumeLanguage, 'mixed'>) {
    const doc = await this.prisma.resume_documents.findUnique({ where: { user_id: userId } });
    if (!doc || !doc.raw_input || doc.status !== 'DRAFT')
      throw new NotFoundException('Resume draft not found');
    const parsed = await this.aiService.extractDraft(doc.raw_input, language);
    const keepInputForRetry = parsed.warnings.some((warning) =>
      warning.startsWith('AI could not structure'),
    );
    await this.prisma.resume_documents.updateMany({
      where: { id: doc.id, status: 'DRAFT', raw_input: { not: null } },
      data: {
        structured_json: parsed as object,
        output_language: language,
        raw_input: keepInputForRetry ? doc.raw_input : null,
      },
    });
    return this.prisma.resume_documents.findUnique({ where: { id: doc.id } });
  }

  async replaceInput(userId: bigint, input: string) {
    if (input.length < 20 || input.length > 20000)
      throw new BadRequestException('Resume input must be 20–20,000 characters');
    const doc = await this.prisma.resume_documents.findUnique({ where: { user_id: userId } });
    if (!doc || doc.status === 'DELETED') throw new NotFoundException('Resume not found');
    if (doc.status === 'GENERATING')
      throw new ConflictException('Resume generation is in progress');
    if (doc.file_path)
      await fs.unlink(doc.file_path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    const detected = await this.languageService.detect(input);
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    await this.prisma.resume_documents.update({
      where: { id: doc.id },
      data: {
        status: 'DRAFT',
        input_language: detected,
        output_language: detected === 'mixed' ? null : detected,
        source_text_hash: hash,
        raw_input: input,
        structured_json: {},
        file_path: null,
        file_sha256: null,
        file_size_bytes: null,
      },
    });
    if (detected !== 'mixed') return this.completeDraft(userId, detected);
    return this.prisma.resume_documents.findUnique({ where: { id: doc.id } });
  }

  async retryDraft(userId: bigint) {
    const doc = await this.prisma.resume_documents.findUnique({ where: { user_id: userId } });
    if (!doc?.raw_input || !doc.output_language || doc.status !== 'DRAFT') {
      throw new BadRequestException('There is no AI draft to retry');
    }
    return this.completeDraft(
      userId,
      doc.output_language as Exclude<DetectedResumeLanguage, 'mixed'>,
    );
  }

  async cancelUnprocessedDraft(userId: bigint): Promise<void> {
    await this.prisma.resume_documents.deleteMany({
      where: { user_id: userId, status: 'DRAFT', raw_input: { not: null } },
    });
  }

  async updateDraft(userId: bigint, fields: Partial<ResumeDraft>): Promise<void> {
    const doc = await this.prisma.resume_documents.findUnique({
      where: { user_id: userId },
    });
    if (!doc) throw new NotFoundException('Resume not found');

    if (doc.status === 'DELETED') throw new NotFoundException('Resume deleted');
    if (doc.status !== 'DRAFT' && doc.status !== 'READY') {
      throw new BadRequestException('Cannot edit resume in current state');
    }

    const currentData = doc.structured_json as unknown as ResumeDraft;
    const newData = ResumeDraftZod.parse({ ...currentData, ...fields });

    await this.prisma.resume_documents.update({
      where: { user_id: userId },
      data: { structured_json: newData as object },
    });

    await this.auditRepo.record({
      action: 'RESUME_DRAFT_UPDATED',
      objectType: 'resume_document',
      objectId: doc.id,
      actorId: userId,
      now: new Date(),
      metadata: { source: 'user' },
    });
  }

  async confirmAndGenerate(userId: bigint): Promise<void> {
    const doc = await this.prisma.resume_documents.findUnique({
      where: { user_id: userId },
    });
    if (!doc) throw new NotFoundException('Resume not found');
    if (!['DRAFT', 'FAILED', 'READY'].includes(doc.status))
      throw new ConflictException('Resume is not ready to generate');
    const claimed = await this.prisma.resume_documents.updateMany({
      where: { user_id: userId, status: doc.status },
      data: { status: 'GENERATING' },
    });
    if (claimed.count !== 1) throw new ConflictException('Resume is already being generated');

    await this.auditRepo.record({
      action: 'RESUME_GENERATION_STARTED',
      objectType: 'resume_document',
      objectId: doc.id,
      actorId: userId,
      now: new Date(),
      metadata: {},
    });

    let generatedPath: string | undefined;
    try {
      const data = doc.structured_json as unknown as ResumeDraft;
      const newVersion = doc.generation_version + 1;
      const result = await this.docxRenderer.render(
        data,
        userId,
        newVersion,
        (doc.output_language ?? 'en') as DetectedResumeLanguage,
      );
      generatedPath = result.filePath;

      await this.prisma.resume_documents.update({
        where: { user_id: userId },
        data: {
          status: 'READY',
          file_path: result.filePath,
          file_sha256: result.sha256,
          file_size_bytes: result.sizeBytes,
          generation_version: newVersion,
          generated_at: new Date(),
        },
      });

      await this.auditRepo.record({
        action: 'RESUME_GENERATED',
        objectType: 'resume_document',
        objectId: doc.id,
        actorId: userId,
        now: new Date(),
        metadata: {
          version: newVersion,
          file_size_bytes: result.sizeBytes,
        },
      });
    } catch (e) {
      if (generatedPath) await fs.unlink(generatedPath).catch(() => undefined);
      await this.prisma.resume_documents.update({
        where: { user_id: userId },
        data: { status: doc.status === 'READY' ? 'READY' : 'FAILED' },
      });
      await this.auditRepo.record({
        action: 'RESUME_GENERATION_FAILED',
        objectType: 'resume_document',
        objectId: doc.id,
        actorId: userId,
        now: new Date(),
        metadata: { reason_code: 'GENERATION_FAILED' },
      });
      throw e;
    }
  }

  async getDownloadPath(userId: bigint): Promise<string> {
    const doc = await this.prisma.resume_documents.findUnique({
      where: { user_id: userId },
    });
    if (!doc || doc.status !== 'READY' || !doc.file_path) {
      throw new NotFoundException('Resume not ready');
    }

    await this.auditRepo.record({
      action: 'RESUME_DOWNLOADED',
      objectType: 'resume_document',
      objectId: doc.id,
      actorId: userId,
      now: new Date(),
      metadata: {},
    });

    return doc.file_path;
  }

  async delete(userId: bigint): Promise<boolean> {
    const doc = await this.prisma.resume_documents.findUnique({ where: { user_id: userId } });
    if (!doc) return false;
    if (doc.status === 'DELETED') return true;
    if (doc.status === 'GENERATING')
      throw new ConflictException('Resume generation is in progress');
    if (doc.file_path) {
      await fs.unlink(doc.file_path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    if (doc.status === 'READY') {
      await this.prisma.resume_documents.update({
        where: { user_id: userId },
        data: {
          status: 'DELETED',
          structured_json: {},
          raw_input: null,
          source_text_hash: null,
          file_path: null,
          file_sha256: null,
          file_size_bytes: null,
        },
      });
    } else {
      // Before a DOCX is successfully generated, cancellation/failure consumes no free quota.
      await this.prisma.resume_documents.delete({ where: { user_id: userId } });
    }

    await this.auditRepo.record({
      action: 'RESUME_DELETED',
      objectType: 'resume_document',
      objectId: doc.id,
      actorId: userId,
      now: new Date(),
      metadata: {},
    });
    return doc.status === 'READY';
  }
}
