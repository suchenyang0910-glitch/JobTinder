import type { AppErrorCodeType } from './app-error-code';

export class AppError extends Error {
  public readonly code: AppErrorCodeType;
  public readonly httpStatus?: number;
  public readonly retryable: boolean;
  public readonly metadata?: Record<string, unknown>;

  constructor(params: {
    code: AppErrorCodeType;
    message?: string;
    httpStatus?: number;
    retryable?: boolean;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(params.message ?? params.code);
    this.name = 'AppError';
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.retryable = params.retryable ?? this.defaultRetryable(params.code);
    this.metadata = params.metadata;
    if (params.cause) {
      // Node 16+ supports ErrorOptions.cause
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).cause = params.cause;
    }
  }

  private defaultRetryable(code: AppErrorCodeType): boolean {
    switch (code) {
      case 'AI_UNAVAILABLE':
      case 'AI_RATE_LIMITED':
      case 'INTERNAL_DB_ERROR':
      case 'INTERNAL_TX_FAILED':
      case 'NOTIFY_DELIVERY_FAILED':
      case 'CRAWL_SOURCE_BLOCKED':
        return true;
      default:
        return false;
    }
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
      // metadata intentionally not exposed outside internal logs
    };
  }
}
