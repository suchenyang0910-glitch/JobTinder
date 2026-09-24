process.env.CRAWLER_CLI_MODE = 'true';
process.env.NO_COLOR ??= '0';

if (process.platform === 'win32') {
  try {
    const { execSync } = require('node:child_process');
    execSync('chcp 65001 >NUL 2>&1', { stdio: 'ignore' });
  } catch {
    /* best-effort */
  }
}

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@src/app.module';
import { CrawlerSchedulerService } from '@src/application/crawler/crawler-scheduler.service';
import { CrawlerReviewService } from '@src/application/crawler/crawler-review.service';
import {
  SourceImportService,
  SourceReviewService as SourceRegistryReviewService,
  SourceValidationService,
  type PerRowReport,
} from '@src/application/crawler/source-import.service';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import type { source_registry } from '@prisma/client';
import { SOURCE_TYPE_LABELS } from '@src/domain/crawler/source-review-status-machine';

const SOURCE_TYPE_LABELS_CLI: Record<string, string> =
  process.platform === 'win32'
    ? {
        OFFICIAL_COMPANY_WEBSITE: 'Official Site',
        GOVERNMENT_JOB_PORTAL: 'Govt Job Portal',
        CHAMBER_DIRECTORY: 'Chamber Dir.',
        THIRD_PARTY_JOB_BOARD: '3rd-Party Board',
        SOCIAL_PAGE: 'Social Page',
      }
    : SOURCE_TYPE_LABELS;

function printSources(rows: source_registry[]): void {
  if (rows.length === 0) {
    console.log('(no source_registry rows)');
    return;
  }
  console.log('source_registry:');
  for (const s of rows) {
    const label =
      SOURCE_TYPE_LABELS_CLI[s.source_type as keyof typeof SOURCE_TYPE_LABELS_CLI] ?? s.source_type;
    console.log(
      `  #${String(s.id)}  ${s.enabled ? '[ON ]' : '[OFF]'}  review=${String(s.review_status).padEnd(9)}  score=${String(s.verification_score ?? '-').padStart(3)}  parser=${s.parser_type.padEnd(11)}  type=${label.padEnd(16)}  name=${s.name}`,
    );
    console.log(`        base=${s.base_url}`);
    console.log(`        jobs=${s.jobs_url}`);
    if (s.city || s.industry) console.log(`        city/industry: ${s.city ?? '-'} / ${s.industry ?? '-'}`);
    if (s.discovery_method) console.log(`        discovered via: ${s.discovery_method}`);
    if (s.last_crawled_at) console.log(`        last_crawled : ${s.last_crawled_at.toISOString()}`);
    if (s.last_success_at) console.log(`        last_success : ${s.last_success_at.toISOString()}`);
    if (s.robots_status)    console.log(`        robots       : ${s.robots_status}`);
    if (s.last_validation_at) {
      const e = s.validation_error ? ` (err: ${s.validation_error.slice(0, 180)})` : '';
      console.log(`        validated    : ${s.last_validation_at.toISOString()}${e}`);
    }
  }
}

function printImportReport(result: Awaited<ReturnType<SourceImportService['importFromCsvFile']>>) {
  console.log(`Import report (dry_run=${result.dryRun}):`);
  console.log(`  total_rows     : ${result.totalRows}`);
  console.log(`  parse_errors   : ${result.parseErrors.length}`);
  for (const pe of result.parseErrors) console.log(`    [row ${pe.row}] ${pe.message}`);
  console.log(`  inserted       : ${result.inserted}`);
  console.log(`  duplicates     : ${result.duplicates}`);
  console.log(`  failed         : ${result.failed}`);
  for (const r of result.importReports) {
    const line: string[] = [
      `row ${String(r.row).padStart(3)}`,
      r.imported ? 'IMPORTED' : r.duplicateOfId ? 'DUP' : 'SKIP',
      String(r.insertedId ?? r.duplicateOfId ?? '-').padStart(8),
      `score=${String(r.verification_score ?? '-').padStart(3)}`,
      String(r.review_status ?? '-').padEnd(9),
      r.name,
    ];
    console.log('  ' + line.join(' | '));
    if (r.errors?.length) for (const e of r.errors) console.log(`    ERR: ${e}`);
    if (r.warnings?.length) for (const w of r.warnings) console.log(`    WRN: ${w}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const prisma = app.get(PrismaService);
    switch (cmd) {
      case 'sources': {
        const collectMulti = (flag: string): string | undefined => {
          const idx = argv.indexOf(flag);
          if (idx < 0) return undefined;
          const parts: string[] = [];
          for (let j = idx + 1; j < argv.length; j++) {
            const a = argv[j] as string;
            if (a.startsWith('--')) break;
            parts.push(a);
          }
          return parts.join(' ').trim() || undefined;
        };

        const limitArg = argv.indexOf('--limit');
        const offsetArg = argv.indexOf('--offset');
        const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) : undefined;
        const offset = offsetArg >= 0 ? Number(argv[offsetArg + 1]) : undefined;
        const city = collectMulti('--city');
        const status = collectMulti('--status');
        const type = collectMulti('--type');
        const parser = collectMulti('--parser');

        if ((limitArg >= 0 && (!Number.isFinite(limit) || (limit as number) < 1)) ||
            (offsetArg >= 0 && (!Number.isFinite(offset) || (offset as number) < 0))) {
          console.error('Usage: crawler:sources [--limit N] [--offset M] [--city "Phnom Penh"] [--status PENDING|APPROVED|SUSPENDED|REJECTED] [--type OFFICIAL_COMPANY_WEBSITE|…] [--parser STATIC_HTML|…]');
          process.exit(2);
        }

        const where: Record<string, unknown> = {};
        if (city) where.city = city;
        if (status) where.review_status = status.toUpperCase();
        if (type) where.source_type = type.toUpperCase();
        if (parser) where.parser_type = parser.toUpperCase();

        const hasWhere = Object.keys(where).length > 0;
        const [total, matching, rows] = await Promise.all([
          prisma.source_registry.count(),
          prisma.source_registry.count({ where: hasWhere ? where : undefined }),
          prisma.source_registry.findMany({
            where: hasWhere ? where : undefined,
            orderBy: [{ id: 'asc' }],
            skip: offset,
            take: limit,
          }),
        ]);
        const header =
          `source_registry: matching=${matching} of total=${total}` +
          (hasWhere ? ` where=${JSON.stringify(where)}` : '') +
          (limit || offset ? ` (page ${limit ?? '∞'}; skip=${offset ?? 0})` : '');
        console.log(header);
        if (rows.length === 0) {
          console.log('  (no rows)');
        } else {
          printSources(rows);
        }
        break;
      }
      case 'import-sources': {
        const fileIdx = argv.indexOf('--file');
        const filePath = fileIdx >= 0 ? argv[fileIdx + 1] : argv[1];
        if (!filePath) {
          console.error('Usage: crawler:import-sources --file sources.csv [--dry-run] [--skip-http]');
          process.exit(2);
        }
        const dryRun = argv.includes('--dry-run');
        const skipLiveHttp = argv.includes('--skip-http');
        const importer = app.get(SourceImportService);
        const result = await importer.importFromCsvFile(filePath, { dryRun, actorId: null, skipLiveHttp });
        printImportReport(result);
        break;
      }
      case 'validate-source': {
        const idx = argv.indexOf('--id');
        const rawId = idx >= 0 ? argv[idx + 1] : argv[1];
        if (!rawId || !/^\d+$/.test(rawId)) {
          console.error('Usage: crawler:validate-source --id <sourceId>');
          process.exit(2);
        }
        const svc = app.get(SourceValidationService);
        const r = await svc.validate(BigInt(rawId), null);
        console.log(`Validated source #${rawId}`);
        console.log(`  score : ${String(r.verification_score ?? '-')}`);
        console.log(`  review: ${r.review_status}`);
        console.log(`  robots: ${String(r.robots_status ?? '-')}`);
        if (r.verification_notes) console.log(`  notes : ${r.verification_notes}`);
        if (r.validation_error) console.log(`  err   : ${r.validation_error}`);
        break;
      }
      case 'approve-source': {
        const idx = argv.indexOf('--id');
        const rawId = idx >= 0 ? argv[idx + 1] : argv[1];
        if (!rawId || !/^\d+$/.test(rawId)) {
          console.error('Usage: crawler:approve-source --id <sourceId> [--reason "..."]');
          process.exit(2);
        }
        const svc = app.get(SourceRegistryReviewService);
        const reasonIdx = argv.indexOf('--reason');
        const reason = reasonIdx >= 0 ? argv[reasonIdx + 1] ?? null : null;
        const r = await svc.approve(BigInt(rawId), null, reason);
        console.log(`Approved source #${rawId} review=${r.review_status} enabled=${r.enabled}`);
        break;
      }
      case 'reject-source': {
        const idx = argv.indexOf('--id');
        const rawId = idx >= 0 ? argv[idx + 1] : argv[1];
        if (!rawId || !/^\d+$/.test(rawId)) {
          console.error('Usage: crawler:reject-source --id <sourceId> --reason "..."');
          process.exit(2);
        }
        const svc = app.get(SourceRegistryReviewService);
        const reasonIdx = argv.indexOf('--reason');
        const reason = (reasonIdx >= 0 ? argv[reasonIdx + 1] : null) ?? 'unspecified';
        const r = await svc.reject(BigInt(rawId), null, reason);
        console.log(`Rejected source #${rawId} review=${r.review_status} enabled=${r.enabled}`);
        break;
      }
      case 'suspend-source': {
        const idx = argv.indexOf('--id');
        const rawId = idx >= 0 ? argv[idx + 1] : argv[1];
        if (!rawId || !/^\d+$/.test(rawId)) {
          console.error('Usage: crawler:suspend-source --id <sourceId> [--reason "..."]');
          process.exit(2);
        }
        const svc = app.get(SourceRegistryReviewService);
        const reasonIdx = argv.indexOf('--reason');
        const reason = reasonIdx >= 0 ? argv[reasonIdx + 1] ?? null : null;
        const r = await svc.suspend(BigInt(rawId), null, reason);
        console.log(`Suspended source #${rawId} review=${r.review_status} enabled=${r.enabled}`);
        break;
      }
      case 'run': {
        const idx = argv.indexOf('--source');
        const rawId = idx >= 0 ? argv[idx + 1] : argv[1];
        if (!rawId || !/^\d+$/.test(rawId)) {
          console.error('Usage: crawler:run --source <id>');
          process.exit(2);
        }
        const scheduler = app.get(CrawlerSchedulerService);
        const stats = await scheduler.runSourceWithRunRecord(BigInt(rawId));
        console.log(`Run complete for source #${rawId}`);
        console.log(`  new       : ${stats.newCount}`);
        console.log(`  changed   : ${stats.changedCount}`);
        console.log(`  closed    : ${stats.closedCount}`);
        console.log(`  translated: ${stats.translatedCount}`);
        console.log(`  review_req: ${stats.reviewRequiredCount}`);
        console.log(`  errors    : ${stats.errorCount}`);
        if (stats.lastError) console.log(`  last_error: ${stats.lastError}`);
        break;
      }
      case 'run-all': {
        const scheduler = app.get(CrawlerSchedulerService);
        await scheduler.runAllDueSources();
        console.log('run-all due-sources sweep complete.');
        break;
      }
      case 'review': {
        const idx = argv.indexOf('--id');
        const rawId = idx >= 0 ? argv[idx + 1] : argv[1];
        if (!rawId || !/^\d+$/.test(rawId)) {
          console.error('Usage: crawler:review --id <stagingId> [--approve | --reject \"reason\"] [--reason-code code]');
          process.exit(2);
        }
        const review = app.get(CrawlerReviewService);
        const id = BigInt(rawId);
        if (argv.includes('--approve')) {
          const res = await review.approve(id, null);
          console.log(`Approved staging #${String(id)} -> job #${String(res.jobId)}`);
        } else if (argv.includes('--reject')) {
          const rIdx = argv.indexOf('--reject');
          const reason = argv[rIdx + 1] ?? 'manual reject';
          const rcIdx = argv.indexOf('--reason-code');
          const reasonCode = rcIdx >= 0 ? argv[rcIdx + 1] : undefined;
          await review.reject(id, null, reason, reasonCode);
          console.log(`Rejected staging #${String(id)}: ${reason}`);
        } else if (argv.includes('--stale')) {
          await review.markStale(id, null);
          console.log(`Marked staging #${String(id)} as STALE`);
        } else {
          const s = await prisma.crawl_jobs_staging.findUnique({
            where: { id },
            include: {
              job_translations: { distinct: ['language'], orderBy: [{ language: 'asc' }], select: { language: true, title: true, salary_text: true, warnings: true, qa_status: true, review_status: true } },
              snapshot: { select: { url: true, http_status: true, fetched_at: true } },
              source: { select: { name: true } },
            },
          });
          if (!s) { console.error(`staging ${rawId} not found`); process.exit(1); }
          console.log(`Staging #${String(id)}  status=${s.status}  qa=${s.qa_status}  translation=${s.translation_status}`);
          console.log(`  source    : ${s.source?.name}  (job_id=${s.source_job_id})`);
          console.log(`  source_url: ${s.source_url}`);
          if (s.snapshot) console.log(`  snapshot  : ${s.snapshot.http_status ?? ''} @ ${s.snapshot.fetched_at?.toISOString() ?? ''}  ${s.snapshot.url}`);
          console.log(`  title_src : ${s.title_source ?? ''}`);
          console.log(`  salary    : ${s.salary_source ?? 'NOT_PROVIDED'}`);
          console.log(`  locations : ${s.locations_source ?? ''}`);
          if (s.qa_flags?.length) console.log(`  qa_flags  : ${s.qa_flags.join(', ')}`);
          if (s.reject_reason) console.log(`  reject    : ${s.reject_reason}`);
          for (const t of s.job_translations) {
            console.log(`  [${t.language}] title=\"${t.title ?? ''}\" salary=\"${t.salary_text ?? ''}\" qa=${t.qa_status} review=${t.review_status}`);
            if (t.warnings?.length) for (const w of t.warnings) console.log(`    warn: ${w}`);
          }
        }
        break;
      }
      case 'retry-translation': {
        const idx = argv.indexOf('--id');
        const rawId = idx >= 0 ? argv[idx + 1] : argv[1];
        if (!rawId || !/^\d+$/.test(rawId)) {
          console.error('Usage: crawler:retry-translation --id <stagingId>');
          process.exit(2);
        }
        const review = app.get(CrawlerReviewService);
        const r = await review.retryTranslation(BigInt(rawId), null);
        console.log(`Retry translation for staging #${rawId}: added=${r.added}`);
        break;
      }
      case 'help':
      case '--help':
      case '-h':
      default:
        console.log('JobTinder Crawler CLI');
        console.log('  crawler:sources                               List all source_registry entries (review/score/new columns)');
        console.log('  crawler:import-sources --file <csv> [--dry-run]  CSV import (dry-run no DB write)');
        console.log('  crawler:validate-source --id <id>           Re-verify base/jobs_url + robots + score');
        console.log('  crawler:approve-source --id <id>            Set review=APPROVED + enabled=true');
        console.log('  crawler:reject-source --id <id> --reason X  Set review=REJECTED + enabled=false');
        console.log('  crawler:suspend-source --id <id> [--reason] Set review=SUSPENDED + enabled=false');
        console.log('  crawler:run --source <id>                   Run single source pipeline + write crawl_runs');
        console.log('  crawler:run-all                             Run all APPROVED due sources by cron');
        console.log('  crawler:review --id <id>                    Inspect staging row');
        console.log('  crawler:review --id <id> --approve          Approve + publish to jobs table');
        console.log('  crawler:review --id <id> --reject "reason" [--reason-code X]');
        console.log('  crawler:review --id <id> --stale            Mark STALE + close job');
        console.log('  crawler:retry-translation --id <id>         Re-run translation for staging');
        break;
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
