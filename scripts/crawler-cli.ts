import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@src/app.module';
import { CrawlerSchedulerService } from '@src/application/crawler/crawler-scheduler.service';
import { CrawlerReviewService } from '@src/application/crawler/crawler-review.service';
import { PrismaService } from '@src/infrastructure/db/prisma/prisma.service';
import type { source_registry } from '@prisma/client';

function printSources(rows: source_registry[]): void {
  if (rows.length === 0) {
    console.log('(no source_registry rows)');
    return;
  }
  console.log('source_registry:');
  for (const s of rows) {
    console.log(
      `  #${String(s.id)}  ${s.enabled ? '[ON ]' : '[OFF]'}  parser=${s.parser_type.padEnd(11)}  interval=${String(s.crawl_interval_minutes).padStart(4)}m  name=${s.name}`,
    );
    console.log(`        base=${s.base_url}`);
    console.log(`        jobs=${s.jobs_url}`);
    if (s.last_crawled_at) console.log(`        last_crawled : ${s.last_crawled_at.toISOString()}`);
    if (s.last_success_at) console.log(`        last_success : ${s.last_success_at.toISOString()}`);
    if (s.robots_status)    console.log(`        robots       : ${s.robots_status}`);
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
        const rows = await prisma.source_registry.findMany({ orderBy: [{ id: 'asc' }] });
        printSources(rows);
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
        console.log('  crawler:sources                     List all source_registry entries');
        console.log('  crawler:run --source <id>           Run single source pipeline + write crawl_runs');
        console.log('  crawler:run-all                     Run all due sources by cron');
        console.log('  crawler:review --id <id>            Inspect staging row');
        console.log('  crawler:review --id <id> --approve  Approve + publish to jobs table');
        console.log('  crawler:review --id <id> --reject \"reason\" [--reason-code X]');
        console.log('  crawler:review --id <id> --stale    Mark STALE + close job');
        console.log('  crawler:retry-translation --id <id> Re-run translation for staging');
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
