export type ID = string;
export type UnixMs = number;

export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_ERROR',
  'DEVICE_OFFLINE',
  'AGENT_OFFLINE',
  'DISPATCH_TIMEOUT',
  'INVITE_INVALID',
  'INVITE_EXPIRED',
  'INVITE_ALREADY_USED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type SuccessAck<T extends object = Record<string, never>> = { ok: true } & T;

export interface FailureAck {
  ok: false;
  error: ErrorCode;
  message?: string;
  details?: Record<string, unknown>;
}

export type Ack<T extends object = Record<string, never>> = SuccessAck<T> | FailureAck;

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_SET.has(value);
}

export function makeSuccess<T extends object = Record<string, never>>(payload?: T): SuccessAck<T> {
  return { ok: true, ...(payload ?? {}) } as SuccessAck<T>;
}

export function makeFailure(
  error: ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
): FailureAck {
  return {
    ok: false,
    error,
    ...(message === undefined ? {} : { message }),
    ...(details === undefined ? {} : { details }),
  };
}
