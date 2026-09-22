import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import { APP_ENV } from '@src/shared/env/app-env';
import { AppError } from '@src/shared/errors/app-error';
import { AppErrorCode } from '@src/shared/errors/app-error-code';
import {
  SourceImportService,
  SourceReviewService as SourceRegistryReviewService,
  SourceValidationService,
} from '@src/application/crawler/source-import.service';
import { AppErrorCode as _AppEC_resolve_unused } from '@src/shared/errors/app-error-code';
void _AppEC_resolve_unused;

function checkInternalToken(headerVal: string | undefined): void {
  const expected = APP_ENV.CRAWLER_INTERNAL_TOKEN;
  if (!expected) {
    throw new UnauthorizedException(
      'CRAWLER_INTERNAL_TOKEN is not configured; internal endpoints disabled.',
    );
  }
  if (!headerVal) {
    throw new UnauthorizedException('Missing X-JobTinder-Internal-Token header.');
  }
  if (headerVal.length !== expected.length || headerVal !== expected) {
    throw new UnauthorizedException('Invalid X-JobTinder-Internal-Token.');
  }
}

@Controller('/internal/crawler')
export class CrawlerInternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sourceImporter: SourceImportService,
    private readonly sourceReview: SourceRegistryReviewService,
    private readonly sourceValidator: SourceValidationService,
  ) {}

  @Post('/sources/import')
  async importSources(
    @Headers('x-jobtinder-internal-token') token?: string,
    @Body() body?: { csv?: string; dryRun?: boolean; allowNonHttps?: boolean },
  ) {
    checkInternalToken(token);
    if (!body?.csv || typeof body.csv !== 'string') {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_IMPORT_INVALID_CSV,
        message: `Request body.csv is required (string).`,
      });
    }
    return this.sourceImporter.importFromCsvText(body.csv, {
      dryRun: Boolean(body.dryRun),
      allowNonHttps: Boolean(body.allowNonHttps),
    });
  }

  @Get('/sources/:id')
  async getSource(
    @Headers('x-jobtinder-internal-token') token?: string,
    @Param('id') idRaw?: string,
  ) {
    checkInternalToken(token);
    if (!idRaw || !/^\d+$/.test(idRaw)) {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_NOT_FOUND,
        message: `Invalid source id ${String(idRaw)}`,
      });
    }
    const id = BigInt(idRaw);
    const row = await this.prisma.source_registry.findUnique({ where: { id } });
    if (!row) throw new AppError({ code: AppErrorCode.CRAWL_SOURCE_NOT_FOUND });
    return row;
  }

  @Post('/sources/:id/validate')
  async validateSource(
    @Headers('x-jobtinder-internal-token') token?: string,
    @Param('id') idRaw?: string,
  ) {
    checkInternalToken(token);
    if (!idRaw || !/^\d+$/.test(idRaw)) {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_NOT_FOUND,
        message: `Invalid source id ${String(idRaw)}`,
      });
    }
    return this.sourceValidator.validate(BigInt(idRaw), null);
  }

  @Post('/sources/:id/approve')
  async approveSource(
    @Headers('x-jobtinder-internal-token') token?: string,
    @Param('id') idRaw?: string,
    @Body() body?: { reason?: string },
  ) {
    checkInternalToken(token);
    if (!idRaw || !/^\d+$/.test(idRaw)) {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_NOT_FOUND,
        message: `Invalid source id ${String(idRaw)}`,
      });
    }
    return this.sourceReview.approve(BigInt(idRaw), null, body?.reason ?? null);
  }

  @Post('/sources/:id/reject')
  async rejectSource(
    @Headers('x-jobtinder-internal-token') token?: string,
    @Param('id') idRaw?: string,
    @Body() body?: { reason: string },
  ) {
    checkInternalToken(token);
    if (!idRaw || !/^\d+$/.test(idRaw)) {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_NOT_FOUND,
        message: `Invalid source id ${String(idRaw)}`,
      });
    }
    if (!body?.reason || String(body.reason).trim().length < 2) {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_VALIDATION_FAILED,
        message: `reject reason is required (>=2 chars)`,
      });
    }
    return this.sourceReview.reject(BigInt(idRaw), null, body.reason);
  }

  @Post('/sources/:id/suspend')
  async suspendSource(
    @Headers('x-jobtinder-internal-token') token?: string,
    @Param('id') idRaw?: string,
    @Body() body?: { reason?: string },
  ) {
    checkInternalToken(token);
    if (!idRaw || !/^\d+$/.test(idRaw)) {
      throw new AppError({
        code: AppErrorCode.CRAWL_SOURCE_NOT_FOUND,
        message: `Invalid source id ${String(idRaw)}`,
      });
    }
    return this.sourceReview.suspend(BigInt(idRaw), null, body?.reason ?? null);
  }

  @Get('/sources')
  async listSources(
    @Headers('x-jobtinder-internal-token') token?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limitRaw?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offsetRaw?: number,
  ) {
    checkInternalToken(token);
    const limit = Math.min(limitRaw ?? 100, 500);
    const offset = Math.max(offsetRaw ?? 0, 0);
    const [rows, count] = await Promise.all([
      this.prisma.source_registry.findMany({ take: limit, skip: offset, orderBy: [{ id: 'asc' }] }),
      this.prisma.source_registry.count(),
    ]);
    return { data: rows, meta: { limit, offset, count } };
  }

  @Get('/runs')
  async listRuns(
    @Headers('x-jobtinder-internal-token') token?: string,
    @Query('source_id') sourceIdRaw?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limitRaw?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offsetRaw?: number,
  ) {
    checkInternalToken(token);
    const limit = Math.min(limitRaw ?? 100, 500);
    const offset = Math.max(offsetRaw ?? 0, 0);
    const where =
      sourceIdRaw && /^\d+$/.test(sourceIdRaw) ? { source_id: BigInt(sourceIdRaw) } : {};
    const [rows, count] = await Promise.all([
      this.prisma.crawl_runs.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: [{ started_at: 'desc' }],
      }),
      this.prisma.crawl_runs.count({ where }),
    ]);
    return { data: rows, meta: { limit, offset, count } };
  }

  @Get('/review-queue')
  async reviewQueue(
    @Headers('x-jobtinder-internal-token') token?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limitRaw?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offsetRaw?: number,
  ) {
    checkInternalToken(token);
    const limit = Math.min(limitRaw ?? 50, 500);
    const offset = Math.max(offsetRaw ?? 0, 0);
    const where = {
      status: {
        in: [
          'REVIEW_REQUIRED',
          'QA_PENDING',
        ] as unknown as import('@prisma/client').CrawlJobStatus[],
      },
    };
    const [rows, count] = await Promise.all([
      this.prisma.crawl_jobs_staging.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: [{ created_at: 'asc' }],
        select: {
          id: true,
          status: true,
          qa_status: true,
          translation_status: true,
          qa_flags: true,
          source_id: true,
          source_job_id: true,
          source_url: true,
          detected_language: true,
          title_source: true,
          industry_source: true,
          locations_source: true,
          salary_source: true,
          created_at: true,
          updated_at: true,
        },
      }),
      this.prisma.crawl_jobs_staging.count({ where }),
    ]);
    return { data: rows, meta: { limit, offset, count } };
  }

  @Get('/staging/:id')
  async getStaging(
    @Headers('x-jobtinder-internal-token') token?: string,
    @Param('id') idRaw?: string,
  ) {
    checkInternalToken(token);
    if (!idRaw || !/^\d+$/.test(idRaw)) {
      throw new AppError({
        code: AppErrorCode.CRAWL_STAGING_NOT_FOUND,
        message: `Invalid staging id ${String(idRaw)}`,
      });
    }
    const id = BigInt(idRaw);
    const row = await this.prisma.crawl_jobs_staging.findUnique({
      where: { id },
      include: {
        job_translations: {
          orderBy: [{ language: 'asc' }, { translation_version: 'desc' }],
          distinct: ['language'],
          select: {
            id: true,
            language: true,
            title: true,
            tasks: true,
            skills: true,
            industry: true,
            locations: true,
            salary_text: true,
            shifts: true,
            benefits: true,
            translation_provider: true,
            translation_model: true,
            translation_version: true,
            qa_status: true,
            review_status: true,
            warnings: true,
            created_at: true,
            updated_at: true,
          },
        },
        snapshot: {
          select: {
            id: true,
            url: true,
            http_status: true,
            content_hash: true,
            content_type: true,
            fetched_at: true,
            parser_version: true,
            error_code: true,
            error_message: true,
          },
        },
        source: {
          select: {
            id: true,
            name: true,
            company_id: true,
            base_url: true,
            jobs_url: true,
            parser_type: true,
            enabled: true,
          },
        },
      },
    });
    if (!row) throw new AppError({ code: AppErrorCode.CRAWL_STAGING_NOT_FOUND });
    return row;
  }
}
