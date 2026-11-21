import pg from 'pg';
import { randomBytes } from 'node:crypto';
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
  await client.query(`SET search_path TO ${schema}`);
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  return { client, pid };
}

async function defaultSnapshot(db, schema) {
  const tables = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
    [schema],
  );
  const out = {};
  for (const { table_name: t } of tables) {
    const rows = await db.query(`SELECT * FROM "${t.replace(/"/g, '""')}"`);
    out[t] = rows.map((r) => JSON.stringify(r)).sort().map((s) => JSON.parse(s));
  }
  return out;
}

function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

function outcomeKey(o) {
  if (o.kind === 'committed') return `committed:${JSON.stringify(o.value ?? null)}`;
  return `${o.kind}:${o.error?.message}`;
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

/**
 * Run every interleaving of `config.transactions` at each isolation level.
 * Returns a report; never throws for unsafe results (see assertSafe).
 */
export async function check(config) {
  const names = Object.keys(config.transactions ?? {});
  if (names.length < 2) throw new Error('sqlloom: give at least two transactions');
  const levels = (config.levels ?? LEVELS).map(normalizeLevel);
  const maxSchedules = config.maxSchedules ?? 2000;
  const url = dbUrl(config);
  const schema = `sqlloom_${randomBytes(4).toString('hex')}`;

  const ctlConn = new pg.Client({ connectionString: url, application_name: 'sqlloom' });
  await ctlConn.connect();
  ctlConn.on('error', () => {});
  const ctl = wrapClient(ctlConn);
  const conns = [];
  try {
    await ctlConn.query(`CREATE SCHEMA ${schema}`);
    await ctlConn.query(`SET search_path TO ${schema}`);
    for (const name of names) {
      const c = await connect(url, schema);
      // Superusers can shorten deadlock detection (default 1s); harmless if not allowed.
      await c.client.query("SET deadlock_timeout = '20ms'").catch(() => {});
      conns.push(c);
    }

    const reset = async () => {
      await ctlConn.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
      if (typeof config.setup === 'function') await config.setup(ctl);
      else if (config.setup) await ctlConn.query(config.setup);
    };
    const snapshot = async () => (config.snapshot ? config.snapshot(ctl) : defaultSnapshot(ctl, schema));
    const invariant = async () => {
      if (!config.invariant) return null;
      try {
        const ok = await config.invariant(ctl);
        return ok === false ? 'invariant returned false' : null;
      } catch (e) {
        return e?.message ?? String(e);
      }
    };

    const runSchedule = async (txNames, level, choose) => {
      await reset();
      const runners = txNames.map((n) => {
        const i = names.indexOf(n);
        return new TxRunner(n, config.transactions[n], conns[i].client, conns[i].pid);
      });
      const sched = new Schedule({ ctl: ctlConn, runners, level, choose });
      let trace;
      try {
        trace = await sched.run();
      } finally {
        // Leave no connection inside a transaction, whatever happened.
        for (const r of runners) {
          if (r.inflight) await r.inflight.promise;
          await r.client.query('ROLLBACK').catch(() => {});
        }
      }
      const outcomes = Object.fromEntries(runners.map((r) => [r.name, r.outcome]));
      return { trace, outcomes, state: await snapshot(), invariantError: await invariant() };
    };

    // Serial executions, computed on demand per subset of transactions.
    const serialCache = new Map();
    const serialRuns = async (subset) => {
      const key = subset.join('\u0000');
      if (!serialCache.has(key)) {
        const runs = [];
        for (const order of permutations(subset)) {
          await reset();
          const outcomes = {};
          for (const n of order) {
            const i = names.indexOf(n);
            const r = new TxRunner(n, config.transactions[n], conns[i].client, conns[i].pid);
            await new Schedule({ ctl: ctlConn, runners: [r], level: 'serializable', choose: () => 0 }).run();
            outcomes[n] = r.outcome;
          }
          runs.push({ order, outcomes, state: JSON.stringify(await snapshot()) });
        }
        serialCache.set(key, runs);
      }
      return serialCache.get(key);
    };
    const findSerialMatch = async (run) => {
      const survivors = names.filter((n) => run.outcomes[n].kind !== 'aborted');
      const state = JSON.stringify(run.state);
      const serial = await serialRuns(survivors);
      const match = serial.find((s) => s.state === state
        && survivors.every((n) => outcomeKey(s.outcomes[n]) === outcomeKey(run.outcomes[n])));
      return { match, serial };
    };

    const report = { transactions: names, level: config.level ? normalizeLevel(config.level) : null, levels: [] };
    const checkSerial = config.serializable !== false;
    for (const level of levels) {
      const lr = { level, schedules: 0, complete: false, invariantFailures: 0, anomalies: 0, aborts: 0, worst: null };
      let prefix = [];
      while (lr.schedules < maxSchedules) {
        const decisions = [];
        const choose = (n) => {
          const want = decisions.length < prefix.length ? prefix[decisions.length].i : 0;
          const i = Math.min(want, n - 1);
          decisions.push({ i, n });
          return i;
        };
        const run = await runSchedule(names, level, choose);
        lr.schedules++;
        if (Object.values(run.outcomes).some((o) => o.kind === 'aborted')) lr.aborts++;
        let problem = null;
        if (run.invariantError) {
          lr.invariantFailures++;
          problem = { kind: 'invariant', message: run.invariantError };
        } else if (checkSerial) {
          const { match, serial } = await findSerialMatch(run);
          if (!match) {
            lr.anomalies++;
            problem = { kind: 'anomaly', serial };
          }
        }
        if (problem) {
          const sw = switches(run.trace);
          if (!lr.worst || sw < lr.worst.switches) {
            lr.worst = { ...run, problem, switches: sw, replay: decisions.map((d) => d.i).join('.') };
          }
        }
        while (decisions.length && decisions[decisions.length - 1].i + 1 >= decisions[decisions.length - 1].n) decisions.pop();
        if (!decisions.length) { lr.complete = true; break; }
        decisions[decisions.length - 1].i++;
        prefix = decisions;
      }
      lr.verdict = lr.invariantFailures || lr.anomalies ? 'unsafe' : lr.aborts ? 'retry' : 'safe';
      report.levels.push(lr);
    }
    return report;
  } finally {
    await ctlConn.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await Promise.all([ctlConn.end(), ...conns.map((c) => c.client.end())].map((p) => p.catch(() => {})));
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
