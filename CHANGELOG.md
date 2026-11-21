# Changelog

## 0.1.0

First release.

- `check(scenario)`: runs every interleaving of 2+ transactions on a real Postgres, at read committed, repeatable read and serializable.
- Transactions are plain async functions, so app logic between queries is part of the test.
- Two checks per schedule: your invariant, and equivalence with some serial order of the transactions (catches lost updates with no invariant at all).
- Lock waits detected through `pg_stat_activity` and shown in the timeline (`⏳ waits for alice`); deadlocks and serialization failures reported as "retry".
- Shortest failing interleaving (fewest context switches) with a `replay` token.
- Parallel exploration in separate schemas; `assertSafe()` for test suites; CLI `sqlloom <scenario.mjs>` with exit code 1 if your isolation level is unsafe; `--json`.
- TypeScript types. Tested on Postgres 12 and 17.
