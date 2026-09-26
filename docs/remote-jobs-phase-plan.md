# Remote Jobs Phase 0–8 Execution Plan

This plan is the acceptance checklist for the explicitly unlocked remote-job source scope. Remote feeds may be synchronized automatically, but every imported job remains `QA_PENDING` (or `DEFERRED` when ineligible) until the existing admin approval flow publishes it.

## Phase 0 — Scope and data contract

- [x] Define remote work mode, scope, country eligibility, timezone, work authorization, payment, and application URL fields.
- [x] Add source/platform identity and idempotency keys.
- [x] Add job application status and follow-up fields.
- [ ] Run the migration against the deployment database and confirm no destructive changes.

## Phase 1 — Source adapters

- [x] Remotive API adapter.
- [x] Remotive RSS adapter.
- [x] Remote OK RSS adapter.
- [x] Node-safe RSS parsing without browser-only APIs.
- [x] Remote OK API fallback when its RSS endpoint returns HTTP 410.
- [x] Keep source URLs and provider attribution in every stored record.

## Phase 2 — Normalization and deduplication

- [x] Normalize title, company, description, skills, location, salary, dates, and apply URL.
- [x] Deduplicate by provider job key, canonical URL, and company/title fallback.
- [x] Preserve the raw source payload for audit and reprocessing.

## Phase 3 — Eligibility and quality gates

- [x] Evaluate Cambodia eligibility, country restrictions, work authorization, timezone, contractor acceptance, payment, and URL availability.
- [x] Mark unknown dimensions for manual confirmation.
- [x] Prevent explicitly incompatible jobs from entering the publishable queue.
- [ ] Run URL probes before approval and persist the result on the staging record.

## Phase 4 — Staging and approval

- [x] Upsert snapshots and staging jobs idempotently.
- [x] Put eligible imports into `QA_PENDING`; put rejected imports into `DEFERRED`.
- [x] Preserve the existing admin-only approval notification path to `@Faxonlei`.
- [ ] Approve a small real sample before expanding the source pool.

## Phase 5 — Matching and Telegram experience

- [x] Add remote-scope matching and explainable match reasons.
- [x] Add `/remote` and menu access.
- [x] Show source, eligibility, salary, and original application link.
- [x] Reject stale/unpublished job action callbacks.

## Phase 6 — Applications and feedback

- [x] Save, mark applied, interview, offer, and follow-up statuses.
- [x] Add idempotent application records and follow-up scheduling.
- [ ] Verify candidate and employer outcome feedback in a real Telegram flow.

## Phase 7 — Scheduling and operations

- [x] Add source sync and daily digest schedules.
- [x] Keep digest idempotent, but retry when Telegram delivery fails.
- [x] Run dry-run sync and inspect counts before enabling production schedules.

## Phase 8 — Validation and release

- [ ] Typecheck, build, unit/integration tests, Prisma validation, and `git diff --check`.
- [ ] Run live dry-run against all enabled remote sources.
- [ ] Deploy the verified commit, run migrations, and check `/health`, Prisma, Telegram polling, and scheduler logs.
- [ ] Record the release commit and rollback image tag.

## Release gates

1. No compile, migration, or test failures.
2. No remote job is published without the admin approval chain.
3. Every published job has a source URL and an eligibility state.
4. Failed Telegram delivery does not suppress the next digest retry.
5. Rollback to the previous image remains available.
