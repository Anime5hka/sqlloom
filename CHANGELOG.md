# Changelog

## 0.3.0

- **Prisma 7**: `new PrismaPg(db.pg, { schema: db.schema })` runs your `$transaction` code. `db.pg` now passes `instanceof pg.Pool`; `db.schema` is the run's private schema; Prisma's `P2034` counts as a retryable abort.
- `SET TRANSACTION ISOLATION LEVEL` sent by the app is ignored, so it can't replace the level under test.
- The run's schema name is hidden in timelines.

## 0.2.0

- **Your ORM code, unchanged.** `db.pg` is a node-postgres `Client`/`Pool` look-alike: `drizzle(db.pg)`, `new PostgresDialect({ pool: db.pg })`. BEGIN/COMMIT/ROLLBACK sent by the ORM's own `transaction()` are answered by sqlloom; savepoints go to Postgres. Tested with Drizzle and Kysely.
- Errors wrapped by an ORM (`cause` chain) are still recognised as `40001`/`40P01` aborts.
- Warning when a transaction fails even when it runs alone (a broken scenario used to look "safe").
- Fix: a transaction that fired two queries at once could hang the scheduler.

## 0.1.0

First release.

- `check(scenario)`: runs every interleaving of 2+ transactions on a real Postgres, at read committed, repeatable read and serializable.
- Transactions are plain async functions, so app logic between queries is part of the test.
- Two checks per schedule: your invariant, and equivalence with some serial order of the transactions (catches lost updates with no invariant at all).
- Lock waits detected through `pg_stat_activity` and shown in the timeline (`⏳ waits for alice`); deadlocks and serialization failures reported as "retry".
- Plain `.sql` scenarios (`-- setup`, `-- transaction <name>`, `-- invariant`).
- `retries`: re-run transactions Postgres aborted, to check your retry loop.
- Shortest failing interleaving (fewest context switches) with a `replay` token.
- Parallel exploration in separate schemas; `assertSafe()` for test suites; CLI `sqlloom <scenario.mjs>` with exit code 1 if your isolation level is unsafe; `--json`.
- TypeScript types. Tested on Postgres 12 and 17.
