// SQLSTATEs that mean "the database aborted this transaction; retry it".
const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

// ORMs wrap driver errors (Drizzle: DrizzleQueryError with the pg error as `cause`).
export function dbError(e) {
  for (let x = e, depth = 0; x && depth < 5; x = x.cause, depth++) {
    if (typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code)) return x;
  }
  return null;
}

export function isRetryable(e) {
  return RETRYABLE.has(dbError(e)?.code);
}

export class UnsafeError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'UnsafeError';
    this.report = report;
  }
}
