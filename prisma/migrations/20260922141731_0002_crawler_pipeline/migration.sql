/*
  Warnings:

  - Changed the type of `source_id` on the `crawl_runs` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "CrawlJobStatus" AS ENUM ('DISCOVERED', 'FETCHED', 'PARSED', 'TRANSLATED', 'QA_PENDING', 'REVIEW_REQUIRED', 'APPROVED', 'REJECTED', 'PUBLISHED', 'STALE');

-- CreateEnum
CREATE TYPE "SourceParserType" AS ENUM ('STATIC_HTML', 'PLAYWRIGHT', 'FIRECRAWL', 'MANUAL');

-- CreateEnum
CREATE TYPE "CrawlQAStatus" AS ENUM ('NOT_RUN', 'PASSED', 'FAILED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "CrawlTranslationStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'DONE', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'JOB_PUBLISHED_FROM_CRAWL';
ALTER TYPE "AuditAction" ADD VALUE 'CRAWL_SOURCE_REGISTERED';
ALTER TYPE "AuditAction" ADD VALUE 'CRAWL_JOB_DISCOVERED';
ALTER TYPE "AuditAction" ADD VALUE 'CRAWL_JOB_PARSED';
ALTER TYPE "AuditAction" ADD VALUE 'CRAWL_TRANSLATION_DONE';
ALTER TYPE "AuditAction" ADD VALUE 'CRAWL_QA_FLAGGED';
ALTER TYPE "AuditAction" ADD VALUE 'CRAWL_REVIEW_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'CRAWL_REVIEW_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'CRAWL_JOB_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'CRAWL_JOB_MARKED_STALE';

-- AlterTable
ALTER TABLE "crawl_runs" ADD COLUMN     "review_required_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "translated_count" INTEGER NOT NULL DEFAULT 0,
DROP COLUMN "source_id",
ADD COLUMN     "source_id" BIGINT NOT NULL;

-- CreateTable
CREATE TABLE "source_registry" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(256) NOT NULL,
    "company_id" BIGINT,
    "base_url" VARCHAR(2048) NOT NULL,
    "jobs_url" VARCHAR(2048) NOT NULL,
    "source_type" VARCHAR(64) NOT NULL DEFAULT 'EXTERNAL',
    "parser_type" "SourceParserType" NOT NULL DEFAULT 'STATIC_HTML',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "crawl_interval_minutes" INTEGER NOT NULL DEFAULT 360,
    "last_crawled_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "robots_status" VARCHAR(32),
    "terms_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "source_id" BIGINT NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "http_status" INTEGER,
    "content_hash" VARCHAR(128) NOT NULL,
    "raw_content" BYTEA,
    "content_type" VARCHAR(128),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parser_version" VARCHAR(64) NOT NULL DEFAULT '1.0',
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(2048),

    CONSTRAINT "crawl_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_jobs_staging" (
    "id" BIGSERIAL NOT NULL,
    "source_id" BIGINT NOT NULL,
    "snapshot_id" BIGINT,
    "source_job_id" VARCHAR(256) NOT NULL,
    "source_url" VARCHAR(2048) NOT NULL,
    "status" "CrawlJobStatus" NOT NULL DEFAULT 'DISCOVERED',
    "detected_language" VARCHAR(16),
    "title_source" VARCHAR(512),
    "tasks_source" VARCHAR(4000),
    "skills_source" VARCHAR(2000),
    "industry_source" VARCHAR(128),
    "locations_source" VARCHAR(2000),
    "salary_source" VARCHAR(256),
    "shift_source" VARCHAR(1000),
    "benefits_source" VARCHAR(2000),
    "parsed_json" JSONB NOT NULL DEFAULT '{}',
    "translation_status" "CrawlTranslationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "qa_status" "CrawlQAStatus" NOT NULL DEFAULT 'NOT_RUN',
    "review_status" "CrawlQAStatus" NOT NULL DEFAULT 'NOT_RUN',
    "reject_reason" VARCHAR(2000),
    "parse_version" VARCHAR(64) NOT NULL DEFAULT '1.0',
    "published_job_id" BIGINT,
    "qa_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crawl_jobs_staging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_translations" (
    "id" BIGSERIAL NOT NULL,
    "staging_job_id" BIGINT NOT NULL,
    "language" "Language" NOT NULL,
    "title" VARCHAR(512) NOT NULL,
    "tasks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "industry" VARCHAR(128),
    "locations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "salary_text" VARCHAR(256),
    "shifts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "benefits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "translation_provider" VARCHAR(64),
    "translation_model" VARCHAR(128),
    "translation_version" VARCHAR(64) NOT NULL DEFAULT '1.0',
    "qa_status" "CrawlQAStatus" NOT NULL DEFAULT 'NOT_RUN',
    "review_status" "CrawlQAStatus" NOT NULL DEFAULT 'NOT_RUN',
    "review_notes" VARCHAR(2000),
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_registry_enabled_last_crawled_at_idx" ON "source_registry"("enabled", "last_crawled_at");

-- CreateIndex
CREATE INDEX "crawl_snapshots_source_id_fetched_at_idx" ON "crawl_snapshots"("source_id", "fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "crawl_snapshots_source_id_content_hash_key" ON "crawl_snapshots"("source_id", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "crawl_jobs_staging_published_job_id_key" ON "crawl_jobs_staging"("published_job_id");

-- CreateIndex
CREATE INDEX "crawl_jobs_staging_source_id_status_idx" ON "crawl_jobs_staging"("source_id", "status");

-- CreateIndex
CREATE INDEX "crawl_jobs_staging_status_created_at_idx" ON "crawl_jobs_staging"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "crawl_jobs_staging_source_id_source_job_id_parse_version_key" ON "crawl_jobs_staging"("source_id", "source_job_id", "parse_version");

-- CreateIndex
CREATE INDEX "job_translations_language_idx" ON "job_translations"("language");

-- CreateIndex
CREATE UNIQUE INDEX "job_translations_staging_job_id_language_translation_versio_key" ON "job_translations"("staging_job_id", "language", "translation_version");

-- CreateIndex
CREATE INDEX "crawl_runs_source_id_started_at_idx" ON "crawl_runs"("source_id", "started_at");

-- AddForeignKey
ALTER TABLE "source_registry" ADD CONSTRAINT "source_registry_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_snapshots" ADD CONSTRAINT "crawl_snapshots_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source_registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_jobs_staging" ADD CONSTRAINT "crawl_jobs_staging_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source_registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_jobs_staging" ADD CONSTRAINT "crawl_jobs_staging_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "crawl_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_jobs_staging" ADD CONSTRAINT "crawl_jobs_staging_published_job_id_fkey" FOREIGN KEY ("published_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_translations" ADD CONSTRAINT "job_translations_staging_job_id_fkey" FOREIGN KEY ("staging_job_id") REFERENCES "crawl_jobs_staging"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source_registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
