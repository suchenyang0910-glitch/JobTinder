-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "ResumeDocumentStatus" AS ENUM ('DRAFT', 'GENERATING', 'READY', 'FAILED', 'DELETED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterEnum
DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RESUME_DRAFT_CREATED';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RESUME_DRAFT_UPDATED';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RESUME_GENERATION_STARTED';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RESUME_GENERATED';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RESUME_GENERATION_FAILED';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RESUME_DOWNLOADED';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RESUME_DELETED';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "resume_documents" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "status" "ResumeDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "input_language" VARCHAR(16),
    "output_language" VARCHAR(16),
    "title" VARCHAR(512),
    "structured_json" JSONB NOT NULL DEFAULT '{}',
    "source_text_hash" VARCHAR(128),
    "raw_input" TEXT,
    "file_path" VARCHAR(1024),
    "file_sha256" VARCHAR(128),
    "file_size_bytes" INTEGER,
    "generation_version" INTEGER NOT NULL DEFAULT 1,
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "resume_documents_user_id_key" ON "resume_documents"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "resume_documents_status_idx" ON "resume_documents"("status");

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resume_documents_user_id_fkey') THEN
        ALTER TABLE "resume_documents" ADD CONSTRAINT "resume_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
