import { z } from 'zod';
import { ErrorCode, type ErrorResult } from '@mona/contracts';

export const AdapterFailure = z
  .object({
    code: ErrorCode,
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    detail: z.string().max(2000).optional(),
  })
  .strict();
export type AdapterFailure = z.infer<typeof AdapterFailure>;

export type Result<T> = { ok: true; value: T } | { ok: false; error: AdapterFailure };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(
  code: z.infer<typeof ErrorCode>,
  message: string,
  options: { retryable?: boolean; detail?: string | undefined } = {},
): Result<never> {
  const error: AdapterFailure = {
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.detail ? { detail: options.detail } : {}),
  };
  return { ok: false, error };
}

export function toErrorResult(failure: AdapterFailure): ErrorResult {
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    ...(failure.detail ? { detail: failure.detail } : {}),
  };
}

/** Remove a bearer token and obvious credential shapes from any diagnostic text. */
export function redact(text: string, secrets: string[] = []): string {
  let value = text;
  for (const secret of secrets) {
    if (secret.length >= 8) value = value.split(secret).join('[redacted]');
  }
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]')
    .replace(/\b(sk|api|key)[-_][A-Za-z0-9]{12,}\b/gi, '[redacted]');
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && (error as { name?: string }).name === 'AbortError'
  );
}
