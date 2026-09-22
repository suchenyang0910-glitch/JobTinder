import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

const SALTED = (plain: string): string =>
  'demo-' + randomBytes(4).toString('hex') + '-' + plain.slice(0, 6);

async function main() {
  const recruiterTelegram = BigInt('111111111111');
  const candidate1Telegram = BigInt('222222222222');
  const candidate2Telegram = BigInt('333333333333');

  const recruiter = await prisma.users.upsert({
    where: { telegram_user_id: recruiterTelegram },
    update: {},
    create: {
      telegram_user_id: recruiterTelegram,
      telegram_username: SALTED('demo-recruiter'),
      telegram_first_name: 'Demo',
      telegram_last_name: 'Recruiter',
      language: 'en',
      preferred_role: 'COMPANY',
      status: 'ACTIVE',
    },
  });
  console.log(`[seed] recruiter user id=${String(recruiter.id)}`);

  const cand1 = await prisma.users.upsert({
    where: { telegram_user_id: candidate1Telegram },
    update: {},
    create: {
      telegram_user_id: candidate1Telegram,
      telegram_username: SALTED('demo-cand-1'),
      telegram_first_name: 'Lina',
      telegram_last_name: null,
      language: 'en',
      preferred_role: 'CANDIDATE',
      status: 'ACTIVE',
    },
  });
  console.log(`[seed] cand1 id=${String(cand1.id)}`);

  const cand2 = await prisma.users.upsert({
    where: { telegram_user_id: candidate2Telegram },
    update: {},
    create: {
      telegram_user_id: candidate2Telegram,
      telegram_username: SALTED('demo-cand-2'),
      telegram_first_name: 'Dara',
      telegram_last_name: null,
      language: 'en',
      preferred_role: 'CANDIDATE',
      status: 'ACTIVE',
    },
  });
  console.log(`[seed] cand2 id=${String(cand2.id)}`);

  // ---- Demo company (Cafe Happy Cup). Always owned by recruiter. ----
  let company = await prisma.companies.findFirst({ where: { name: 'Cafe Happy Cup (demo)' } });
  if (!company) {
    company = await prisma.companies.create({
      data: {
        name: 'Cafe Happy Cup (demo)',
        website: 'https://demo-jobtinder.example.invalid/cafe',
        description: 'Friendly cafe in central Phnom Penh. Demo data only — not a real employer.',
        verification_status: 'VERIFIED',
        verified_at: new Date(),
      },
    });
    await prisma.companies_members.create({
      data: {
        company_id: company.id,
        user_id: recruiter.id,
        role: 'owner',
        is_owner: true,
      },
    });
  }
  console.log(`[seed] company id=${String(company.id)} (${company.name})`);

  // ---- Demo jobs (3). Uniqueness by idempotency_key. ----
  const jobsSpec: {
    title: string;
    industry: string;
    skills: string[];
    tasks: string[];
    locations: string[];
    languages: string[];
    shifts: string[];
    sourceJobId: string;
  }[] = [
    {
      title: 'Part-time Barista',
      industry: 'Food & Beverage',
      skills: ['Customer service', 'Espresso machine', 'English basic'],
      tasks: ['Make coffee & tea drinks', 'Cashier', 'Keep cafe clean'],
      locations: ['Phnom Penh, BKK1'],
      languages: ['Khmer', 'English basic'],
      shifts: ['Morning 6h/day', 'Weekends only OK'],
      sourceJobId: 'demo-barista-bkk1',
    },
    {
      title: 'Full-time Cashier',
      industry: 'Retail',
      skills: ['POS cash register', 'Math basic', 'Customer service'],
      tasks: ['Checkout', 'Close daily register', 'Restock snacks'],
      locations: ['Phnom Penh, Toul Kork'],
      languages: ['Khmer'],
      shifts: ['Day shift 9:00-18:00', '6 days/week'],
      sourceJobId: 'demo-cashier-tk',
    },
    {
      title: 'Hotel Front Desk (Night shift)',
      industry: 'Hospitality',
      skills: ['Front desk', 'English intermediate', 'Hotel software'],
      tasks: ['Guest check in / check out', 'Answer phone', 'Bookings'],
      locations: ['Siem Reap, Old Market area'],
      languages: ['Khmer', 'English'],
      shifts: ['Night shift 22:00-06:00'],
      sourceJobId: 'demo-frontdesk-sr',
    },
  ];

  for (const j of jobsSpec) {
    const idemKey = `seed:${company.id.toString()}:${j.sourceJobId}`;
    await prisma.jobs.upsert({
      where: { idempotency_key: idemKey },
      update: {},
      create: {
        company_id: company.id,
        source_type: 'CLAIMED',
        source_job_id: j.sourceJobId,
        idempotency_key: idemKey,
        title: j.title,
        industry: j.industry,
        skills: j.skills,
        tasks: j.tasks,
        locations: j.locations,
        languages_required: j.languages,
        shifts: j.shifts,
        salary_status: 'NOT_PROVIDED',
        status: 'ACTIVE_CLAIMED',
        version: 1,
      },
    });
    console.log(`[seed] job "${j.title}" at ${j.locations[0] ?? '-'} created.`);
  }

  // ---- 2 demo candidate profiles (DRAFT only — never CONFIRMED automatically). ----
  // Prisma's @@unique([user_id, version]) composite key. We use findFirst+create or raw where.
  async function upsertCandidateDraft(
    userId: bigint,
    version: number,
    createData: {
      skills: string[];
      industries: string[];
      target_roles: string[];
      task_keywords: string[];
      locations: string[];
      languages_known: string[];
      salary_status: 'PROVIDED' | 'NOT_PROVIDED' | 'NEGOTIABLE';
      salary_text?: string | null;
      draft_source: string;
    },
  ) {
    const existing = await prisma.candidate_profiles.findFirst({
      where: { user_id: userId, version },
    });
    if (existing) return existing;
    return prisma.candidate_profiles.create({
      data: {
        user_id: userId,
        version,
        status: 'DRAFT',
        ...createData,
      },
    });
  }

  const cand1Profile = await upsertCandidateDraft(cand1.id, 1, {
    skills: ['Customer service', 'English basic'],
    industries: ['Food & Beverage'],
    target_roles: ['Barista', 'Cashier'],
    task_keywords: ['Drinks prep', 'Cleaning'],
    locations: ['Phnom Penh'],
    languages_known: ['Khmer', 'English basic'],
    salary_status: 'NEGOTIABLE',
    salary_text: '$200-250 negotiable',
    draft_source: 'manual',
  });
  console.log(`[seed] cand1 draft id=${String(cand1Profile.id)}`);

  const cand2Profile = await upsertCandidateDraft(cand2.id, 1, {
    skills: ['Front desk', 'English intermediate', 'MS Office'],
    industries: ['Hospitality'],
    target_roles: ['Front Desk', 'Receptionist'],
    task_keywords: ['Guest check-in', 'Booking'],
    locations: ['Siem Reap', 'Phnom Penh'],
    languages_known: ['Khmer', 'English'],
    salary_status: 'PROVIDED',
    salary_text: '$300-350 per month',
    draft_source: 'manual',
  });
  console.log(`[seed] cand2 draft id=${String(cand2Profile.id)}`);

  // ---- Demo crawl sources (3) — stage-2: pending review (enabled=false by default).
  // Only PENDING + APPROVED + enabled=true are executed by crawler cron.
  const sourcesSpec: {
    name: string;
    baseUrl: string;
    jobsUrl: string;
    sourceType: string;
    parserType: 'STATIC_HTML' | 'MANUAL' | 'PLAYWRIGHT' | 'FIRECRAWL';
    intervalMin: number;
    discoveryMethod: string;
    city: string;
    industry: string;
    companyId?: bigint;
  }[] = [
    {
      name: 'Demo Static Khmer Jobs (STATIC_HTML)',
      baseUrl: 'https://demo-jobtinder.example.invalid',
      jobsUrl: 'https://demo-jobtinder.example.invalid/jobs',
      sourceType: 'OFFICIAL_COMPANY_WEBSITE',
      parserType: 'STATIC_HTML',
      intervalMin: 360,
      discoveryMethod: 'manual_seed',
      city: 'Phnom Penh',
      industry: 'Technology',
      companyId: company?.id,
    },
    {
      name: 'Cafe Happy Cup Careers (STATIC_HTML)',
      baseUrl: 'https://demo-jobtinder.example.invalid/cafe',
      jobsUrl: 'https://demo-jobtinder.example.invalid/cafe/careers',
      sourceType: 'OFFICIAL_COMPANY_WEBSITE',
      parserType: 'STATIC_HTML',
      intervalMin: 720,
      discoveryMethod: 'cambodia_chamber',
      city: 'Phnom Penh',
      industry: 'Food & Beverage',
      companyId: company?.id,
    },
    {
      name: 'Manual Batch Import (MANUAL)',
      baseUrl: 'https://internal.jobtinder.local/manual',
      jobsUrl: 'https://internal.jobtinder.local/manual/jobs',
      sourceType: 'THIRD_PARTY_JOB_BOARD',
      parserType: 'MANUAL',
      intervalMin: 1440,
      discoveryMethod: 'manual_import',
      city: 'Phnom Penh',
      industry: 'Recruitment Services',
    },
  ];

  for (const s of sourcesSpec) {
    const existing = await prisma.source_registry.findFirst({
      where: { base_url: s.baseUrl, jobs_url: s.jobsUrl },
    });
    if (existing) {
      console.log(`[seed] source "${s.name}" exists id=${String(existing.id)}`);
      continue;
    }
    const created = await prisma.source_registry.create({
      data: {
        name: s.name,
        company_id: s.companyId,
        base_url: s.baseUrl,
        jobs_url: s.jobsUrl,
        source_type: s.sourceType,
        parser_type: s.parserType,
        enabled: false,
        review_status: 'PENDING',
        crawl_interval_minutes: s.intervalMin,
        robots_status: 'UNCHECKED',
        discovery_method: s.discoveryMethod,
        city: s.city,
        industry: s.industry,
      },
    });
    console.log(
      `[seed] source "${s.name}" id=${String(created.id)} [${s.parserType}] review=PENDING enabled=false`,
    );
  }

  console.log('');
  console.log('[seed] Done.');
  console.log('  • All candidate profiles are DRAFT (not CONFIRMED).');
  console.log(
    `  • Recruiter TG: ${String(recruiterTelegram)}  Cand1: ${String(candidate1Telegram)}  Cand2: ${String(candidate2Telegram)}`,
  );
  console.log('  • In Telegram, sign in as cand1 → /profile → step through → confirm.');
  console.log(
    '    Then sign in as recruiter → /company → publish one of the 3 jobs → match works.',
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
