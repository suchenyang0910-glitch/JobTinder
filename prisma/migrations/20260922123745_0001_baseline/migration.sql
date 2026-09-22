-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DELETED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CANDIDATE', 'COMPANY', 'BOTH');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('zh_CN', 'en', 'km');

-- CreateEnum
CREATE TYPE "ProfileStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PAUSED', 'DELETED');

-- CreateEnum
CREATE TYPE "SalaryStatus" AS ENUM ('PROVIDED', 'NOT_PROVIDED', 'NEGOTIABLE');

-- CreateEnum
CREATE TYPE "JobSourceType" AS ENUM ('EXTERNAL', 'CLAIMED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'ACTIVE_EXTERNAL', 'ACTIVE_CLAIMED', 'NEEDS_REVIEW', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "InterestActorSide" AS ENUM ('CANDIDATE', 'COMPANY');

-- CreateEnum
CREATE TYPE "InterestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'INVALIDATED', 'EXPIRED', 'MATCHED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('MATCHED', 'CONTACT_AVAILABLE', 'ENDED', 'BLOCKED', 'NEEDS_RECONFIRMATION');

-- CreateEnum
CREATE TYPE "ContactMethodType" AS ENUM ('TELEGRAM', 'PHONE', 'EMAIL', 'WHATSAPP', 'OTHER');

-- CreateEnum
CREATE TYPE "VerifiedStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('INTEREST_RECEIVED', 'INTEREST_REMINDER_24H', 'INTEREST_PAUSE_72H', 'MATCH_CREATED', 'PROFILE_CONFIRMED', 'JOB_PUBLISHED', 'CONTACT_OPENED', 'GENERAL');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('USER_CREATED', 'USER_LANGUAGE_CHANGED', 'PROFILE_DRAFT_CREATED', 'PROFILE_DRAFT_UPDATED', 'PROFILE_CONFIRMED', 'PROFILE_PAUSED', 'PROFILE_RESUMED', 'PROFILE_DELETED', 'COMPANY_VERIFIED', 'JOB_DRAFT_CREATED', 'JOB_CONFIRMED', 'JOB_CLAIMED', 'JOB_CLOSED', 'INTEREST_RECORDED', 'INTEREST_ACCEPTED', 'INTEREST_DECLINED', 'INTEREST_WITHDRAWN', 'INTEREST_EXPIRED_PAUSED', 'MATCH_CREATED', 'MATCH_ENDED', 'MATCH_BLOCKED', 'CONTACT_OPENED', 'NOTIFY_QUEUED', 'NOTIFY_SUCCEEDED', 'NOTIFY_FAILED_DEAD', 'CRAWL_RUN_STARTED', 'CRAWL_RUN_FINISHED', 'TRUST_REPORT_SUBMITTED', 'TRUST_BLOCK_EFFECTIVE');

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "telegram_username" VARCHAR(128),
    "telegram_first_name" VARCHAR(256),
    "telegram_last_name" VARCHAR(256),
    "language" "Language" NOT NULL DEFAULT 'en',
    "preferred_role" "UserRole",
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_profiles" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "target_roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "task_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages_known" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "salary_status" "SalaryStatus" NOT NULL DEFAULT 'NOT_PROVIDED',
    "salary_text" VARCHAR(256),
    "availability_note" VARCHAR(512),
    "field_sources" JSONB NOT NULL DEFAULT '{}',
    "draft_source" VARCHAR(64),
    "ai_provider_id" VARCHAR(64),
    "confirmed_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(256) NOT NULL,
    "website" VARCHAR(512),
    "description" VARCHAR(2000),
    "verification_status" "VerifiedStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies_members" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "role" VARCHAR(64) NOT NULL,
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companies_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" BIGSERIAL NOT NULL,
    "company_id" BIGINT,
    "source_type" "JobSourceType" NOT NULL DEFAULT 'EXTERNAL',
    "source_url" VARCHAR(2048),
    "source_job_id" VARCHAR(256),
    "idempotency_key" VARCHAR(512),
    "title" VARCHAR(512) NOT NULL,
    "industry" VARCHAR(128),
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tasks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages_required" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "shifts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "salary_status" "SalaryStatus" NOT NULL DEFAULT 'NOT_PROVIDED',
    "salary_text" VARCHAR(256),
    "original_published_at" TIMESTAMP(3),
    "original_deadline_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interests" (
    "id" BIGSERIAL NOT NULL,
    "idempotency_key" VARCHAR(512) NOT NULL,
    "candidate_id" BIGINT NOT NULL,
    "job_id" BIGINT NOT NULL,
    "actor_side" "InterestActorSide" NOT NULL,
    "candidate_version" INTEGER NOT NULL,
    "job_version" INTEGER NOT NULL,
    "status" "InterestStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "notified_at" TIMESTAMP(3),
    "reminded_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" BIGSERIAL NOT NULL,
    "idempotency_key" VARCHAR(512) NOT NULL,
    "candidate_id" BIGINT NOT NULL,
    "job_id" BIGINT NOT NULL,
    "candidate_interest_id" BIGINT NOT NULL,
    "company_interest_id" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "MatchStatus" NOT NULL DEFAULT 'CONTACT_AVAILABLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contact_opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_methods" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "type" "ContactMethodType" NOT NULL,
    "value_ref" VARCHAR(1024) NOT NULL,
    "label" VARCHAR(128),
    "share_enabled" BOOLEAN NOT NULL DEFAULT false,
    "verified_status" "VerifiedStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" BIGSERIAL NOT NULL,
    "dedupe_key" VARCHAR(512) NOT NULL,
    "recipient_id" BIGINT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "last_error_code" VARCHAR(128),
    "last_error_desc" VARCHAR(1024),
    "external_ref" VARCHAR(512),
    "note_succeeded" VARCHAR(1024),
    "available_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" BIGINT,
    "action" "AuditAction" NOT NULL,
    "object_type" VARCHAR(64) NOT NULL,
    "object_id" BIGINT,
    "version" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "session_key" VARCHAR(512) NOT NULL,
    "session_data" JSONB NOT NULL DEFAULT '{}',
    "user_id" BIGINT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("session_key")
);

-- CreateTable
CREATE TABLE "crawl_runs" (
    "id" BIGSERIAL NOT NULL,
    "source_id" VARCHAR(256) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" "OutboxStatus" NOT NULL DEFAULT 'PROCESSING',
    "new_count" INTEGER NOT NULL DEFAULT 0,
    "changed_count" INTEGER NOT NULL DEFAULT 0,
    "closed_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(2048),

    CONSTRAINT "crawl_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users"("telegram_user_id");

-- CreateIndex
CREATE INDEX "candidate_profiles_user_id_status_idx" ON "candidate_profiles"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_profiles_user_id_version_key" ON "candidate_profiles"("user_id", "version");

-- CreateIndex
CREATE INDEX "companies_members_user_id_idx" ON "companies_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "companies_members_company_id_user_id_key" ON "companies_members"("company_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_idempotency_key_key" ON "jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_company_id_status_idx" ON "jobs"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_source_job_id_source_type_key" ON "jobs"("source_job_id", "source_type");

-- CreateIndex
CREATE UNIQUE INDEX "interests_idempotency_key_key" ON "interests"("idempotency_key");

-- CreateIndex
CREATE INDEX "interests_job_id_status_idx" ON "interests"("job_id", "status");

-- CreateIndex
CREATE INDEX "interests_candidate_id_status_idx" ON "interests"("candidate_id", "status");

-- CreateIndex
CREATE INDEX "interests_status_notified_at_idx" ON "interests"("status", "notified_at");

-- CreateIndex
CREATE UNIQUE INDEX "interests_candidate_id_job_id_actor_side_version_key" ON "interests"("candidate_id", "job_id", "actor_side", "version");

-- CreateIndex
CREATE UNIQUE INDEX "matches_idempotency_key_key" ON "matches"("idempotency_key");

-- CreateIndex
CREATE INDEX "matches_status_idx" ON "matches"("status");

-- CreateIndex
CREATE UNIQUE INDEX "matches_candidate_id_job_id_key" ON "matches"("candidate_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_methods_user_id_type_key" ON "contact_methods"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_status_available_after_idx" ON "notifications"("status", "available_after");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_created_at_idx" ON "notifications"("recipient_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_created_at_idx" ON "audit_events"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_object_type_object_id_created_at_idx" ON "audit_events"("object_type", "object_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_action_created_at_idx" ON "audit_events"("action", "created_at");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "crawl_runs_source_id_started_at_idx" ON "crawl_runs"("source_id", "started_at");

-- AddForeignKey
ALTER TABLE "candidate_profiles" ADD CONSTRAINT "candidate_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies_members" ADD CONSTRAINT "companies_members_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies_members" ADD CONSTRAINT "companies_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interests" ADD CONSTRAINT "interests_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interests" ADD CONSTRAINT "interests_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_methods" ADD CONSTRAINT "contact_methods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
