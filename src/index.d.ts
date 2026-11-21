export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';
export type LevelName = IsolationLevel | 'rc' | 'rr' | 'ser' | 'read-committed' | 'repeatable-read';

/** Rows of a query result, with the command tag and affected-row count attached. */
export type Rows<T = Record<string, any>> = T[] & { rowCount: number | null; command: string };

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<Rows<T>>;
}

/** One transaction: sqlloom wraps it in BEGIN … COMMIT (or ROLLBACK if it throws). */
export type Transaction = (db: Db) => unknown | Promise<unknown>;

export interface Scenario {
  /** SQL run before every schedule in a fresh schema, or a function that does the same. */
  setup?: string | ((db: Db) => unknown | Promise<unknown>);
  /** Two or more named transactions that run concurrently. */
  transactions: Record<string, Transaction>;
  /** Throw (or return false) if the final state is wrong. */
  invariant?: (db: Db) => unknown | Promise<unknown>;
  /** Override what "final state" means for the serial-equivalence check (default: every table). */
  snapshot?: (db: Db) => unknown | Promise<unknown>;
}

export interface CheckOptions extends Scenario {
  /** Postgres URL. Default: $SQLLOOM_URL, then $DATABASE_URL. */
  url?: string;
  /** Levels to test (default: all three). */
  levels?: LevelName[];
  /** The level your app runs at; marked in the report and used by assertSafe. */
  level?: LevelName;
  /** Max schedules per level (default 5000). */
  maxSchedules?: number;
  /** Compare every result with the serial executions (default true). */
  serializable?: boolean;
  /** Worker schemas exploring in parallel (default: min(4, CPUs)). */
  parallel?: number;
  /** Run exactly one schedule, from a replay token in a report. */
  replay?: string;
}

export interface TraceStep {
  type: 'send' | 'unblock';
  tx: string;
  op: string;
  result?: string;
  error?: { code?: string; message: string };
  blockedBy?: string[];
}

export type Outcome =
  | { kind: 'committed'; value: unknown }
  | { kind: 'failed' | 'aborted'; error: { code?: string; message: string } };

export interface SerialRun {
  order: string[];
  outcomes: Record<string, Outcome>;
  state: string;
}

export interface Run {
  trace: TraceStep[];
  outcomes: Record<string, Outcome>;
  state: unknown;
  invariantError: string | null;
  replay: string;
  problem: null | { kind: 'invariant'; message: string } | { kind: 'anomaly'; serial: SerialRun[] };
}

export interface LevelReport {
  level: IsolationLevel;
  schedules: number;
  /** true when every interleaving was run. */
  complete: boolean;
  invariantFailures: number;
  /** Schedules whose result matches no serial order. */
  anomalies: number;
  /** Schedules in which Postgres aborted a transaction (serialization failure / deadlock). */
  aborts: number;
  verdict: 'unsafe' | 'retry' | 'safe';
  /** The failing schedule with the fewest context switches. */
  worst: (Run & { switches: number }) | null;
  replayed?: Run;
}

export interface Report {
  transactions: string[];
  level: IsolationLevel | null;
  levels: LevelReport[];
}

export const LEVELS: IsolationLevel[];
export function check(options: CheckOptions): Promise<Report>;
/** Throws UnsafeError if `options.level` (default read committed) is unsafe. */
export function assertSafe(options: CheckOptions): Promise<Report>;
export function formatReport(report: Report, options?: { color?: boolean }): string;
export function formatTrace(trace: TraceStep[], options?: { color?: boolean }): string;
export class UnsafeError extends Error {
  report: Report;
}
