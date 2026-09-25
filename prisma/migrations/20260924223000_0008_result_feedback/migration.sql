-- JobTinder 0008: Result Feedback Statuses
-- ALL IF NOT EXISTS / DO $$ blocks for idempotency.
-- Covers: 3 new enums + 6 columns.

DO $$ BEGIN
  CREATE TYPE "CandidateJobSearchStatus" AS ENUM (
    'LOOKING_JOB', 'INTERVIEWING', 'FOUND_JOB', 'NOT_LOOKING'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CompanyHiringStatus" AS ENUM (
    'OPEN', 'INTERVIEWING', 'FILLED', 'CLOSED', 'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StatusSource" AS ENUM (
    'MANUAL', 'INFERRED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- candidate_profiles: 3 columns
ALTER TABLE "candidate_profiles"
  ADD COLUMN IF NOT EXISTS "job_search_status" "CandidateJobSearchStatus" NOT NULL DEFAULT 'LOOKING_JOB';
ALTER TABLE "candidate_profiles"
  ADD COLUMN IF NOT EXISTS "job_search_status_updated_at" TIMESTAMP(3);
ALTER TABLE "candidate_profiles"
  ADD COLUMN IF NOT EXISTS "job_search_status_source" "StatusSource" NOT NULL DEFAULT 'MANUAL';

-- jobs: 3 columns
ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "hiring_status" "CompanyHiringStatus" NOT NULL DEFAULT 'OPEN';
ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "hiring_status_updated_at" TIMESTAMP(3);
ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "hiring_status_source" "StatusSource" NOT NULL DEFAULT 'MANUAL';

-- Indexes for reporting queries
CREATE INDEX IF NOT EXISTS "candidate_profiles_job_search_status_idx"
  ON "candidate_profiles" ("job_search_status");
CREATE INDEX IF NOT EXISTS "jobs_hiring_status_idx"
  ON "jobs" ("hiring_status");
