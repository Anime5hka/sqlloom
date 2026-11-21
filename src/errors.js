// SQLSTATEs that mean "the database aborted this transaction; retry it".
const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

export function isRetryable(e) {
  return RETRYABLE.has(e?.code);
}

export class UnsafeError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'UnsafeError';
    this.report = report;
  }
}
