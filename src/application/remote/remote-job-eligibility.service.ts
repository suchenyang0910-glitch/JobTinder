import { Injectable } from '@nestjs/common';
import {
  type EligibilityStatus,
  type NormalizedRemoteJob,
} from '@src/domain/remote/remote-entities';
import { safeHttpFetch } from '@src/infrastructure/remote/remote-http-client';

export const ELIGIBILITY_COUNTRY_NAMES: Record<string, readonly string[]> = {
  KHM: ['cambodia', 'khmer', 'kampuchea', 'kingdom of cambodia', 'phnom penh'],
  ASIA: [
    'asia',
    'asian',
    'southeast asia',
    'se asia',
    'asean',
    'apac',
    'asia-pacific',
    'cambodia',
    'thailand',
    'vietnam',
    'laos',
    'malaysia',
    'singapore',
    'indonesia',
    'philippines',
    'myanmar',
    'china',
    'taiwan',
    'hong kong',
    'korea',
    'japan',
    'india',
  ],
  WORLDWIDE: ['worldwide', 'anywhere', 'global', 'any country', 'all countries', 'no restrictions'],
  EXCLUDED: [
    'only us',
    'usa only',
    'us only',
    'only usa',
    'us resident only',
    'only european',
    'only eu',
    'eu only',
    'europe only',
    'uk only',
    'canada only',
    'no international',
    'must be located in the us',
    'must be in eu',
    'no remote outside us',
  ],
} as const;

export interface EligibilityDimension {
  key:
    | 'cambodia_allowed'
    | 'country_restrictions'
    | 'work_authorization'
    | 'timezone'
    | 'independent_contractor'
    | 'cross_border_payment'
    | 'application_url_accessible';
  result: 'PASS' | 'UNKNOWN' | 'FAIL';
  reason: string | null;
}

export interface EligibilityCheckResult {
  status: EligibilityStatus;
  dimensions: EligibilityDimension[];
  passCount: number;
  unknownCount: number;
  failCount: number;
  needToConfirm: string[];
  confirmedAcceptsCambodia: boolean;
}

function textContainsAny(text: string | null | undefined, keys: readonly string[]): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const k of keys) {
    if (t.includes(k.toLowerCase())) return k;
  }
  return null;
}

function listContainsAny(
  list: readonly string[] | undefined,
  keys: readonly string[],
): string | null {
  if (!list) return null;
  for (const x of list) {
    for (const k of keys) {
      if (x.toLowerCase().includes(k.toLowerCase())) return k;
    }
  }
  return null;
}

function checkCambodia(job: NormalizedRemoteJob): EligibilityDimension {
  const excludedHit =
    listContainsAny(job.raw.excludedCountries, ELIGIBILITY_COUNTRY_NAMES.EXCLUDED ?? []) ||
    textContainsAny(job.raw.eligibleCountriesRaw, ELIGIBILITY_COUNTRY_NAMES.EXCLUDED ?? []) ||
    textContainsAny(job.raw.remoteScopeRaw, ELIGIBILITY_COUNTRY_NAMES.EXCLUDED ?? []);
  if (excludedHit) {
    return {
      key: 'cambodia_allowed',
      result: 'FAIL',
      reason: `Explicit country restriction matched: ${excludedHit}`,
    };
  }
  const allowedHit =
    listContainsAny(job.eligibleCountries, ELIGIBILITY_COUNTRY_NAMES.KHM ?? []) ||
    textContainsAny(job.raw.eligibleCountriesRaw, ELIGIBILITY_COUNTRY_NAMES.KHM ?? []) ||
    (job.remoteScope && ['WORLDWIDE', 'ASIA', 'ASEAN', 'CAMBODIA_ONLY'].includes(job.remoteScope));
  if (allowedHit) {
    return {
      key: 'cambodia_allowed',
      result: 'PASS',
      reason: `Allowed list / scope explicitly includes Cambodia or broader: ${String(allowedHit)}`,
    };
  }
  return {
    key: 'cambodia_allowed',
    result: 'UNKNOWN',
    reason: 'Country eligibility unknown',
  };
}

function checkCountryRestrictions(job: NormalizedRemoteJob): EligibilityDimension {
  if (job.remoteScope === 'WORLDWIDE') {
    return { key: 'country_restrictions', result: 'PASS', reason: 'Worldwide scope' };
  }
  if (job.remoteScope && job.remoteScope !== 'COUNTRY_LIMITED') {
    return {
      key: 'country_restrictions',
      result: 'PASS',
      reason: `Scope ${job.remoteScope} includes eligible geos`,
    };
  }
  if (job.remoteScope === 'COUNTRY_LIMITED' || job.eligibleCountries.length > 0) {
    const cambodiaIncluded =
      listContainsAny(job.eligibleCountries, ELIGIBILITY_COUNTRY_NAMES.KHM ?? []) != null;
    return cambodiaIncluded
      ? { key: 'country_restrictions', result: 'PASS', reason: 'Cambodia in explicit country list' }
      : {
          key: 'country_restrictions',
          result: 'UNKNOWN',
          reason: 'Country list does not reference Cambodia; requires manual confirm',
        };
  }
  return {
    key: 'country_restrictions',
    result: 'UNKNOWN',
    reason: 'No country / scope information provided',
  };
}

function checkWorkAuthorization(job: NormalizedRemoteJob): EligibilityDimension {
  if (job.workAuthorization === 'NOT_REQUIRED') {
    return { key: 'work_authorization', result: 'PASS', reason: 'Work authorization not required' };
  }
  if (job.workAuthorization === 'REQUIRED') {
    return {
      key: 'work_authorization',
      result: 'FAIL',
      reason: 'Local work authorization / visa sponsorship required',
    };
  }
  return {
    key: 'work_authorization',
    result: 'UNKNOWN',
    reason: 'Work authorization not specified',
  };
}

function checkTimezone(
  job: NormalizedRemoteJob,
  options: {
    userTimezone?: string | null;
    overlapMinHours?: number;
    candidateOverlapHours?: number | null;
  } = {},
): EligibilityDimension {
  if (job.timezoneOverlapHours != null) {
    const min = options.overlapMinHours ?? options.candidateOverlapHours ?? 2;
    return job.timezoneOverlapHours >= min
      ? {
          key: 'timezone',
          result: 'PASS',
          reason: `Declared overlap ${job.timezoneOverlapHours}h >= min ${min}h`,
        }
      : {
          key: 'timezone',
          result: 'FAIL',
          reason: `Declared overlap ${job.timezoneOverlapHours}h < min ${min}h`,
        };
  }
  if (job.timezoneRequired) {
    const tz = job.timezoneRequired.toLowerCase();
    const cambodiaTz = options.userTimezone?.toLowerCase() ?? 'asia/phnom_penh';
    if (
      tz.includes(cambodiaTz) ||
      /(utc\+7|gmt\+7|cambodia|phnom|bangkok|ho chi minh|vientiane|jakarta)/.test(tz)
    ) {
      return {
        key: 'timezone',
        result: 'PASS',
        reason: `Timezone compatible with Cambodia (${job.timezoneRequired})`,
      };
    }
    if (/(flexible|any|anywhere|no preference)/.test(tz)) {
      return { key: 'timezone', result: 'PASS', reason: 'Flexible timezone requirement' };
    }
    return {
      key: 'timezone',
      result: 'UNKNOWN',
      reason: `Timezone ${job.timezoneRequired}; overlap unknown`,
    };
  }
  return { key: 'timezone', result: 'UNKNOWN', reason: 'Timezone not specified' };
}

function checkIndependentContractor(job: NormalizedRemoteJob): EligibilityDimension {
  const raw =
    `${job.raw.workAuthRaw ?? ''} ${job.raw.employmentTypeRaw ?? ''} ${job.raw.paymentMethodRaw ?? ''} ${job.raw.descriptionRaw ?? ''}`.toLowerCase();
  if (
    /(independent contractor welcome|contractors welcome|b2b invoice|contractor accepted|1099|work as a contractor)/.test(
      raw,
    )
  ) {
    return {
      key: 'independent_contractor',
      result: 'PASS',
      reason: 'Explicitly accepts independent contractors',
    };
  }
  if (job.employmentType === 'CONTRACT' || job.employmentType === 'FREELANCE') {
    return {
      key: 'independent_contractor',
      result: 'PASS',
      reason: `Employment type is ${job.employmentType}`,
    };
  }
  if (/(only w-2|only employee|no contractors|employees only)/.test(raw)) {
    return {
      key: 'independent_contractor',
      result: 'FAIL',
      reason: 'Only direct employees (W-2) accepted',
    };
  }
  return {
    key: 'independent_contractor',
    result: 'UNKNOWN',
    reason: 'Contractor acceptance not stated',
  };
}

function checkPaymentMethod(job: NormalizedRemoteJob): EligibilityDimension {
  const raw =
    `${job.raw.paymentMethodRaw ?? ''} ${job.raw.descriptionRaw ?? ''} ${job.paymentMethod ?? ''}`.toLowerCase();
  if (
    /(wise|transferwise|paypal|payoneer|international wire|swift|revolut|crypto|global pay)/.test(
      raw,
    )
  ) {
    return {
      key: 'cross_border_payment',
      result: 'PASS',
      reason: 'Cross-border friendly payment methods mentioned',
    };
  }
  if (/(only local bank|only us bank|local transfer only|ach only)/.test(raw)) {
    return {
      key: 'cross_border_payment',
      result: 'FAIL',
      reason: 'Requires local bank transfer only',
    };
  }
  if (job.paymentMethod) {
    return {
      key: 'cross_border_payment',
      result: 'UNKNOWN',
      reason: `Payment method listed: ${job.paymentMethod}; confirm cross-border`,
    };
  }
  return { key: 'cross_border_payment', result: 'UNKNOWN', reason: 'Payment method not specified' };
}

export async function checkApplicationUrlAccessible(
  job: NormalizedRemoteJob,
  opts?: { timeoutMs?: number },
): Promise<EligibilityDimension> {
  if (!job.applicationUrl) {
    return {
      key: 'application_url_accessible',
      result: 'FAIL',
      reason: 'No application URL provided',
    };
  }
  const res = await safeHttpFetch(job.applicationUrl, {
    method: 'HEAD',
    timeoutMs: opts?.timeoutMs ?? 10000,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
  });
  if (res.errorCode === 'TIMEOUT') {
    return {
      key: 'application_url_accessible',
      result: 'UNKNOWN',
      reason: 'Application URL probe timed out; manual confirm',
    };
  }
  if (res.status === 0) {
    return {
      key: 'application_url_accessible',
      result: 'UNKNOWN',
      reason: `Application URL probe failed: ${res.errorCode ?? res.errorMessage ?? 'network'}`,
    };
  }
  if (res.status === 404 || res.status === 410) {
    return {
      key: 'application_url_accessible',
      result: 'FAIL',
      reason: `Application URL ${res.status}`,
    };
  }
  if (res.ok || (res.status >= 200 && res.status < 400)) {
    return { key: 'application_url_accessible', result: 'PASS', reason: `HTTP ${res.status}` };
  }
  if (res.status === 403 || res.status === 429) {
    return {
      key: 'application_url_accessible',
      result: 'UNKNOWN',
      reason: `Application URL blocked (HTTP ${res.status}); manual confirm`,
    };
  }
  return {
    key: 'application_url_accessible',
    result: 'FAIL',
    reason: `Application URL HTTP ${res.status}`,
  };
}

export function computeEligibilityFromDimensions(
  dims: EligibilityDimension[],
): EligibilityCheckResult {
  let passCount = 0;
  let unknownCount = 0;
  let failCount = 0;
  const needToConfirm: string[] = [];
  for (const d of dims) {
    if (d.result === 'PASS') passCount++;
    else if (d.result === 'UNKNOWN') {
      unknownCount++;
      if (d.reason) needToConfirm.push(dimensionNeedToConfirmText(d));
    } else failCount++;
  }
  const cambodiaDim = dims.find((d) => d.key === 'cambodia_allowed');
  const urlDim = dims.find((d) => d.key === 'application_url_accessible');
  let status: EligibilityStatus = 'NEEDS_CONFIRMATION';
  if (failCount > 0) status = 'NOT_ELIGIBLE';
  else if (unknownCount === 0) status = 'CONFIRMED';
  return {
    status,
    dimensions: dims,
    passCount,
    unknownCount,
    failCount,
    needToConfirm,
    confirmedAcceptsCambodia: cambodiaDim?.result === 'PASS',
  };
  function dimensionNeedToConfirmText(d: EligibilityDimension): string {
    switch (d.key) {
      case 'cambodia_allowed':
        return '申请前请确认是否接受 Cambodia';
      case 'country_restrictions':
        return '请确认国家 / 地区限制';
      case 'work_authorization':
        return '请确认是否需要当地工作许可';
      case 'timezone':
        return '请确认时区要求是否可满足';
      case 'independent_contractor':
        return '请确认是否接受独立承包商';
      case 'cross_border_payment':
        return '请确认跨境付款方式';
      case 'application_url_accessible':
        return '请手动核查申请链接是否可访问';
    }
  }
}

export async function evaluateEligibility(
  job: NormalizedRemoteJob,
  opts?: {
    userTimezone?: string | null;
    overlapMinHours?: number;
    candidateOverlapHours?: number | null;
    skipUrlProbe?: boolean;
    urlProbeTimeoutMs?: number;
  },
): Promise<EligibilityCheckResult> {
  const dims: EligibilityDimension[] = [
    checkCambodia(job),
    checkCountryRestrictions(job),
    checkWorkAuthorization(job),
    checkTimezone(job, {
      userTimezone: opts?.userTimezone,
      overlapMinHours: opts?.overlapMinHours,
      candidateOverlapHours: opts?.candidateOverlapHours,
    }),
    checkIndependentContractor(job),
    checkPaymentMethod(job),
  ];
  if (opts?.skipUrlProbe) {
    dims.push({
      key: 'application_url_accessible',
      result: job.applicationUrl ? 'UNKNOWN' : 'FAIL',
      reason: job.applicationUrl
        ? 'URL probe skipped during batch pre-flight; run eligibility check separately'
        : 'No application URL',
    });
  } else {
    dims.push(await checkApplicationUrlAccessible(job, { timeoutMs: opts?.urlProbeTimeoutMs }));
  }
  return computeEligibilityFromDimensions(dims);
}

export function evaluateEligibilitySyncNoUrl(
  job: NormalizedRemoteJob,
  opts?: {
    userTimezone?: string | null;
    overlapMinHours?: number;
    candidateOverlapHours?: number | null;
  },
): EligibilityCheckResult {
  const dims: EligibilityDimension[] = [
    checkCambodia(job),
    checkCountryRestrictions(job),
    checkWorkAuthorization(job),
    checkTimezone(job, {
      userTimezone: opts?.userTimezone,
      overlapMinHours: opts?.overlapMinHours,
      candidateOverlapHours: opts?.candidateOverlapHours,
    }),
    checkIndependentContractor(job),
    checkPaymentMethod(job),
    {
      key: 'application_url_accessible',
      result: job.applicationUrl ? 'UNKNOWN' : 'FAIL',
      reason: job.applicationUrl
        ? 'URL probe not run in sync preview; UNKNOWN → NEEDS_CONFIRMATION'
        : 'No application URL',
    },
  ];
  return computeEligibilityFromDimensions(dims);
}

@Injectable()
export class RemoteJobEligibilityService {
  evaluate(
    job: NormalizedRemoteJob,
    opts?: {
      userTimezone?: string | null;
      overlapMinHours?: number;
      candidateOverlapHours?: number | null;
      skipUrlProbe?: boolean;
      urlProbeTimeoutMs?: number;
    },
  ): Promise<EligibilityCheckResult> {
    return evaluateEligibility(job, opts);
  }

  evaluateSyncNoUrl(
    job: NormalizedRemoteJob,
    opts?: {
      userTimezone?: string | null;
      overlapMinHours?: number;
      candidateOverlapHours?: number | null;
    },
  ): EligibilityCheckResult {
    return evaluateEligibilitySyncNoUrl(job, opts);
  }

  computeFromDimensions(dims: EligibilityDimension[]): EligibilityCheckResult {
    return computeEligibilityFromDimensions(dims);
  }
}
