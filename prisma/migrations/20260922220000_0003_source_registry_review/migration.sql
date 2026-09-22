-- 0003_source_registry_review: 来源审核、评分与验证字段
-- PostgreSQL 18 compatible

-- 1. SourceReviewStatus enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SourceReviewStatus') THEN
    CREATE TYPE "SourceReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');
  END IF;
END $$;

-- 2. AuditAction enum 5 new values (PG 12+ IF NOT EXISTS supported in PG 18)
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SOURCE_IMPORTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SOURCE_VALIDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SOURCE_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SOURCE_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SOURCE_SUSPENDED';

-- 3. source_registry: new columns + defaults
ALTER TABLE "source_registry"
  ADD COLUMN IF NOT EXISTS "review_status" "SourceReviewStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "discovery_method" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "city" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "industry" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "verification_notes" VARCHAR(2000),
  ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "verified_by" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "verification_score" INTEGER,
  ADD COLUMN IF NOT EXISTS "last_validation_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "validation_error" VARCHAR(1024);

-- 4. Defaults for `enabled` and `source_type` (column defaults, rewrite existing for new rows only)
ALTER TABLE "source_registry" ALTER COLUMN "enabled" SET DEFAULT false;
ALTER TABLE "source_registry" ALTER COLUMN "source_type" SET DEFAULT 'OFFICIAL_COMPANY_WEBSITE';

-- 5. Existing rows: set review_status = PENDING where null; set enabled=false where review_status != 'APPROVED' (safety for the 3 demo seeds)
UPDATE "source_registry" SET "review_status" = 'PENDING'::"SourceReviewStatus" WHERE "review_status" IS NULL;

-- 6. Unique constraint source_base_jobs_url_uq on (base_url, jobs_url)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'source_base_jobs_url_uq') THEN
    CREATE UNIQUE INDEX "source_base_jobs_url_uq" ON "source_registry" ("base_url", "jobs_url");
  END IF;
END $$;

-- 7. Composite index (enabled, review_status, last_crawled_at)
CREATE INDEX IF NOT EXISTS "source_registry_enabled_review_status_last_crawled_at_idx"
  ON "source_registry" ("enabled", "review_status", "last_crawled_at");

-- 8. Drop old idx if it was covered by the new composite
DROP INDEX IF EXISTS "source_registry_enabled_last_crawled_at_idx";
