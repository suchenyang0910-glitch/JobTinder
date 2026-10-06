import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@src/infrastructure/clock/fake-clock';

vi.mock('@src/shared/env/app-env', () => ({ APP_ENV: { TELEGRAM_BOT_TOKEN: 'test-token' } }));

import { RemoteDailyDigestService } from './remote-daily-digest.service';

afterEach(() => vi.unstubAllGlobals());

describe('RemoteDailyDigestService', () => {
  it('sends local and remote jobs in the candidate language', async () => {
    const localJob = {
      jobId: 1n,
      title: 'Local cashier',
      industry: 'Retail',
      matchScore: 3,
      matchReason: null,
      needToConfirm: [],
      sourcePlatform: 'COMPANY_WEBSITE',
      applicationUrl: 'https://example.com/local',
      remoteScope: null,
      eligibilityStatus: 'CONFIRMED',
      salaryText: null,
      sourceUrl: null,
      workMode: 'ONSITE',
    };
    const remoteJob = {
      ...localJob,
      jobId: 2n,
      title: 'Remote engineer',
      industry: 'Technology',
      sourcePlatform: 'JOBICY',
      applicationUrl: 'https://example.com/remote',
      remoteScope: 'WORLDWIDE',
      eligibilityStatus: 'NEEDS_CONFIRMATION',
      needToConfirm: ['confirm work authorization'],
      workMode: 'REMOTE',
    };
    const prisma = {
      candidate_profiles: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 10n,
            user_id: 20n,
            user: { telegram_user_id: 30n, language: 'zh_CN' },
          },
        ]),
      },
      audit_events: { findFirst: vi.fn().mockResolvedValue(null) },
      jobs: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 1n,
            published_from_crawl: {
              job_translations: [{ title: '金边收银员', industry: '零售', salary_text: '面议' }],
            },
          },
          {
            id: 2n,
            published_from_crawl: {
              job_translations: [
                { title: '远程软件工程师', industry: '软件开发', salary_text: '面议' },
              ],
            },
          },
        ]),
      },
    };
    const hardMatch = {
      suggest: vi
        .fn()
        .mockImplementation((input: { workModes?: string[] }) =>
          Promise.resolve({ candidateId: 10n, jobs: input.workModes ? [localJob] : [remoteJob] }),
        ),
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const service = new RemoteDailyDigestService(
      prisma as never,
      { record: vi.fn().mockResolvedValue(undefined) } as never,
      hardMatch as never,
      FakeClock.fromISO('2026-10-06T02:00:00Z'),
    );
    const result = await service.runDailyDigest();

    expect(result.totalJobsSent).toBe(2);
    expect(hardMatch.suggest).toHaveBeenCalledWith(
      expect.objectContaining({ workModes: ['ONSITE', 'HYBRID'] }),
    );
    expect(hardMatch.suggest).toHaveBeenCalledWith(expect.objectContaining({ remoteScope: true }));
    const payload = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { text: string };
    expect(payload.text).toContain('每日岗位推荐');
    expect(payload.text).toContain('🏢 现场 金边收银员');
    expect(payload.text).toContain('🌐 远程 远程软件工程师');
    expect(payload.text).not.toContain('Local cashier');
    expect(payload.text).not.toContain('Remote engineer');
    expect(payload.text).not.toContain('Industry:');
  });
});
