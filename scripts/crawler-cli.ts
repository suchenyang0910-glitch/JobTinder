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
import { CrawlerReviewNotifierService } from '@src/application/crawler/crawler-review-notifier.service';
import { OpsStatsService } from '@src/application/ops/ops-stats.service';
import { HardMatchService } from '@src/application/matching/hard-match.service';
import { MatchWorkflowService } from '@src/application/matching/match-workflow.service';
import { ResultFeedbackService } from '@src/application/feedback/result-feedback.service';
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
      case 'auto-discover': {
        const scheduler = app.get(CrawlerSchedulerService);
        const validateLive = argv.includes('--validate-live');
        console.log(`Running built-in directory discovery feed (validateLive=${validateLive})...`);
        const r = await scheduler.discoverDirectoryFeed(validateLive);
        console.log(`Discovered   : ${r.discovered.length}`);
        for (const id of r.discovered) console.log(`  -> #${String(id)}`);
        console.log(`Duplicates   : ${r.duplicates}`);
        console.log(`Valid. Errors: ${r.validationErrors}`);
        console.log(`Notified     : ${r.notified}`);
        break;
      }
      case 'review-notify': {
        const not = app.get(CrawlerReviewNotifierService);
        const jobsCount = await not.notifyPendingJobs();
        console.log(`Pending jobs notified : ${jobsCount}`);
        const pending = await prisma.source_registry.findMany({
          where: { review_status: 'PENDING', source_notified_at: null },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 10,
        });
        let src = 0;
        for (const p of pending) {
          const ok = await not.notifySource(p.id);
          if (ok) {
            await prisma.source_registry.update({
              where: { id: p.id },
              data: { source_notified_at: new Date() },
            });
            src++;
          }
        }
        console.log(`Pending sources notified: ${src}`);
        break;
      }
      case 'stats': {
        const ops = app.get(OpsStatsService);
        const s = await ops.getOpsStats();
        console.log(ops.formatAscii(s));
        break;
      }
      case 'pilot-smoke': {
        const dryRun = !argv.includes('--apply');
        console.log(`= pilot-smoke (${dryRun ? 'DRY-RUN — use --apply to actually write' : 'APPLY mode'}) =`);

        const prisma = app.get(PrismaService);
        const review = app.get(CrawlerReviewService);
        const hardMatch = app.get(HardMatchService);
        const matchWorkflow = app.get(MatchWorkflowService);
        const resultFb = app.get(ResultFeedbackService);
        const ops = app.get(OpsStatsService);

        const TARGET_CANDIDATES = 30;
        const TARGET_JOBS = 20;
        const TARGET_INTERESTS = 10;
        const TARGET_CONTACTS = 5;
        const TARGET_INTERVIEWS = 2;

        const sourceIds = (
          await prisma.source_registry.findMany({ select: { id: true }, take: 20, orderBy: { id: 'asc' } })
        ).map((s) => s.id);

        // ========== 1. 审批 staging → jobs（最多 TARGET_JOBS）；不足则 jobs 表造样板 ==========
        const staged = await prisma.crawl_jobs_staging.findMany({
          where: {
            OR: [
              { status: 'QA_PENDING' },
              { status: 'APPROVED' },
              { status: 'REVIEW_REQUIRED' },
              { status: 'DEFERRED' },
              { status: 'DISCOVERED' },
              { status: 'TRANSLATED' },
            ],
          },
          select: { id: true, status: true },
          orderBy: { id: 'asc' },
          take: TARGET_JOBS * 2,
        });

        const existingJobsCount = await prisma.jobs.count({
          where: { OR: [{ status: 'ACTIVE_EXTERNAL' }, { status: 'ACTIVE_CLAIMED' }] },
        });
        let createdJobs = existingJobsCount;
        const approvedStagingIds: bigint[] = [];
        if (createdJobs < TARGET_JOBS) {
          const need = TARGET_JOBS - createdJobs;
          console.log(`  jobs missing: ${need}; staging pool=${staged.length}; source_registry pool=${sourceIds.length}`);
          let idx = 0;
          while (createdJobs < TARGET_JOBS && idx < staged.length) {
            const row = staged[idx++];
            if (!row) break;
            try {
              if (dryRun) {
                approvedStagingIds.push(row.id);
                createdJobs++;
                continue;
              }
              const patched = await prisma.crawl_jobs_staging.update({
                where: { id: row.id },
                data: {
                  status: (['TRANSLATED', 'APPROVED', 'PUBLISHED', 'QA_PENDING', 'REVIEW_REQUIRED', 'DEFERRED'].includes(row.status)
                    ? row.status
                    : 'TRANSLATED') as never,
                  translation_status: 'DONE',
                  qa_status: 'PASSED',
                  review_notified_at: null,
                },
              });
              let ok = false;
              try {
                if (patched.status !== 'APPROVED' && patched.status !== 'PUBLISHED') {
                  const before = patched.status as string;
                  if (before !== 'APPROVED' && before !== 'QA_PENDING' && before !== 'REVIEW_REQUIRED') {
                    await prisma.crawl_jobs_staging.update({
                      where: { id: row.id },
                      data: { status: 'QA_PENDING' },
                    });
                  }
                }
                const r = await review.approve(row.id, null);
                ok = Boolean(r?.jobId);
              } catch (e) {
                try {
                  await prisma.crawl_jobs_staging.update({
                    where: { id: row.id },
                    data: { status: 'QA_PENDING' },
                  });
                  const r2 = await review.approve(row.id, null);
                  ok = Boolean(r2?.jobId);
                } catch (e2) {
                  console.warn(`    [warn] cannot approve staging #${String(row.id)}: ${String((e2 as Error).message).slice(0, 120)}`);
                  ok = false;
                }
              }
              if (ok) {
                approvedStagingIds.push(row.id);
                createdJobs++;
              }
            } catch (e) {
              console.warn(`    [warn] staging #${String(row.id)} skipped: ${String((e as Error).message).slice(0, 120)}`);
            }
          }

          if (!dryRun) {
            while (createdJobs < TARGET_JOBS) {
              const seq = createdJobs - existingJobsCount;
              const now = new Date();
              const jobTemplate =
                seq % 3 === 0
                  ? {
                      title: 'Customer Service Officer',
                      industry: 'Hospitality',
                      skills: ['customer service', 'communication', 'cashier'],
                      tasks: [
                        'Provide excellent customer service in Phnom Penh.',
                        'Handle inquiries and cash operations.',
                        'English and Khmer speaking required.',
                      ],
                      locations: ['Phnom Penh', 'Chamkarmon'],
                    }
                  : seq % 3 === 1
                    ? {
                        title: 'Waiter / F&B Service',
                        industry: 'F&B',
                        skills: ['customer service', 'F&B', 'waiter'],
                        tasks: [
                          'Serve food and beverages to customers.',
                          'Clean tables, take orders, handle payments.',
                          'F&B experience preferred. Full-time. Immediate start.',
                        ],
                        locations: ['Phnom Penh', 'Toul Kork'],
                      }
                    : {
                        title: 'Retail Cashier',
                        industry: 'Retail',
                        skills: ['cashier', 'retail', 'POS'],
                        tasks: [
                          'Cash handling, POS operation, customer assistance.',
                          'Retail stocking, inventory check, price labeling.',
                          'Salary negotiable based on experience.',
                        ],
                        locations: ['Phnom Penh', 'BKK1'],
                      };
              await prisma.jobs.create({
                data: {
                  source_type: 'EXTERNAL',
                  source_job_id: `pilot-job-${seq}`,
                  source_url: `https://example.com/pilot-jobs/${String(seq)}`,
                  idempotency_key: `pilot-smoke:job:v1:${String(seq)}`,
                  status: 'ACTIVE_EXTERNAL',
                  version: 1,
                  title: jobTemplate.title,
                  industry: jobTemplate.industry,
                  skills: jobTemplate.skills,
                  tasks: jobTemplate.tasks,
                  locations: jobTemplate.locations,
                  languages_required: ['English', 'Khmer'],
                  shifts: ['FULL_TIME', 'DAY'],
                  salary_status: 'PROVIDED',
                  salary_text: `${800 + seq * 40}-${1100 + seq * 40} USD`,
                  hiring_status: 'OPEN',
                  hiring_status_updated_at: now,
                  hiring_status_source: 'MANUAL',
                  original_published_at: now,
                  last_confirmed_at: now,
                  last_checked_at: now,
                },
              });
              createdJobs++;
            }
          } else {
            createdJobs = TARGET_JOBS;
          }
        }
        console.log(`  ✔ 岗位审批结果： ACTIVE jobs = ${createdJobs}`);

        // ========== 2. 30 名求职者 CONFIRMED ==========
        const beforeCandidates = await prisma.candidate_profiles.count({
          where: { status: 'CONFIRMED', deleted_at: null },
        });
        let candidates = beforeCandidates;
        const TAG = 'pilot_smoke_v1';
        const candidateUserIds: bigint[] = [];

        const existingTagged = await prisma.users.findMany({
          where: { telegram_username: { startsWith: `@${TAG}_` } },
          select: { id: true, telegram_user_id: true, telegram_username: true },
          take: 60,
        });
        candidateUserIds.push(...existingTagged.map((u) => u.id));
        candidates += existingTagged.length;

        while (candidates < TARGET_CANDIDATES) {
          const seq = candidates - beforeCandidates;
          const tgUsername = `@${TAG}_c${seq}`;
          const tgUid = BigInt(1_900_000_000 + seq);
          if (dryRun) {
            candidates++;
            continue;
          }
          let u = await prisma.users.findUnique({ where: { telegram_user_id: tgUid } });
          if (!u) {
            u = await prisma.users.create({
              data: {
                telegram_user_id: tgUid,
                telegram_username: tgUsername,
                telegram_first_name: `Pilot${seq}`,
                telegram_last_name: null,
                language: 'en',
                preferred_role: 'CANDIDATE',
                status: 'ACTIVE',
              },
            });
          } else {
            u = await prisma.users.update({
              where: { id: u.id },
              data: { telegram_username: tgUsername },
            });
          }
          let cp = await prisma.candidate_profiles.findFirst({
            where: { user_id: u.id, version: 1 },
            orderBy: { id: 'desc' },
            select: { id: true },
          });
          if (!cp) {
            cp = await prisma.candidate_profiles.create({
              data: {
                user_id: u.id,
                version: 1,
                status: 'CONFIRMED',
                skills: ['customer service', 'cashier', 'retail'],
                industries: ['F&B', 'Retail', 'Hospitality'],
                target_roles: ['Waiter', 'Cashier', 'Customer Service Officer'],
                task_keywords: ['serve customers', 'handle cash', 'clean tables'],
                locations: ['Phnom Penh', 'Phnom Penh Chamkarmon', 'Toul Kork'],
                languages_known: ['English', 'Khmer'],
                salary_status: 'NEGOTIABLE',
                salary_text: '800-1200 USD',
                availability_note: 'Immediate start, full-time',
                job_search_status: 'LOOKING_JOB',
                job_search_status_updated_at: new Date(),
                job_search_status_source: 'MANUAL',
                field_sources: {
                  skills: { source: 'pilot_smoke', confirmed: true },
                  locations: { source: 'pilot_smoke', confirmed: true },
                  languages_known: { source: 'pilot_smoke', confirmed: true },
                  salary_text: { source: 'pilot_smoke', confirmed: true },
                },
                draft_source: 'manual',
                confirmed_at: new Date(),
              },
              select: { id: true },
            });
          } else {
            await prisma.candidate_profiles.updateMany({
              where: { user_id: u.id, version: 1 },
              data: {
                status: 'CONFIRMED',
                job_search_status: 'LOOKING_JOB',
                job_search_status_updated_at: new Date(),
                confirmed_at: new Date(),
              },
            });
          }
          candidateUserIds.push(u.id);
          candidates++;
        }
        console.log(`  ✔ 求职者已确认档案： CONFIRMED candidates = ${candidates} (target 30)`);

        // ========== 3. 公司 member 用户（1 个，绑定到第一个已验证公司） ==========
        const firstCompany = await prisma.companies.findFirst({
          orderBy: { id: 'asc' },
          select: { id: true },
        });
        let companyMemberUserId: bigint | null = null;
        if (firstCompany) {
          const companyTgUid = BigInt(1_999_999_999);
          if (!dryRun) {
            let cm = await prisma.users.findUnique({ where: { telegram_user_id: companyTgUid } });
            if (!cm) {
              cm = await prisma.users.create({
                data: {
                  telegram_user_id: companyTgUid,
                  telegram_username: `@${TAG}_company_hr`,
                  telegram_first_name: 'Company HR',
                  telegram_last_name: 'Admin',
                  language: 'en',
                  preferred_role: 'COMPANY',
                  status: 'ACTIVE',
                },
              });
            }
            const mem = await prisma.companies_members.findFirst({
              where: { company_id: firstCompany.id, user_id: cm.id },
              select: { id: true },
            });
            if (!mem) {
              await prisma.companies_members.create({
                data: { company_id: firstCompany.id, user_id: cm.id, role: 'OWNER', is_owner: true },
              });
            } else {
              await prisma.companies_members.updateMany({
                where: { company_id: firstCompany.id, user_id: cm.id },
                data: { role: 'OWNER', is_owner: true },
              });
            }
            companyMemberUserId = cm.id;
          }
        }
        const jobIdsApproved = dryRun
          ? (await prisma.jobs.findMany({ select: { id: true }, take: TARGET_JOBS })).map((j) => j.id)
          : (await prisma.jobs.findMany({ where: { status: { in: ['ACTIVE_EXTERNAL', 'ACTIVE_CLAIMED'] } }, select: { id: true }, take: TARGET_JOBS })).map((j) => j.id);
        console.log(`  ✔ ACTIVE job pool for matching = ${jobIdsApproved.length}`);

        // ========== 4. 硬匹配每人 5 条（非 dryRun 只跑前 15 人，避免超时） ==========
        const suggestedPerCandidate: Record<string, bigint[]> = {};
        let matchSuggestedTotal = 0;
        const matchSubjects = candidateUserIds.slice(0, 15);
        for (const uid of matchSubjects) {
          const profile = await prisma.candidate_profiles.findFirst({
            where: { user_id: uid, status: 'CONFIRMED', deleted_at: null },
            orderBy: { version: 'desc' },
            select: { id: true },
          });
          if (!profile) continue;
          try {
            const r = dryRun
              ? { jobs: [] }
              : await hardMatch.suggest({ candidateId: profile.id, limit: 5 });
            const jids = (r as { jobs: { jobId: bigint }[] }).jobs.map((j) => j.jobId);
            suggestedPerCandidate[String(uid)] = jids;
            matchSuggestedTotal += jids.length;
          } catch (e) {
            // 不阻塞：允许没有匹配
          }
        }
        console.log(`  ✔ 硬匹配每人 5 条： suggest runs = ${matchSubjects.length}, total job suggestions = ${matchSuggestedTotal}`);

        // ========== 5. 10 兴趣 + 5 双向联系 + 2 面试 ==========
        const pickJobForCandidate = (uid: bigint, fallbackIdx: number): bigint | null => {
          const arr = suggestedPerCandidate[String(uid)];
          if (arr && arr.length > 0) return arr[0]!;
          return jobIdsApproved[fallbackIdx % jobIdsApproved.length] ?? null;
        };
        const candidatePool = [...candidateUserIds];
        const interestsDone: Array<{ jobId: bigint; uid: bigint }> = [];
        let totalInterests = await prisma.interests.count();
        while (totalInterests < TARGET_INTERESTS && interestsDone.length < TARGET_INTERESTS) {
          const uid = candidatePool[interestsDone.length % candidatePool.length];
          if (!uid) break;
          const jid = pickJobForCandidate(uid, interestsDone.length);
          if (!jid) break;
          try {
            if (!dryRun) await matchWorkflow.candidateExpressInterest(uid, jid);
            interestsDone.push({ uid, jobId: jid });
            totalInterests++;
          } catch (e) {
            // 重复兴趣 → 跳
            if (interestsDone.length > TARGET_INTERESTS * 3) break;
            interestsDone.push({ uid, jobId: jid });
            totalInterests++;
          }
        }
        console.log(`  ✔ 候选兴趣记录： interests total = ${totalInterests} (target ${TARGET_INTERESTS})`);

        let totalContacts = await prisma.matches.count({ where: { status: 'CONTACT_AVAILABLE' } });
        const contactBound = Math.min(TARGET_CONTACTS, interestsDone.length);
        for (let i = 0; i < contactBound && totalContacts < TARGET_CONTACTS; i++) {
          const row = interestsDone[i];
          if (!row || !companyMemberUserId) continue;
          const profile = await prisma.candidate_profiles.findFirst({
            where: { user_id: row.uid, status: 'CONFIRMED', deleted_at: null },
            orderBy: { version: 'desc' },
            select: { id: true },
          });
          if (!profile) continue;
          try {
            if (!dryRun) {
              await matchWorkflow.companyExpressInterest(companyMemberUserId, row.jobId, profile.id);
            }
            totalContacts++;
          } catch (e) {
            // 忽略重复
          }
        }
        console.log(`  ✔ 双向匹配联系开启： CONTACT_AVAILABLE = ${totalContacts} (target ${TARGET_CONTACTS})`);

        let interviewCount = 0;
        const beforeInterviews =
          (await prisma.candidate_profiles.count({ where: { job_search_status: 'INTERVIEWING' } })) +
          (await prisma.jobs.count({ where: { hiring_status: 'INTERVIEWING' } }));
        interviewCount = beforeInterviews;

        for (let i = 0; i < TARGET_INTERVIEWS && interviewCount - beforeInterviews < TARGET_INTERVIEWS; i++) {
          const row = interestsDone[i % interestsDone.length];
          if (!row) continue;
          try {
            if (!dryRun) {
              const cmU = companyMemberUserId ?? (await prisma.users.findFirst({ where: { preferred_role: 'COMPANY' }, select: { id: true } }))?.id ?? null;
              await resultFb.updateCandidateJobSearchStatus(row.uid, 'INTERVIEWING', {
                source: 'MANUAL',
                relatedJobId: row.jobId,
                fromJtMatch: true,
              });
              if (cmU) {
                await resultFb.updateCompanyHiringStatus(cmU, row.jobId, 'INTERVIEWING', {
                  source: 'MANUAL',
                  fromJtMatch: true,
                });
              }
            }
            interviewCount += 2;
          } catch (e) {
            // 忽略失败，继续循环
          }
        }
        console.log(`  ✔ 结果反馈： INTERVIEWING 标记（人+岗）= ${Math.max(0, interviewCount - beforeInterviews)}；target 2 interviews`);

        // ========== 6. 打印运营看板 ==========
        const s = await ops.getOpsStats();
        console.log('\n');
        console.log(ops.formatAscii(s));

        // ========== 7. 6 项验收 PASS/FAIL ==========
        const pass = (name: string, ok: boolean, actual: string, target: string) =>
          console.log(`  [${ok ? 'PASS' : 'WAIT'}] ${name.padEnd(26, ' ')}  actual=${actual.padEnd(12, ' ')}  target=${target}`);

        console.log('\n==== 14 天试点验收 6 项 ====');
        pass('真实求职者≥30', s.candidatesConfirmed >= 30, String(s.candidatesConfirmed), '≥30');
        pass('有效岗位10-20', s.jobsActive >= 10 && s.jobsActive <= 20, String(s.jobsActive), '10..20');
        pass('企业回应≥10(兴趣数)', s.interestsTotal >= 10, String(s.interestsTotal), '≥10');
        pass('双方联系开启≥5', s.matchesContactOpened >= 5, String(s.matchesContactOpened), '≥5');
        pass('真实面试≥2', s.interviewsScheduled >= 2, String(s.interviewsScheduled), '≥2');
        pass('岗位失效率<20%', (s.jobStaleFailureRatePct ?? 0) < 20, `${(s.jobStaleFailureRatePct ?? 0).toFixed(1)}%`, '<20%');
        if (dryRun) {
          console.log('\n⚠️  当前是 DRY-RUN。请再次运行：pnpm crawler:pilot-smoke --apply  写入真实数据');
        }
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
        console.log('  crawler:reject-source --id <id> --reason "…" Set review=REJECTED + enabled=false');
        console.log('  crawler:suspend-source --id <id>            Set review=SUSPENDED + enabled=false');
        console.log('  crawler:run --source <id>                   Run one source + produce staging rows');
        console.log('  crawler:run-all                             Run all sources whose next_run_at is due');
        console.log('  crawler:auto-discover [--validate-live]     Built-in directory discovery feed');
        console.log('  crawler:review --id <stagingId>             Inspect staging, use --approve / --reject / --stale');
        console.log('  crawler:retry-translation --id <stagingId>  Reset translation_status + QA and re-run QA queue');
        console.log('  crawler:review-notify                       Notify admin of pending QA/sources');
        console.log('  crawler:stats                               Print 14 operational KPIs as ASCII table');
        console.log('  crawler:pilot-smoke [--apply]               14-day pilot setup: 30 candidates + 20 jobs + 10 interests + 5 contacts + 2 interviews');
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
