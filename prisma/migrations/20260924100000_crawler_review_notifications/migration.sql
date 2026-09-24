ALTER TABLE "crawl_jobs_staging" ADD COLUMN IF NOT EXISTS "review_notified_at" TIMESTAMP(3);
