// One schedule: runs every transaction on its own connection and lets `choose`
// decide which transaction sends its next query.
import { dbError, isRetryable } from './errors.js';

const POLL_TIMEOUT_MS = 10_000;
const FAST_PATH_MS = 3;

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
    this.lastError = undefined;
    this.event = deferred();
    this.rollbackRequested = false;
    this.finishAfterInflight = null;
    const park = (sql, params, extra) => {
      if (this.pending || this.inflight) {
        return Promise.reject(new Error(`sqlloom: transaction "${this.name}" issued a query while another one was still running; await each query before sending the next`));
      }
      if (this.state === 'done') {
        return Promise.reject(new Error(`sqlloom: transaction "${this.name}" already finished`));
      }
      return new Promise((resolve, reject) => {
        this.pending = { kind: 'query', sql, params: params ?? [], resolve, reject, ...extra };
        this.state = 'ready';
        this.event.resolve();
      });
    };
    const db = {
      query: (sql, params = []) => park(sql, params),
      pg: pgAdapter(this, park),
    };
    Promise.resolve()
      .then(() => this.fn(db))
      .then(
        (v) => { this.fnResult = v; this.finishBody(false); },
        (e) => { this.fnError = e; this.finishBody(true); },
      );
  }

  finishBody(failed) {
    if (!failed && this.rollbackRequested) {
      this.fnError = new Error('the transaction code sent ROLLBACK');
      failed = true;
    }
    const kind = failed ? 'rollback' : 'commit';
    if (this.inflight) {
      // The body gave up while one of its queries was still running (it fired two at once):
      // finish once that query is back, so the scheduler never sees two operations at a time.
      this.finishAfterInflight = kind;
      return;
    }
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
  constructor({ ctl, runners, level, choose, retries = 0 }) {
    this.ctl = ctl;
    this.retries = retries;
    this.runners = runners;
    this.level = level;
    this.choose = choose;
    this.trace = [];
    this.byPid = new Map(runners.map((r) => [r.pid, r.name]));
  }

  async run() {
    for (const r of this.runners) {
      r.attempts = 0;
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
    inflight.promise = r.client.query({ text: op.sql, values: op.params, rowMode: op.rowMode, types: op.types }).then(
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
    // Most queries answer in well under a millisecond; only ask Postgres about locks if this one doesn't.
    if (!r.inflight.settled) {
      let timer;
      await Promise.race([r.inflight.promise, new Promise((res) => { timer = setTimeout(res, FAST_PATH_MS); })]);
      clearTimeout(timer);
    }
    for (;;) {
      if (r.inflight.settled) return null;
      const s = await lockState(this.ctl, r.pid);
      if (r.inflight.settled) return null;
      // Waiting with no blocker means the lock holder just finished and this query is about to
      // continue (row locks are re-acquired after waking): keep polling so nothing can overtake it.
      if (s.waiting && s.blockers?.length && !keepWaiting) return s.blockers;
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        throw new Error(`sqlloom: "${r.name}" has been waiting for ${POLL_TIMEOUT_MS / 1000}s on: ${r.inflight.op.sql}`);
      }
      if (s.waiting) await new Promise((res) => setTimeout(res, 1));
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
    if (error) {
      step.error = { code: error.code, message: error.message };
      r.lastError = error;
    }
    else step.result = summarize(value);

    if (op.kind === 'query') {
      if (r.finishAfterInflight) {
        const kind = r.finishAfterInflight;
        r.finishAfterInflight = null;
        r.pending = { kind, sql: kind.toUpperCase(), params: [] };
        r.state = 'ready';
        return;
      }
      r.state = 'running';
      if (error) op.reject(error);
      else if (op.raw) op.resolve(value);
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
        // COMMIT of a transaction whose query error the user code caught: Postgres rolled it back.
        r.outcome = classifyError(r.lastError ?? { code: '25P02', message: 'transaction was already aborted when COMMIT ran' });
      } else r.outcome = { kind: 'committed', value: r.fnResult };
    } else {
      r.outcome = classifyError(r.fnError);
    }
    if (r.outcome.kind === 'aborted' && r.attempts < this.retries) {
      // Model the app's retry loop: start the transaction again, as a new BEGIN on the same connection.
      r.attempts++;
      this.trace.push({ type: 'retry', tx: r.name, op: `BEGIN (retry ${r.attempts} after ${r.outcome.error?.code})` });
      await r.client.query(`BEGIN ISOLATION LEVEL ${this.level.toUpperCase()}`);
      r.start(this.level);
      await r.idle();
    }
  }
}

// Transaction control the ORM sends itself (`db.transaction(...)`). sqlloom already wrapped the
// function in BEGIN ... COMMIT at the level under test, so these are answered locally.
// `ROLLBACK TO SAVEPOINT` and `COMMIT PREPARED` are real steps and go to Postgres.
const TX_CONTROL = /^\s*(begin|start\s+transaction|commit|end|rollback|abort)\b([^;]*);?\s*$/i;

function txControl(text) {
  const m = TX_CONTROL.exec(text);
  if (!m || /\b(to|prepared|chain)\b/i.test(m[2])) return null;
  const word = m[1].toLowerCase();
  if (word === 'commit' || word === 'end') return 'COMMIT';
  if (word === 'rollback' || word === 'abort') return 'ROLLBACK';
  return 'BEGIN';
}

// A pg.Client / pg.Pool look-alike whose queries are scheduled steps, so ORMs built on
// node-postgres (Drizzle, Kysely, ...) run unchanged inside a scenario.
function pgAdapter(runner, park) {
  const client = {
    processID: runner.pid,
    query(config, values, callback) {
      if (typeof values === 'function') { callback = values; values = undefined; }
      const cfg = typeof config === 'string' ? { text: config } : config;
      if (!cfg || typeof cfg.text !== 'string') {
        return Promise.reject(new Error('sqlloom: db.pg.query supports query text or { text, values } objects (no cursors or streams)'));
      }
      const params = values ?? cfg.values ?? [];
      let p;
      const command = txControl(cfg.text);
      if (command) {
        if (command === 'ROLLBACK') runner.rollbackRequested = true;
        p = Promise.resolve({ command, rowCount: null, rows: [], fields: [], oid: null });
      } else {
        p = park(cfg.text, params, { raw: true, rowMode: cfg.rowMode, types: cfg.types });
      }
      if (callback) { p.then((r) => callback(null, r), (e) => callback(e)); return undefined; }
      return p;
    },
    // Pool-shaped API: every "connection" is this transaction's connection.
    connect: async () => client,
    release: () => {},
    end: async () => {},
    on: () => client,
    off: () => client,
    removeListener: () => client,
  };
  return client;
}

function classifyError(e) {
  const root = dbError(e);
  const error = root ? { code: root.code, message: root.message } : { message: e?.message ?? String(e) };
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
