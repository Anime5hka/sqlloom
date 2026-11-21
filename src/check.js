import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { Schedule, TxRunner } from './run.js';
import { UnsafeError } from './errors.js';
import { formatReport } from './format.js';

export const LEVELS = ['read committed', 'repeatable read', 'serializable'];
const LEVEL_ALIASES = {
  rc: 'read committed', 'read-committed': 'read committed', 'read committed': 'read committed',
  rr: 'repeatable read', 'repeatable-read': 'repeatable read', 'repeatable read': 'repeatable read',
  ser: 'serializable', s: 'serializable', serializable: 'serializable',
};

export function normalizeLevel(level) {
  const l = LEVEL_ALIASES[String(level).toLowerCase().trim()];
  if (!l) throw new Error(`sqlloom: unknown isolation level "${level}" (use read committed, repeatable read or serializable)`);
  return l;
}

function dbUrl(config) {
  const url = config.url ?? process.env.SQLLOOM_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('sqlloom: no database. Pass { url } or set SQLLOOM_URL (see README: one `docker run` line)');
  return url;
}

function wrapClient(client) {
  return {
    query: async (sql, params = []) => {
      const res = await client.query(sql, params);
      const rows = res.rows ?? [];
      rows.rowCount = res.rowCount;
      rows.command = res.command;
      return rows;
    },
  };
}

async function connect(url, schema) {
  const client = new pg.Client({ connectionString: url, application_name: 'sqlloom' });
  await client.connect();
  client.on('error', () => {});
  // Durability is irrelevant for a throwaway schema; skipping the WAL flush makes COMMIT much
  // faster and does not change isolation semantics.
  await client.query(`SET search_path TO ${schema}; SET synchronous_commit = off`);
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  return { client, pid };
}

function quoteIdent(s) {
  return `"${s.replace(/"/g, '""')}"`;
}

function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

function outcomeKey(o) {
  // A transaction that rolled back left no trace; *why* it failed (an app-level check vs. a
  // constraint violation) doesn't change the data, so only the fact that it failed is compared.
  if (o.kind === 'committed') return `committed:${JSON.stringify(o.value ?? null)}`;
  return o.kind;
}

function switches(trace) {
  let last = null;
  let n = 0;
  for (const s of trace) {
    if (s.type !== 'send') continue;
    if (last !== null && s.tx !== last) n++;
    last = s.tx;
  }
  return n;
}

function compareReplay(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** One private schema plus one connection per transaction (and one for setup/checks). */
class Worker {
  static async open(url, config, names) {
    const w = new Worker();
    w.config = config;
    w.names = names;
    w.schema = `sqlloom_${randomBytes(4).toString('hex')}`;
    const ctl = new pg.Client({ connectionString: url, application_name: 'sqlloom' });
    await ctl.connect();
    ctl.on('error', () => {});
    w.ctl = ctl;
    w.db = wrapClient(ctl);
    w.conns = [];
    await ctl.query(`CREATE SCHEMA ${w.schema}; SET search_path TO ${w.schema}; SET synchronous_commit = off`);
    for (let i = 0; i < names.length; i++) {
      const c = await connect(url, w.schema);
      // Superusers can shorten deadlock detection (default 1s); harmless if not allowed.
      await c.client.query("SET deadlock_timeout = '20ms'").catch(() => {});
      w.conns.push(c);
    }
    return w;
  }

  async reset() {
    const { setup } = this.config;
    const drop = `DROP SCHEMA IF EXISTS ${this.schema} CASCADE; CREATE SCHEMA ${this.schema};`;
    if (typeof setup === 'string') {
      await this.ctl.query(`${drop}\n${setup}`);
    } else {
      await this.ctl.query(drop);
      if (typeof setup === 'function') await setup(this.db);
    }
  }

  async snapshot() {
    if (this.config.snapshot) return this.config.snapshot(this.db);
    if (!this.snapshotSql) {
      const tables = await this.db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
        [this.schema],
      );
      const parts = tables.map(({ table_name: t }) => {
        const lit = `'${t.replace(/'/g, "''")}'`;
        return `${lit}, (SELECT coalesce(json_agg(r ORDER BY r::text), '[]'::json) FROM ${quoteIdent(t)} r)`;
      });
      this.snapshotSql = parts.length ? `SELECT json_build_object(${parts.join(', ')}) AS s` : "SELECT '{}'::json AS s";
    }
    return (await this.ctl.query(this.snapshotSql)).rows[0].s;
  }

  async invariant() {
    if (!this.config.invariant) return null;
    try {
      const ok = await this.config.invariant(this.db);
      return ok === false ? 'invariant returned false' : null;
    } catch (e) {
      return e?.message ?? String(e);
    }
  }

  runner(name) {
    const i = this.names.indexOf(name);
    return new TxRunner(name, this.config.transactions[name], this.conns[i].client, this.conns[i].pid);
  }

  async schedule(txNames, level, choose) {
    const runners = txNames.map((n) => this.runner(n));
    const sched = new Schedule({ ctl: this.ctl, runners, level, choose });
    try {
      await sched.run();
    } finally {
      // Leave no connection inside a transaction, whatever happened.
      for (const r of runners) {
        if (r.inflight) await r.inflight.promise;
        if (r.state !== 'done') await r.client.query('ROLLBACK').catch(() => {});
      }
    }
    return { trace: sched.trace, outcomes: Object.fromEntries(runners.map((r) => [r.name, r.outcome])) };
  }

  async run(level, choose) {
    await this.reset();
    const { trace, outcomes } = await this.schedule(this.names, level, choose);
    return { trace, outcomes, state: await this.snapshot(), invariantError: await this.invariant() };
  }

  async serial(order) {
    await this.reset();
    const outcomes = {};
    for (const n of order) {
      Object.assign(outcomes, (await this.schedule([n], 'serializable', () => 0)).outcomes);
    }
    return { order, outcomes, state: JSON.stringify(await this.snapshot()) };
  }

  async close() {
    await this.ctl.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`).catch(() => {});
    await Promise.all([this.ctl, ...this.conns.map((c) => c.client)].map((c) => c.end().catch(() => {})));
  }
}

/**
 * Run every interleaving of `config.transactions` at each isolation level.
 * Returns a report; never throws for unsafe results (see assertSafe).
 */
export async function check(config) {
  const names = Object.keys(config.transactions ?? {});
  if (names.length < 2) throw new Error('sqlloom: give at least two transactions');
  const levels = (config.levels ?? LEVELS).map(normalizeLevel);
  const maxSchedules = config.maxSchedules ?? 5000;
  const replay = config.replay !== undefined && config.replay !== null
    ? String(config.replay).split('.').filter(Boolean).map(Number)
    : null;
  const parallel = replay ? 1 : Math.max(1, config.parallel ?? Math.min(4, availableParallelism()));
  const url = dbUrl(config);
  const checkSerial = config.serializable !== false;

  const workers = [];
  try {
    for (let i = 0; i < parallel; i++) workers.push(await Worker.open(url, config, names));

    const serialCache = new Map();
    const serialRuns = (w, subset) => {
      const key = subset.join('\u0000');
      if (!serialCache.has(key)) {
        serialCache.set(key, (async () => {
          const runs = [];
          for (const order of permutations(subset)) runs.push(await w.serial(order));
          return runs;
        })());
      }
      return serialCache.get(key);
    };
    const findSerialMatch = async (w, run) => {
      const survivors = names.filter((n) => run.outcomes[n].kind !== 'aborted');
      const state = JSON.stringify(run.state);
      const serial = await serialRuns(w, survivors);
      const match = serial.find((s) => s.state === state
        && survivors.every((n) => outcomeKey(s.outcomes[n]) === outcomeKey(run.outcomes[n])));
      return { match, serial };
    };

    const report = { transactions: names, level: config.level ? normalizeLevel(config.level) : null, levels: [] };
    for (const level of levels) {
      const lr = { level, schedules: 0, complete: false, invariantFailures: 0, anomalies: 0, aborts: 0, worst: null };
      // Depth-first enumeration of the choice tree, shared between workers: every finished run
      // queues the untried siblings of each choice it made beyond its own prefix.
      const tasks = [replay ?? []];
      let active = 0;
      let waiting = [];
      const wake = () => { const ws = waiting; waiting = []; ws.forEach((f) => f()); };

      const work = async (w) => {
        for (;;) {
          if (lr.schedules >= maxSchedules) return;
          if (!tasks.length) {
            if (!active) return;
            await new Promise((r) => waiting.push(r));
            continue;
          }
          const prefix = tasks.pop();
          lr.schedules++;
          active++;
          try {
            const decisions = [];
            const choose = (n) => {
              const i = decisions.length < prefix.length ? Math.min(prefix[decisions.length], n - 1) : 0;
              decisions.push({ i, n });
              return i;
            };
            const run = await w.run(level, choose);
            if (!replay) {
              for (let d = decisions.length - 1; d >= prefix.length; d--) {
                for (let j = decisions[d].n - 1; j > decisions[d].i; j--) {
                  tasks.push([...decisions.slice(0, d).map((x) => x.i), j]);
                }
              }
            }
            if (Object.values(run.outcomes).some((o) => o.kind === 'aborted')) lr.aborts++;
            let problem = null;
            if (run.invariantError) {
              lr.invariantFailures++;
              problem = { kind: 'invariant', message: run.invariantError };
            } else if (checkSerial) {
              const { match, serial } = await findSerialMatch(w, run);
              if (!match) {
                lr.anomalies++;
                problem = { kind: 'anomaly', serial };
              }
            }
            const replayToken = decisions.map((d) => d.i).join('.');
            if (replay) lr.replayed = { ...run, problem, replay: replayToken };
            if (problem) {
              const sw = switches(run.trace);
              const better = !lr.worst || sw < lr.worst.switches
                || (sw === lr.worst.switches && compareReplay(replayToken, lr.worst.replay) < 0);
              if (better) lr.worst = { ...run, problem, switches: sw, replay: replayToken };
            }
          } finally {
            active--;
            wake();
          }
        }
      };
      await Promise.all(workers.map(work));
      lr.complete = tasks.length === 0;
      lr.verdict = lr.invariantFailures || lr.anomalies ? 'unsafe' : lr.aborts ? 'retry' : 'safe';
      report.levels.push(lr);
    }
    return report;
  } finally {
    await Promise.all(workers.map((w) => w.close()));
  }
}

/** Throws UnsafeError (with the formatted report) if `config.level` (default: read committed) is unsafe. */
export async function assertSafe(config) {
  const level = normalizeLevel(config.level ?? 'read committed');
  const report = await check({ ...config, level, levels: config.levels ?? [level] });
  const lr = report.levels.find((l) => l.level === level);
  if (lr.verdict === 'unsafe') throw new UnsafeError(formatReport(report, { color: false }), report);
  return report;
}
