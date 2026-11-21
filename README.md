<h1 align="center">sqlloom 🧶</h1>

<p align="center">
  <b>Find the race conditions in your SQL transactions before production does.</b><br>
  sqlloom runs every interleaving of your transactions on a real Postgres, at every isolation level,<br>
  and shows you the exact one that corrupts your data.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/postgres-12%2B-336791" alt="postgres 12+">
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="node >= 20">
  <img src="https://img.shields.io/badge/types-included-3178c6" alt="TypeScript types included">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

<p align="center">
  <img src="assets/demo.svg" alt="sqlloom finding a write-skew race at read committed and repeatable read" width="900">
</p>

"Is `READ COMMITTED` enough here, or do I need `FOR UPDATE`? Or `SERIALIZABLE`?" Most of us answer that by reasoning about it, or by guessing, because the race only happens when two requests land in the same millisecond. sqlloom answers it the same way a model checker would. It takes your transaction code, including the `if` statements between the queries, and runs **every possible interleaving** of the queries against a real Postgres, once per isolation level. Then it tells you which levels are unsafe, which are safe if you retry, and the shortest interleaving that breaks.

## Quick start

```sh
# 1. A throwaway Postgres (any Postgres 12+ works; sqlloom only touches its own sqlloom_* schemas)
docker run -d --name sqlloom-pg -e POSTGRES_PASSWORD=sqlloom -p 54329:5432 postgres:17-alpine
export SQLLOOM_URL=postgres://postgres:sqlloom@localhost:54329/postgres

# 2. Install and run an example
npm install --save-dev github:Anime5hka/sqlloom
npx sqlloom node_modules/sqlloom/examples/on-call.mjs
```

## Write a scenario

A scenario is a setup, two or more transactions written as plain async functions, and (optionally) an invariant. Here's the classic write skew: at least one doctor must stay on call.

```js
// on-call.mjs
export default {
  setup: `
    CREATE TABLE doctors (name text PRIMARY KEY, on_call boolean NOT NULL);
    INSERT INTO doctors VALUES ('alice', true), ('bob', true);
  `,
  transactions: {
    alice: goOffCall('alice'),
    bob: goOffCall('bob'),
  },
  invariant: async (db) => {
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM doctors WHERE on_call');
    if (n === 0) throw new Error('nobody is on call');
  },
};

function goOffCall(name) {
  return async (db) => {
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM doctors WHERE on_call');
    if (n < 2) throw new Error('you are the last one on call');   // app logic between queries
    await db.query('UPDATE doctors SET on_call = false WHERE name = $1', [name]);
  };
}
```

```sh
npx sqlloom on-call.mjs            # exit code 1 if your level (default: read committed) is unsafe
```

sqlloom wraps each function in `BEGIN … COMMIT` (or `ROLLBACK` if it throws) on its own connection. Every `db.query` and every `COMMIT` is a step, and sqlloom chooses which transaction takes the next step.

### No invariant? It still finds the bug

Every result is compared with the **serial executions** of the same transactions (alice then bob, bob then alice). If the final tables, or a value a transaction returned, can't be explained by *any* serial order, that's an anomaly. A lost update needs no invariant at all:

```
✗ read committed: the result matches no serial order of the transactions
  Shortest interleaving (2 context switches, replay "0.1.1.1.0.0"):

   1  alice │ SELECT balance FROM accounts WHERE id = 1  → 100
   2  bob   │ SELECT balance FROM accounts WHERE id = 1  → 100
   3  bob   │ UPDATE accounts SET balance = 50 WHERE id = 1  → UPDATE 1
   4  bob   │ COMMIT
   5  alice │ UPDATE accounts SET balance = 20 WHERE id = 1  → UPDATE 1
   6  alice │ COMMIT

  alice committed → 20 · bob committed → 50
  accounts: [{"id":1,"balance":20}]
  serial alice → bob: accounts: [{"id":1,"balance":20}] · alice committed → 20 · bob failed: insufficient funds
  serial bob → alice: accounts: [{"id":1,"balance":50}] · bob committed → 50 · alice failed: insufficient funds
```

Both withdrawals succeeded, but only one of them shows up in the balance.

### In your test suite

```js
import { test } from 'node:test';            // or vitest / jest
import { assertSafe } from 'sqlloom';
import transfer from './scenarios/transfer.mjs';

test('transfers are safe at the isolation level we run in production', async () => {
  await assertSafe({ ...transfer, level: 'read committed' });   // throws with the timeline if not
});
```

### Is your retry loop enough?

At repeatable read and serializable, Postgres prevents some anomalies by aborting a transaction with `40001`, and your app is expected to retry it. `--retries 2` (or `{ retries: 2 }`) models that loop: an aborted transaction starts again inside the same schedule and sees whatever the others committed.

```
$ npx sqlloom examples/on-call.mjs --retries 2

  isolation level   schedules       result
  read committed    20 (all)        ✗ UNSAFE  18 of 20 break the invariant ◂ yours
  repeatable read   20 (all)        ✗ UNSAFE  18 of 20 break the invariant
  serializable      20 (all)        ✓ safe    18 of 20 needed a retry
```

With retries, serializable is fully safe: the retried doctor sees that the other one already left and refuses. Retries can't save repeatable read here, because nothing gets aborted.

## What it catches

All of these are in [`examples/`](examples). Run them all with `npm run examples`.

| Scenario | read committed | repeatable read | serializable |
|---|---|---|---|
| [withdraw](examples/withdraw.mjs): read balance, check, write it back | ✗ lost update | ✓ retry | ✓ retry |
| [withdraw-for-update](examples/withdraw-for-update.mjs): the same with `SELECT … FOR UPDATE` | ✓ | ✓ retry | ✓ retry |
| [on-call](examples/on-call.mjs): "at least one doctor on call" (write skew) | ✗ | ✗ | ✓ retry |
| [signup](examples/signup.mjs): check-then-insert username, no `UNIQUE` | ✗ duplicate | ✗ duplicate | ✓ retry |

**✓ retry** means the level is safe, but Postgres will abort one of the transactions in some interleavings (`40001` serialization failure or `40P01` deadlock), so your code has to retry it. sqlloom counts how often that happens.

## How it works

1. **One connection per transaction.** Each schedule starts from a fresh schema built by your `setup`. Every transaction gets its own connection and its own `BEGIN ISOLATION LEVEL …`.
2. **You write code, sqlloom holds the queries.** When a transaction calls `db.query`, the query is parked, not sent. sqlloom picks one parked transaction, sends its query, and waits for the answer. The first schedule picks in declaration order, which runs the transactions one after another.
3. **Lock waits are real.** If a query blocks on a lock, sqlloom sees it in `pg_stat_activity`, records who it is waiting for (`⏳ waits for alice`), and carries on with the other transactions. Deadlocks are detected by Postgres itself. sqlloom lowers `deadlock_timeout` for its own sessions when it's allowed to.
4. **Every interleaving.** The choices form a tree, and sqlloom walks all of it depth-first (`20 (all)` in the report). If the tree is bigger than `--max`, the report says `sampled` instead.
5. **Two checks per schedule.** Your invariant runs, and the final state plus the return values are compared against every serial order.
6. **Shortest story.** Of all the failing schedules, the report shows the one with the fewest context switches, plus a `replay` token that re-runs exactly that interleaving.
7. **Fast enough to keep in CI.** Schedules run in parallel, each in its own schema with its own connections, and `synchronous_commit` is off for these throwaway sessions. Two-transaction scenarios take well under a second, and three transactions with 600+ interleavings take about 5 s.

## CLI

```
sqlloom <scenario.mjs> [--url <url>] [--level rc|rr|serializable] [--levels rc,rr,serializable] [--max <n>] [--json]
```

| | |
|---|---|
| `--url` | Postgres URL. Default: `$SQLLOOM_URL`, then `$DATABASE_URL` |
| `--level` | The isolation level your app runs at (marked `◂ yours`). The exit code is `1` if it is unsafe |
| `--levels` | Which levels to test (default: all three) |
| `--max` | Max schedules per level (default 5000) |
| `--retries` | Re-run transactions that Postgres aborted (`40001`/`40P01`) up to n times, like your app's retry loop |
| `--json` | Machine-readable report |

## API

```ts
import { check, assertSafe, formatReport } from 'sqlloom';

const report = await check({
  url,                     // default $SQLLOOM_URL / $DATABASE_URL
  setup,                   // SQL string, or async (db) => { ... }
  transactions,            // { name: async (db) => result, ... }  — 2 or more
  invariant,               // optional: async (db) => { throw / return false if broken }
  levels,                  // default ['read committed', 'repeatable read', 'serializable']
  level,                   // your production level (used by assertSafe, marked in the report)
  maxSchedules,            // default 5000 per level
  serializable,            // compare with serial executions (default true)
  snapshot,                // custom "final state" for that comparison (default: all tables)
  retries,                 // re-run aborted (40001/40P01) transactions up to n times (default 0)
  parallel,                // worker schemas (default min(4, CPUs))
  replay,                  // run exactly one schedule from a report's replay token
});
console.log(formatReport(report, { color: true }));
```

`db.query(sql, params)` returns the rows array, with `.rowCount` and `.command` attached. Full types are in [`src/index.d.ts`](src/index.d.ts).

## Caveats

- **Point it at a disposable database.** sqlloom creates and drops its own `sqlloom_*` schemas and never touches anything else. Your `setup` SQL is still yours, though, so a test database is the right place for it.
- **Granularity is one statement.** sqlloom interleaves whole statements. Races *inside* a single statement are left to Postgres. That matches how your app talks to the database.
- **Keep it deterministic.** `now()`, `random()`, and sequences that skip values when a transaction aborts can make a state differ from every serial run. If you use them, pass a `snapshot` that leaves them out (for example, select the business columns only).
- **2–3 transactions with a handful of queries each.** The number of interleavings grows quickly. That's where these bugs live anyway.

## Roadmap

- [ ] Plain `.sql` scenario files for transactions without app logic
- [ ] MySQL / MariaDB
- [x] Retry loops as part of the scenario (`--retries`)
- [ ] Partial-order reduction to skip interleavings that can't differ
- [ ] Python API

## See also

[raceloom](https://github.com/Anime5hka/raceloom) does the same kind of search for async JavaScript and Python code, using fakes instead of a database.

## License

[MIT](LICENSE)
