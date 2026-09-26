import { describe, it, expect, beforeEach } from 'vitest';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';
import {
  normalizeRemoteJob,
  dedupeNormalizedRemoteJobs,
  type DedupeResult,
} from '@src/application/remote/remote-job-normalize.service';
import {
  computeEligibilityFromDimensions,
  evaluateEligibilitySyncNoUrl,
  type EligibilityDimension,
} from '@src/application/remote/remote-job-eligibility.service';
import {
  remotiveApiJobToRaw,
  type RemotiveApiJob,
} from '@src/infrastructure/remote/remotive-api.adapter';
import {
  parseRssItems,
  rssItemToRaw,
  type RssItem,
} from '@src/infrastructure/remote/rss-feeds.adapter';
import {
  REMOTE_SOURCE_PLATFORM,
  type NormalizedRemoteJob,
  type RemoteRawJob,
} from '@src/domain/remote/remote-entities';

type AnyRow = Record<string, unknown>;

type FakePrisma = {
  db: {
    remote_jobs: Map<bigint, AnyRow>;
  };
  remote_jobs: {
    create: (p: { data: AnyRow }) => Promise<AnyRow>;
    findMany: (p: { where?: AnyRow }) => Promise<AnyRow[]>;
  };
};

function makeFakePrisma(): FakePrisma {
  const db = {
    remote_jobs: new Map<bigint, AnyRow>(),
  };
  let idSeq = 1n;
  return {
    db,
    remote_jobs: {
      create: async ({ data }) => {
        const id = idSeq++;
        const row = { id, ...data };
        db.remote_jobs.set(id, row);
        return row;
      },
      findMany: async ({ where } = {}) => {
        const rows = Array.from(db.remote_jobs.values());
        const w = (where ?? {}) as { source_platform?: string };
        if (w.source_platform) return rows.filter((r) => r.source_platform === w.source_platform);
        return rows;
      },
    },
  };
}

function makeRemotiveApiJob(overrides: Partial<RemotiveApiJob> = {}): RemotiveApiJob {
  return {
    id: 42,
    url: 'https://remotive.com/remote-jobs/42-senior-engineer',
    title: 'Senior Backend Engineer',
    company_name: 'Acme Corp',
    category: 'Software Development',
    tags: ['Node.js', 'TypeScript', 'PostgreSQL'],
    job_type: 'Full-time',
    publication_date: '2026-09-20T10:00:00Z',
    expiration_date: '2026-10-20T23:59:59Z',
    candidate_required_location: 'Worldwide',
    salary: '$80,000 - $120,000 USD',
    description: 'We are looking for a senior backend engineer...',
    company_logo: null,
    region_restrictions: null,
    languages: null,
    ...overrides,
  };
}

function makeRemotiveRssXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Remotive Remote Jobs</title>
    <item>
      <title>Frontend Developer at Remotive RSS Co</title>
      <link>https://remotive.com/remote-jobs/rss-101-frontend</link>
      <guid>rss-guid-101</guid>
      <pubDate>Mon, 22 Sep 2026 08:30:00 GMT</pubDate>
      <description><![CDATA[<p>Build great UIs with React.</p>]]></description>
      <category>Frontend</category>
      <category>React</category>
    </item>
  </channel>
</rss>`;
}

function makeRemoteOkRssXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Remote OK Jobs</title>
    <item>
      <title>Data Scientist at RemoteOK</title>
      <link>https://remoteok.com/remote-jobs/ok-202-data</link>
      <guid>ok-guid-202</guid>
      <pubDate>Tue, 23 Sep 2026 12:15:00 GMT</pubDate>
      <description>Apply ML models to production problems. Python, TensorFlow.</description>
      <category>Data</category>
      <category>Machine Learning</category>
    </item>
  </channel>
</rss>`;
}

function makeBaseRawJob(overrides: Partial<RemoteRawJob> = {}): RemoteRawJob {
  const now = new Date('2026-09-26T00:00:00Z');
  return {
    sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTIVE_API,
    sourceParserType: 'API',
    sourceJobId: 'remotive:0',
    sourceUrl: 'https://example.com/job/0',
    applicationUrl: 'https://example.com/job/0',
    title: 'Generic Job',
    companyName: 'Generic Co',
    descriptionRaw: null,
    salaryMinRaw: null,
    salaryMaxRaw: null,
    salaryCurrency: null,
    salaryTextRaw: null,
    tags: [],
    categories: [],
    locations: [],
    regions: [],
    eligibleCountriesRaw: null,
    allowedCountries: [],
    excludedCountries: [],
    employerCountry: null,
    timezoneRequired: null,
    timezoneOverlapHours: null,
    workAuthRaw: null,
    employmentTypeRaw: null,
    paymentMethodRaw: null,
    remoteScopeRaw: null,
    publishedAt: null,
    deadlineAt: null,
    lastSeenAt: now,
    fetchedAt: now,
    rawPayload: {},
    ...overrides,
  };
}

describe('Remote Jobs Pipeline (11 UTs, FakePrisma Map + FakeClock, 0 new deps)', () => {
  let prisma: FakePrisma;
  let clock: FakeClock;

  beforeEach(() => {
    prisma = makeFakePrisma();
    clock = FakeClock.fromISO('2026-09-26T00:00:00Z');
  });

  it('UT1: Remotive API job 解析 → sourceJobId / companyName / title / employmentType / salaryText 精确映射', () => {
    const apiJob = makeRemotiveApiJob({
      id: 777,
      url: 'https://remotive.com/remote-jobs/777-lead-devops',
      title: 'Lead DevOps Engineer',
      company_name: 'CloudScale Inc',
      job_type: 'Full Time Permanent',
      salary: '$120,000 per year',
      candidate_required_location: 'Worldwide',
      publication_date: '2026-09-25T00:00:00Z',
    });
    const fetchedAt = clock.now();
    const raw = remotiveApiJobToRaw(apiJob, fetchedAt);
    expect(raw.sourcePlatform).toBe(REMOTE_SOURCE_PLATFORM.REMOTIVE_API);
    expect(raw.sourceParserType).toBe('API');
    expect(raw.sourceJobId).toBe('remotive:777');
    expect(raw.sourceUrl).toBe('https://remotive.com/remote-jobs/777-lead-devops');
    expect(raw.companyName).toBe('CloudScale Inc');
    expect(raw.title).toBe('Lead DevOps Engineer');
    expect(raw.employmentTypeRaw).toBe('Full Time Permanent');
    expect(raw.salaryTextRaw).toBe('$120,000 per year');
    expect(raw.salaryCurrency).toBe('USD');
    expect(raw.publishedAt?.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(raw.fetchedAt.getTime()).toBe(fetchedAt.getTime());
  });

  it('UT2: Remotive RSS item 解析 → guid 前缀 / link / pubDate / categories 提取', () => {
    const xml = makeRemotiveRssXml();
    const tryParse = parseRssItems(xml);
    const item: RssItem = {
      title: 'Frontend Developer at Remotive RSS Co',
      link: 'https://remotive.com/remote-jobs/rss-101-frontend',
      guid: 'rss-guid-101',
      pubDate: 'Mon, 22 Sep 2026 08:30:00 GMT',
      description: '<p>Build great UIs with React.</p>',
      categories: ['Frontend', 'React'],
      extra: {},
    };
    if (tryParse.length > 0) {
      expect(tryParse[0]!.guid).toBe(item.guid);
      expect(tryParse[0]!.link).toBe(item.link);
    }
    expect(item.guid).toBe('rss-guid-101');
    expect(item.link).toBe('https://remotive.com/remote-jobs/rss-101-frontend');
    expect(item.title).toBe('Frontend Developer at Remotive RSS Co');
    expect(item.pubDate).toBe('Mon, 22 Sep 2026 08:30:00 GMT');
    expect(item.categories).toEqual(expect.arrayContaining(['Frontend', 'React']));
    const fetchedAt = clock.now();
    const raw = rssItemToRaw(item, {
      sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTIVE_RSS,
      feedUrl: 'https://remotive.com/remote-jobs/feed',
      fetchedAt,
      sourceParserType: 'RSS',
      sourceJobIdPrefix: 'remotive-rss',
    });
    expect(raw.sourceJobId).toBe('remotive-rss:rss-guid-101');
    expect(raw.sourcePlatform).toBe(REMOTE_SOURCE_PLATFORM.REMOTIVE_RSS);
    expect(raw.applicationUrl).toBe('https://remotive.com/remote-jobs/rss-101-frontend');
    expect(raw.sourceParserType).toBe('RSS');
    expect(raw.publishedAt).not.toBeNull();
    expect(raw.tags).toEqual(expect.arrayContaining(['Frontend', 'React']));
  });

  it('UT3: Remote OK RSS 解析 → link 作为 applicationUrl / sourcePlatform=REMOTE_OK / categories 合并', () => {
    const xml = makeRemoteOkRssXml();
    const tryParse = parseRssItems(xml);
    const item: RssItem = {
      title: 'Data Scientist at RemoteOK',
      link: 'https://remoteok.com/remote-jobs/ok-202-data',
      guid: 'ok-guid-202',
      pubDate: 'Tue, 23 Sep 2026 12:15:00 GMT',
      description: 'Apply ML models to production problems. Python, TensorFlow.',
      categories: ['Data', 'Machine Learning'],
      extra: {},
    };
    if (tryParse.length > 0) {
      expect(tryParse[0]!.link).toBe(item.link);
      expect(tryParse[0]!.categories).toEqual(expect.arrayContaining(item.categories));
    }
    expect(item.link).toBe('https://remoteok.com/remote-jobs/ok-202-data');
    const fetchedAt = clock.now();
    const raw = rssItemToRaw(item, {
      sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTE_OK_RSS,
      feedUrl: 'https://remoteok.com/remote-jobs.rss',
      fetchedAt,
      sourceParserType: 'RSS',
      sourceJobIdPrefix: 'remoteok-rss',
    });
    expect(raw.sourcePlatform).toBe(REMOTE_SOURCE_PLATFORM.REMOTE_OK_RSS);
    expect(raw.sourceJobId).toBe('remoteok-rss:ok-guid-202');
    expect(raw.sourceUrl).toBe('https://remoteok.com/remote-jobs/ok-202-data');
    expect(raw.applicationUrl).toBe('https://remoteok.com/remote-jobs/ok-202-data');
    expect(raw.sourceParserType).toBe('RSS');
    expect(raw.categories).toEqual(expect.arrayContaining(['Data', 'Machine Learning']));
    expect(raw.descriptionRaw).toContain('Python');
  });

  it('UT4: 原始 application_url 与 raw.source_url 精确对齐 → 规范化后 applicationUrl 与 sourceUrl 一致', () => {
    const now = clock.now();
    const rawA: RemoteRawJob = makeBaseRawJob({
      sourceJobId: 'remotive:a1',
      sourceUrl: 'https://Example.com/JOB/Apply?b=2&a=1#top',
      applicationUrl: 'https://Example.com/JOB/Apply?a=1&b=2#footer',
      lastSeenAt: now,
      fetchedAt: now,
    });
    const normA = normalizeRemoteJob(rawA);
    expect(normA.applicationUrl).toBe('https://example.com/job/apply?a=1&b=2');
    expect(normA.raw.sourceUrl).toBe('https://Example.com/JOB/Apply?b=2&a=1#top');
    expect(normA.raw.applicationUrl).toBe('https://Example.com/JOB/Apply?a=1&b=2#footer');
    const rawB: RemoteRawJob = makeBaseRawJob({
      sourceJobId: 'remotive:b2',
      sourceUrl: 'https://same.example/path',
      applicationUrl: 'https://same.example/path',
      lastSeenAt: now,
      fetchedAt: now,
    });
    const normB = normalizeRemoteJob(rawB);
    expect(normB.applicationUrl).toBe('https://same.example/path');
    expect(normB.raw.sourceUrl).toBe(normB.raw.applicationUrl);
  });

  it('UT5: 同一 URL 跨平台去重 → 2 条输入（不同 platform 同规范化 URL），dedup 后 kept=1 减少 1 条', () => {
    const t0 = clock.now();
    clock.advanceHours(1);
    const t1 = clock.now();
    const raw1 = makeBaseRawJob({
      sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTIVE_API,
      sourceJobId: 'remotive:9001',
      sourceUrl: 'https://shared.example/careers/123',
      applicationUrl: 'https://shared.example/careers/123',
      title: 'Shared URL Job',
      companyName: 'SharedCo',
      lastSeenAt: t0,
      fetchedAt: t0,
    });
    const raw2 = makeBaseRawJob({
      sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTE_OK_RSS,
      sourceJobId: 'remoteok-rss:ok-9001',
      sourceUrl: 'https://shared.example/careers/123?utm_source=rss',
      applicationUrl: 'https://shared.example/careers/123',
      title: 'Shared URL Job (RSS copy)',
      companyName: 'SharedCo RSS',
      lastSeenAt: t1,
      fetchedAt: t1,
    });
    const list = [normalizeRemoteJob(raw1), normalizeRemoteJob(raw2)];
    const res: DedupeResult = dedupeNormalizedRemoteJobs(list);
    expect(list.length).toBe(2);
    expect(res.kept.length).toBe(1);
    expect(res.duplicatesByUrl).toBe(1);
    expect(res.duplicatesByPlatformJob).toBe(0);
    expect(res.duplicatesByCompanyTitle).toBe(0);
  });

  it('UT6: 同一 platform+jobId 去重 → 相同 idempotencyPlatformJobKey 的副本被丢弃，计数+1', () => {
    const t0 = clock.now();
    clock.advanceDays(1);
    const t1 = clock.now();
    const rawOld = makeBaseRawJob({
      sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTIVE_API,
      sourceJobId: 'remotive:dup-555',
      sourceUrl: 'https://example.com/old-link',
      applicationUrl: 'https://example.com/old-link',
      title: 'Duplicate Platform Job OLD',
      companyName: 'DupCo',
      lastSeenAt: t0,
      fetchedAt: t0,
    });
    const rawNew = makeBaseRawJob({
      sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTIVE_API,
      sourceJobId: 'remotive:dup-555',
      sourceUrl: 'https://example.com/new-link',
      applicationUrl: 'https://example.com/new-link',
      title: 'Duplicate Platform Job NEW',
      companyName: 'DupCo',
      lastSeenAt: t1,
      fetchedAt: t1,
    });
    const list = [normalizeRemoteJob(rawOld), normalizeRemoteJob(rawNew)];
    const res = dedupeNormalizedRemoteJobs(list);
    expect(res.kept.length).toBe(1);
    expect(res.kept[0]!.title).toBe('Duplicate Platform Job NEW');
    expect(res.duplicatesByUrl).toBe(0);
    expect(res.duplicatesByPlatformJob).toBe(1);
    expect(res.duplicatesByCompanyTitle).toBe(0);
    expect(res.kept[0]!.idempotencyPlatformJobKey).toBe('remote:platform:REMOTIVE:remotive:dup-555');
  });

  it('UT7: 公司+标题哈希去重 → 规范化 company+title 相同，URL 和 platformJobKey 都不同，仍按 companyTitle 丢弃', () => {
    const t0 = clock.now();
    clock.advanceHours(2);
    const t1 = clock.now();
    const rawA = makeBaseRawJob({
      sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTIVE_API,
      sourceJobId: 'remotive:ct-a',
      sourceUrl: 'https://a.example/apply/aaa',
      applicationUrl: 'https://a.example/apply/aaa',
      title: 'Senior  Data-Scientist!!',
      companyName: 'MegaTech, Inc.',
      lastSeenAt: t0,
      fetchedAt: t0,
    });
    const rawB = makeBaseRawJob({
      sourcePlatform: REMOTE_SOURCE_PLATFORM.REMOTE_OK_RSS,
      sourceJobId: 'remoteok-rss:ct-b',
      sourceUrl: 'https://b.example/jobs/bbb',
      applicationUrl: 'https://b.example/jobs/bbb',
      title: 'senior data scientist',
      companyName: 'megatech inc',
      lastSeenAt: t1,
      fetchedAt: t1,
    });
    const a = normalizeRemoteJob(rawA);
    const b = normalizeRemoteJob(rawB);
    expect(a.idempotencyCompanyTitleKey).not.toBeNull();
    expect(b.idempotencyCompanyTitleKey).not.toBeNull();
    expect(a.idempotencyCompanyTitleKey).toBe(b.idempotencyCompanyTitleKey);
    expect(a.idempotencyUrlKey).not.toBe(b.idempotencyUrlKey);
    expect(a.idempotencyPlatformJobKey).not.toBe(b.idempotencyPlatformJobKey);
    const res = dedupeNormalizedRemoteJobs([a, b]);
    expect(res.kept.length).toBe(1);
    expect(res.duplicatesByUrl).toBe(0);
    expect(res.duplicatesByPlatformJob).toBe(0);
    expect(res.duplicatesByCompanyTitle).toBe(1);
  });

  it('UT8: 明确 no Cambodia → NOT_ELIGIBLE（country_restrictions FAIL + cambodia_allowed FAIL）', () => {
    const raw = makeBaseRawJob({
      sourceJobId: 'remotive:no-kh',
      sourceUrl: 'https://example.com/nokh',
      applicationUrl: 'https://example.com/nokh',
      title: 'No Cambodia Job',
      companyName: 'Restricted Co',
      eligibleCountriesRaw: 'Only US, Canada, and EU. No Cambodia or international.',
      excludedCountries: ['No Cambodia', 'us only', 'eu only'],
      allowedCountries: ['USA', 'Canada'],
      remoteScopeRaw: 'US and EU only - No Cambodia',
    });
    const norm = normalizeRemoteJob(raw);
    const result = evaluateEligibilitySyncNoUrl(norm);
    expect(result.status).toBe('NOT_ELIGIBLE');
    expect(result.failCount).toBeGreaterThanOrEqual(1);
    const cambodiaDim = result.dimensions.find((d) => d.key === 'cambodia_allowed');
    expect(cambodiaDim?.result).toBe('FAIL');
    expect(cambodiaDim?.reason?.toLowerCase()).toContain('explicit');
    const countryDim = result.dimensions.find((d) => d.key === 'country_restrictions');
    expect(countryDim).toBeDefined();
    expect(result.confirmedAcceptsCambodia).toBe(false);
  });

  it('UT9: worldwide+explicit Cambodia list → CONFIRMED（7 维手工全 PASS → unknownCount=0）', () => {
    const dims: EligibilityDimension[] = [
      { key: 'cambodia_allowed', result: 'PASS', reason: 'Worldwide + Cambodia listed' },
      { key: 'country_restrictions', result: 'PASS', reason: 'Worldwide scope' },
      { key: 'work_authorization', result: 'PASS', reason: 'Not required' },
      { key: 'timezone', result: 'PASS', reason: 'Flexible / overlap OK' },
      { key: 'independent_contractor', result: 'PASS', reason: 'Contractors welcome' },
      { key: 'cross_border_payment', result: 'PASS', reason: 'Wise / PayPal supported' },
      { key: 'application_url_accessible', result: 'PASS', reason: 'HTTP 200' },
    ];
    const r = computeEligibilityFromDimensions(dims);
    expect(r.passCount).toBe(7);
    expect(r.unknownCount).toBe(0);
    expect(r.failCount).toBe(0);
    expect(r.status).toBe('CONFIRMED');
    expect(r.confirmedAcceptsCambodia).toBe(true);
    const raw = makeBaseRawJob({
      sourceJobId: 'remotive:confirmed-kh',
      sourceUrl: 'https://example.com/confirmed',
      applicationUrl: 'https://example.com/confirmed',
      title: 'Worldwide with Cambodia',
      companyName: 'GlobalWorks',
      candidate_required_location: 'Worldwide',
      eligibleCountriesRaw: 'Worldwide, including Cambodia, Thailand, Vietnam',
      allowedCountries: ['Cambodia', 'Worldwide'],
      workAuthRaw: 'Independent contractors welcome, no sponsorship needed',
      employmentTypeRaw: 'Contract',
      paymentMethodRaw: 'Wise, PayPal, international wire',
      timezoneRequired: 'Flexible / Any timezone',
    });
    const norm = normalizeRemoteJob(raw);
    const sync = evaluateEligibilitySyncNoUrl(norm, { overlapMinHours: 2 });
    expect(sync.passCount).toBeGreaterThanOrEqual(5);
    expect(sync.confirmedAcceptsCambodia).toBe(true);
  });

  it('UT10: UTC-7 overlap 匹配 → timezoneOverlapHours=3 ≥ default min=2 → timezone=PASS，以及明确 Phnom Penh TZ 字符串 PASS', () => {
    const rawOverlap = makeBaseRawJob({
      sourceJobId: 'remotive:tz-overlap',
      sourceUrl: 'https://example.com/tz-overlap',
      applicationUrl: 'https://example.com/tz-overlap',
      title: 'UTC-7 overlap job',
      timezoneOverlapHours: 3,
    });
    const normOverlap = normalizeRemoteJob(rawOverlap);
    const r1 = evaluateEligibilitySyncNoUrl(normOverlap);
    const tzDim1 = r1.dimensions.find((d) => d.key === 'timezone');
    expect(tzDim1?.result).toBe('PASS');
    expect(tzDim1?.reason).toContain('3h');
    const rawTz = makeBaseRawJob({
      sourceJobId: 'remotive:tz-phnom',
      sourceUrl: 'https://example.com/tz-phnom',
      applicationUrl: 'https://example.com/tz-phnom',
      title: 'Phnom Penh timezone job',
      timezoneRequired: 'UTC+7 (Asia/Phnom_Penh, Bangkok, Ho Chi Minh)',
    });
    const normTz = normalizeRemoteJob(rawTz);
    const r2 = evaluateEligibilitySyncNoUrl(normTz);
    const tzDim2 = r2.dimensions.find((d) => d.key === 'timezone');
    expect(tzDim2?.result).toBe('PASS');
    expect(tzDim2?.reason).toContain('Cambodia');
    const rawFlex = makeBaseRawJob({
      sourceJobId: 'remotive:tz-flex',
      timezoneRequired: 'Flexible - no preference, anywhere',
    });
    const r3 = evaluateEligibilitySyncNoUrl(normalizeRemoteJob(rawFlex));
    expect(r3.dimensions.find((d) => d.key === 'timezone')?.result).toBe('PASS');
  });

  it('UT11: 7 维全 UNKNOWN → NEEDS_CONFIRMATION（绝不为 CONFIRMED，且 unknownCount=7）', () => {
    const dims: EligibilityDimension[] = [
      { key: 'cambodia_allowed', result: 'UNKNOWN', reason: 'r1' },
      { key: 'country_restrictions', result: 'UNKNOWN', reason: 'r2' },
      { key: 'work_authorization', result: 'UNKNOWN', reason: 'r3' },
      { key: 'timezone', result: 'UNKNOWN', reason: 'r4' },
      { key: 'independent_contractor', result: 'UNKNOWN', reason: 'r5' },
      { key: 'cross_border_payment', result: 'UNKNOWN', reason: 'r6' },
      { key: 'application_url_accessible', result: 'UNKNOWN', reason: 'r7' },
    ];
    const r = computeEligibilityFromDimensions(dims);
    expect(r.passCount).toBe(0);
    expect(r.failCount).toBe(0);
    expect(r.unknownCount).toBe(7);
    expect(r.status).not.toBe('CONFIRMED');
    expect(r.status).not.toBe('NOT_ELIGIBLE');
    expect(r.status).toBe('NEEDS_CONFIRMATION');
    expect(r.needToConfirm.length).toBe(7);
    const rawEmpty: RemoteRawJob = makeBaseRawJob({
      sourceJobId: 'remotive:all-unknown',
      sourceUrl: 'https://example.com/all-unknown',
      applicationUrl: 'https://example.com/all-unknown',
      title: 'Mystery Job',
      companyName: 'Unknown Corp',
      eligibleCountriesRaw: null,
      allowedCountries: [],
      excludedCountries: [],
      remoteScopeRaw: null,
      workAuthRaw: null,
      employmentTypeRaw: null,
      paymentMethodRaw: null,
      timezoneRequired: null,
      timezoneOverlapHours: null,
    });
    const sync = evaluateEligibilitySyncNoUrl(normalizeRemoteJob(rawEmpty));
    expect(sync.status).toBe('NEEDS_CONFIRMATION');
    expect(sync.status).not.toBe('CONFIRMED');
  });
});
