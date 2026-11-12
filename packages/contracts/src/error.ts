import { z } from 'zod';

/**
 * Typed failure returned across every Mona boundary. No stack traces, file
 * contents, credentials, or provider payloads belong here.
 */
export const ErrorCode = z.enum([
  'invalid_request',
  'untrusted_sender',
  'engine_unavailable',
  'capability_unsupported',
  'port_occupied',
  'permission_denied',
  'stale_ownership',
  'conflict',
  'identity_mismatch',
  'outcome_unknown',
  'schema_drift',
  'authentication_failed',
  'thread_mismatch',
  'oversize_event',
  'transport_failed',
  'stream_closed',
  'not_found',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResult = z
  .object({
    code: ErrorCode,
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    detail: z.string().max(2000).optional(),
  })
  .strict();
export type ErrorResult = z.infer<typeof ErrorResult>;

export function errorResult(code: ErrorCode, message: string, retryable = false, detail?: string): ErrorResult {
  return ErrorResult.parse({ code, message, retryable, ...(detail ? { detail } : {}) });
}
