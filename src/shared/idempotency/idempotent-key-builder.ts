// Stable idempotency key helpers. Never change formats; only append new builders.
// Spec: docs/JobTinder-V0.1-技术架构与代码边界.md §13

export const IdempotentKeyBuilder = {
  interest(params: {
    candidateId: bigint | string | number;
    jobId: bigint | string | number;
    actorSide: 'CANDIDATE' | 'COMPANY';
    candidateVersion: number;
    jobVersion: number;
  }): string {
    return `interest:${params.candidateId}:${params.jobId}:${params.actorSide}:${params.candidateVersion}:${params.jobVersion}`;
  },

  match(params: {
    candidateId: bigint | string | number;
    jobId: bigint | string | number;
    candidateVersion: number;
    jobVersion: number;
  }): string {
    const sum = Number(params.candidateVersion) + Number(params.jobVersion);
    return `match:${params.candidateId}:${params.jobId}:v${sum}`;
  },

  notification(params: {
    type: string;
    objectId: bigint | string | number;
    objectVersion: number | string;
  }): string {
    return `notification:${params.type}:${params.objectId}:v${params.objectVersion}`;
  },

  interestReminder24h(interestId: bigint | string | number): string {
    return `notification:INTEREST_REMINDER_24H:${interestId}:v1`;
  },

  interestPause72h(interestId: bigint | string | number): string {
    return `notification:INTEREST_PAUSE_72H:${interestId}:v1`;
  },

  crawl(params: { sourceId: string; sourceJobId: string; parseVersion: number | string }): string {
    return `crawl:${params.sourceId}:${params.sourceJobId}:v${params.parseVersion}`;
  },
} as const;
