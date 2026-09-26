export type WorkMode = 'REMOTE' | 'ONSITE' | 'HYBRID';
export type RemoteScope = 'WORLDWIDE' | 'ASIA' | 'ASEAN' | 'CAMBODIA_ONLY' | 'COUNTRY_LIMITED';
export type WorkAuthorization = 'REQUIRED' | 'NOT_REQUIRED' | 'UNKNOWN';
export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'FREELANCE' | 'INTERNSHIP';
export type EligibilityStatus = 'CONFIRMED' | 'NEEDS_CONFIRMATION' | 'NOT_ELIGIBLE';
export type ApplicationStatus =
  'SAVED' | 'APPLYING' | 'APPLIED' | 'SCREENING' | 'INTERVIEW' | 'OFFER' | 'REJECTED' | 'EXPIRED';
export type RemoteSourceParserType = 'API' | 'RSS';

export const REMOTE_SOURCE_PLATFORM = {
  REMOTIVE_API: 'REMOTIVE',
  REMOTIVE_RSS: 'REMOTIVE',
  REMOTE_OK_RSS: 'REMOTE_OK',
} as const;

export type RemoteSourcePlatform =
  (typeof REMOTE_SOURCE_PLATFORM)[keyof typeof REMOTE_SOURCE_PLATFORM];

export interface RemoteRawJob {
  sourcePlatform: RemoteSourcePlatform;
  sourceParserType: RemoteSourceParserType;
  sourceJobId: string;
  sourceUrl: string;
  applicationUrl: string | null;
  title: string | null;
  companyName: string | null;
  descriptionRaw: string | null;
  salaryMinRaw: number | null;
  salaryMaxRaw: number | null;
  salaryCurrency: string | null;
  salaryTextRaw: string | null;
  tags: string[];
  categories: string[];
  locations: string[];
  regions: string[];
  eligibleCountriesRaw: string | null;
  allowedCountries: string[];
  excludedCountries: string[];
  employerCountry: string | null;
  timezoneRequired: string | null;
  timezoneOverlapHours: number | null;
  workAuthRaw: string | null;
  employmentTypeRaw: string | null;
  paymentMethodRaw: string | null;
  remoteScopeRaw: string | null;
  publishedAt: Date | null;
  deadlineAt: Date | null;
  lastSeenAt: Date;
  fetchedAt: Date;
  rawPayload: unknown;
  candidate_required_location?: string | null;
}

export interface NormalizedRemoteJob {
  raw: RemoteRawJob;

  workMode: WorkMode;
  remoteScope: RemoteScope | null;
  eligibleCountries: string[];
  employerCountry: string | null;
  timezoneRequired: string | null;
  timezoneOverlapHours: number | null;
  workAuthorization: WorkAuthorization;
  employmentType: EmploymentType | null;
  paymentMethod: string | null;
  salaryCurrency: string | null;
  applicationUrl: string | null;
  sourcePlatform: RemoteSourcePlatform;
  sourceLastSeenAt: Date;

  title: string | null;
  industry: string | null;
  skills: string[];
  tasks: string[];
  locations: string[];
  languagesRequired: string[];
  salaryStatus: 'PROVIDED' | 'NOT_PROVIDED' | 'NEGOTIABLE';
  salaryText: string | null;
  shifts: string[];

  idempotencyUrlKey: string | null;
  idempotencyPlatformJobKey: string;
  idempotencyCompanyTitleKey: string | null;

  originalPublishedAt: Date | null;
  originalDeadlineAt: Date | null;
}
