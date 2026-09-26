-- =========================================================================
-- 0009 Remote Jobs Extension (ALL operations are IDEMPOTENT).
-- Rollback strategy: no irreversible changes.
-- =========================================================================

-- 1. Extend SourceParserType enum
DO $$ BEGIN
    ALTER TYPE "SourceParserType" ADD VALUE IF NOT EXISTS 'API';
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;

DO $$ BEGIN
    ALTER TYPE "SourceParserType" ADD VALUE IF NOT EXISTS 'RSS';
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;

-- 2. Extend AuditAction enum with 6 new remote / application actions
DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REMOTE_SOURCE_SYNCED';
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REMOTE_JOB_NORMALIZED';
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REMOTE_ELIGIBILITY_CHECKED';
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REMOTE_DAILY_DIGEST_SENT';
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'JOB_APPLICATION_STATUS_CHANGED';
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_REMINDER_SENT';
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;

-- 3. Create 6 NEW enums for remote jobs / applications
DO $$ BEGIN CREATE TYPE "WorkMode" AS ENUM ('REMOTE','ONSITE','HYBRID'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RemoteScope" AS ENUM ('WORLDWIDE','ASIA','ASEAN','CAMBODIA_ONLY','COUNTRY_LIMITED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WorkAuthorization" AS ENUM ('REQUIRED','NOT_REQUIRED','UNKNOWN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME','PART_TIME','CONTRACT','FREELANCE','INTERNSHIP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "EligibilityStatus" AS ENUM ('CONFIRMED','NEEDS_CONFIRMATION','NOT_ELIGIBLE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ApplicationStatus" AS ENUM ('SAVED','APPLYING','APPLIED','SCREENING','INTERVIEW','OFFER','REJECTED','EXPIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =========================================================================
-- 4. candidate_profiles: 9 remote preference columns
-- =========================================================================
ALTER TABLE IF EXISTS "candidate_profiles"
    ADD COLUMN IF NOT EXISTS "remote_preferred"            BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS "remote_scope_preference"     "RemoteScope",
    ADD COLUMN IF NOT EXISTS "timezone"                    VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "timezone_overlap_hours"      INTEGER,
    ADD COLUMN IF NOT EXISTS "eligible_work_countries"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "work_authorization_status"   "WorkAuthorization" NOT NULL DEFAULT 'UNKNOWN',
    ADD COLUMN IF NOT EXISTS "preferred_employment_types"  "EmploymentType"[] NOT NULL DEFAULT ARRAY[]::"EmploymentType"[],
    ADD COLUMN IF NOT EXISTS "payment_methods"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "remote_salary_expectation"   VARCHAR(256);

-- =========================================================================
-- 5. jobs: 13 remote columns + index helpers
-- =========================================================================
ALTER TABLE IF EXISTS "jobs"
    ADD COLUMN IF NOT EXISTS "work_mode"              "WorkMode" NOT NULL DEFAULT 'ONSITE',
    ADD COLUMN IF NOT EXISTS "remote_scope"           "RemoteScope",
    ADD COLUMN IF NOT EXISTS "eligible_countries"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "employer_country"       VARCHAR(128),
    ADD COLUMN IF NOT EXISTS "timezone_required"      VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "timezone_overlap_hours" INTEGER,
    ADD COLUMN IF NOT EXISTS "work_authorization"     "WorkAuthorization" NOT NULL DEFAULT 'UNKNOWN',
    ADD COLUMN IF NOT EXISTS "employment_type"        "EmploymentType",
    ADD COLUMN IF NOT EXISTS "payment_method"         VARCHAR(128),
    ADD COLUMN IF NOT EXISTS "salary_currency"        VARCHAR(16),
    ADD COLUMN IF NOT EXISTS "application_url"        VARCHAR(2048),
    ADD COLUMN IF NOT EXISTS "source_platform"        VARCHAR(128),
    ADD COLUMN IF NOT EXISTS "source_last_seen_at"    TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "eligibility_status"     "EligibilityStatus" NOT NULL DEFAULT 'NEEDS_CONFIRMATION';

CREATE INDEX IF NOT EXISTS "jobs_eligibility_status_idx" ON "jobs" ("eligibility_status");
CREATE INDEX IF NOT EXISTS "jobs_work_mode_idx" ON "jobs" ("work_mode");

-- =========================================================================
-- 6. crawl_jobs_staging: SAME 13 remote columns
-- =========================================================================
ALTER TABLE IF EXISTS "crawl_jobs_staging"
    ADD COLUMN IF NOT EXISTS "work_mode"              "WorkMode" NOT NULL DEFAULT 'ONSITE',
    ADD COLUMN IF NOT EXISTS "remote_scope"           "RemoteScope",
    ADD COLUMN IF NOT EXISTS "eligible_countries"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "employer_country"       VARCHAR(128),
    ADD COLUMN IF NOT EXISTS "timezone_required"      VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "timezone_overlap_hours" INTEGER,
    ADD COLUMN IF NOT EXISTS "work_authorization"     "WorkAuthorization" NOT NULL DEFAULT 'UNKNOWN',
    ADD COLUMN IF NOT EXISTS "employment_type"        "EmploymentType",
    ADD COLUMN IF NOT EXISTS "payment_method"         VARCHAR(128),
    ADD COLUMN IF NOT EXISTS "salary_currency"        VARCHAR(16),
    ADD COLUMN IF NOT EXISTS "application_url"        VARCHAR(2048),
    ADD COLUMN IF NOT EXISTS "source_platform"        VARCHAR(128),
    ADD COLUMN IF NOT EXISTS "source_last_seen_at"    TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "eligibility_status"     "EligibilityStatus" NOT NULL DEFAULT 'NEEDS_CONFIRMATION';

CREATE INDEX IF NOT EXISTS "crawl_jobs_staging_eligibility_status_idx" ON "crawl_jobs_staging" ("eligibility_status");
CREATE INDEX IF NOT EXISTS "crawl_jobs_staging_application_url_idx" ON "crawl_jobs_staging" ("application_url");

-- =========================================================================
-- 7. job_applications: brand new table with 9+ columns + 2 FKs + idxs
-- =========================================================================
CREATE TABLE IF NOT EXISTS "job_applications" (
    "id"                 BIGSERIAL PRIMARY KEY NOT NULL,
    "idempotency_key"    VARCHAR(512) NOT NULL,
    "candidate_id"       BIGINT NOT NULL,
    "job_id"             BIGINT NOT NULL,
    "application_url"    VARCHAR(2048),
    "applied_at"         TIMESTAMP(3),
    "status"             "ApplicationStatus" NOT NULL DEFAULT 'SAVED',
    "next_follow_up_at"  TIMESTAMP(3),
    "last_action_at"     TIMESTAMP(3),
    "notes"              VARCHAR(4000),
    "version"            INTEGER NOT NULL DEFAULT 1,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_cand_job_uq" UNIQUE ("candidate_id","job_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "job_applications_idempotency_key_key" ON "job_applications" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "job_applications_candidate_id_status_idx" ON "job_applications" ("candidate_id","status");
CREATE INDEX IF NOT EXISTS "job_applications_job_id_status_idx" ON "job_applications" ("job_id","status");
CREATE INDEX IF NOT EXISTS "job_applications_status_next_follow_up_idx" ON "job_applications" ("status","next_follow_up_at");

DO $$ BEGIN
    ALTER TABLE IF EXISTS "job_applications"
        ADD CONSTRAINT "job_applications_candidate_id_fkey"
        FOREIGN KEY ("candidate_id") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE IF EXISTS "job_applications"
        ADD CONSTRAINT "job_applications_job_id_fkey"
        FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;
