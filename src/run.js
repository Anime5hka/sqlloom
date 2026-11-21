// One schedule: runs every transaction on its own connection and lets `choose`
// decide which transaction sends its next query.
import { isRetryable } from './errors.js';

const POLL_TIMEOUT_MS = 10_000;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

export class TxRunner {
  constructor(name, fn, client, pid) {
    this.name = name;
    this.fn = fn;
    this.client = client;
    this.pid = pid;
  }

  start(level) {
    this.level = level;
    this.pending = null; // { kind: 'query'|'commit'|'rollback', sql, params, resolve, reject }
    this.inflight = null; // { op, settled, value, error, promise }
    this.state = 'running'; // running | ready | blocked | done
    this.outcome = null; // { kind: 'committed'|'failed'|'aborted', value?, error? }
    this.fnResult = undefined;
    this.fnError = undefined;
    this.event = deferred();
    const db = {
      query: (sql, params = []) => {
        if (this.pending || this.inflight) {
          return Promise.reject(new Error(`sqlloom: transaction "${this.name}" issued a query while another one was still running; await each query before sending the next`));
        }
        if (this.state === 'done') {
          return Promise.reject(new Error(`sqlloom: transaction "${this.name}" already finished`));
        }
        return new Promise((resolve, reject) => {
          this.pending = { kind: 'query', sql, params, resolve, reject };
          this.state = 'ready';
          this.event.resolve();
        });
      },
    };
    Promise.resolve()
      .then(() => this.fn(db))
      .then(
        (v) => { this.fnResult = v; this.finishBody(false); },
        (e) => { this.fnError = e; this.finishBody(true); },
      );
  }

  finishBody(failed) {
    const kind = failed ? 'rollback' : 'commit';
    this.pending = { kind, sql: kind.toUpperCase(), params: [] };
    this.state = 'ready';
    this.event.resolve();
  }

  // Resolves when user code is parked on a query or has returned.
  async idle() {
    while (this.state === 'running') {
      await this.event.promise;
      this.event = deferred();
    }
  }
}

async function lockState(ctl, pid) {
  const { rows } = await ctl.query(
    "SELECT wait_event_type = 'Lock' AS waiting, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1",
    [pid],
  );
  return rows[0] ?? { waiting: false, blockers: [] };
}

export class Schedule {
  constructor({ ctl, runners, level, choose }) {
    this.ctl = ctl;
    this.runners = runners;
    this.level = level;
    this.choose = choose;
    this.trace = [];
    this.byPid = new Map(runners.map((r) => [r.pid, r.name]));
  }

  async run() {
    for (const r of this.runners) {
      await r.client.query(`BEGIN ISOLATION LEVEL ${this.level.toUpperCase()}`);
      r.start(this.level);
    }
    for (const r of this.runners) await r.idle();

    for (;;) {
      const enabled = this.runners.filter((r) => r.state === 'ready');
      if (enabled.length) {
        const r = enabled[this.choose(enabled.length, enabled.map((x) => x.name))];
        await this.send(r);
        await this.settleBlocked(false);
        continue;
      }
      if (this.runners.every((r) => r.state === 'done')) break;
      await this.settleBlocked(true);
    }
    return this.trace;
  }

  async send(r) {
    const op = r.pending;
    r.pending = null;
    r.state = 'running';
    const inflight = { op, settled: false };
    inflight.promise = r.client.query({ text: op.sql, values: op.params }).then(
      (res) => { inflight.settled = true; inflight.value = res; },
      (err) => { inflight.settled = true; inflight.error = err; },
    );
    r.inflight = inflight;
    const step = { type: 'send', tx: r.name, op: describe(op) };
    this.trace.push(step);
    const blocked = await this.waitOrBlock(r, false);
    if (blocked) {
      r.state = 'blocked';
      step.blockedBy = blocked.map((pid) => this.byPid.get(pid) ?? `pid ${pid}`);
      return;
    }
    await this.deliver(r, step);
  }

  // Polls until the in-flight query settles or (when !keepWaiting) is seen waiting on a lock.
  async waitOrBlock(r, keepWaiting) {
    const started = Date.now();
    for (;;) {
      if (r.inflight.settled) return null;
      const s = await lockState(this.ctl, r.pid);
      if (r.inflight.settled) return null;
      if (s.waiting && !keepWaiting) return s.blockers;
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        throw new Error(`sqlloom: "${r.name}" has been waiting for ${POLL_TIMEOUT_MS / 1000}s on: ${r.inflight.op.sql}`);
      }
      if (s.waiting) await new Promise((res) => setTimeout(res, 2));
    }
  }

  async settleBlocked(mustProgress) {
    const blocked = this.runners.filter((r) => r.state === 'blocked');
    if (!blocked.length) return;
    if (!mustProgress) {
      for (const r of blocked) {
        if (!(await this.waitOrBlock(r, false))) await this.deliver(r, this.unblockStep(r));
      }
      return;
    }
    // Every live transaction is waiting: a deadlock, which Postgres resolves by aborting one.
    await Promise.race(blocked.map((r) => r.inflight.promise));
    for (const r of blocked) {
      if (r.inflight.settled) await this.deliver(r, this.unblockStep(r));
    }
  }

  unblockStep(r) {
    const step = { type: 'unblock', tx: r.name, op: describe(r.inflight.op) };
    this.trace.push(step);
    return step;
  }

  async deliver(r, step) {
    const { op, value, error } = r.inflight;
    r.inflight = null;
    if (error) step.error = { code: error.code, message: error.message };
    else step.result = summarize(value);

    if (op.kind === 'query') {
      r.state = 'running';
      if (error) op.reject(error);
      else {
        const rows = value.rows;
        rows.rowCount = value.rowCount;
        rows.command = value.command;
        op.resolve(rows);
      }
      await r.idle();
      return;
    }
    // COMMIT or ROLLBACK finished: the transaction is over.
    r.state = 'done';
    if (op.kind === 'commit') {
      if (error) r.outcome = classifyError(error);
      else if (value.command === 'ROLLBACK') {
        // COMMIT of a transaction that hit an error the user code swallowed.
        r.outcome = { kind: 'aborted', error: { code: '25P02', message: 'transaction was already aborted when COMMIT ran' } };
      } else r.outcome = { kind: 'committed', value: r.fnResult };
    } else {
      r.outcome = classifyError(r.fnError);
    }
  }
}

function classifyError(e) {
  const error = { code: e?.code, message: e?.message ?? String(e) };
  return { kind: isRetryable(e) ? 'aborted' : 'failed', error };
}

function describe(op) {
  if (op.kind !== 'query') return op.sql;
  return inlineParams(op.sql, op.params);
}

export function inlineParams(sql, params) {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (!params?.length) return text;
  return text.replace(/\$(\d+)/g, (m, i) => (Number(i) <= params.length ? literal(params[Number(i) - 1]) : m));
}

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function summarize(res) {
  if (!res) return '';
  if (res.command === 'SELECT' || (res.rows && res.rows.length && res.fields?.length)) {
    const rows = res.rows;
    if (rows.length === 0) return '(no rows)';
    if (rows.length === 1 && Object.keys(rows[0]).length === 1) return JSON.stringify(Object.values(rows[0])[0]);
    const s = JSON.stringify(rows);
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  }
  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(res.command)) return res.command === 'ROLLBACK' ? 'ROLLBACK' : '';
  return `${res.command} ${res.rowCount ?? ''}`.trim();
}
