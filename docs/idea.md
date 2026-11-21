# sqlloom

## Problem Statement
How might we let a backend developer find out, in one command, whether two copies of their transaction code can corrupt data — and which isolation level or lock fixes it?

## Recommended Direction
A Node library + CLI. You give it a setup SQL, 2–3 transaction functions written against a tiny `db.query()` API (so app logic between queries — `if (balance >= 80)` — is part of the test), and an invariant. sqlloom runs every interleaving of the queries on a real Postgres, once per isolation level (READ COMMITTED, REPEATABLE READ, SERIALIZABLE), handling lock waits, serialization failures and deadlocks, and prints a matrix: which levels break the invariant, which abort (needs retry), which are safe — plus the shortest failing interleaving as a timeline.

Same brand and output style as raceloom (cross-promotion), but a different audience (backend/SQL devs) and a real database, not fakes.

## Key Assumptions to Validate
- [ ] Lock waits can be detected deterministically via pg_stat_activity (wait_event_type = 'Lock') — spike first.
- [ ] Per-run reset (fresh schema + setup) is fast enough: target < 30 ms/run, so 2×4 queries × 3 levels (~210 runs) < 10 s.
- [ ] Devs will run a Postgres via docker for this (one `docker run` line in README; `--url` for existing DB).

## MVP Scope
In: Postgres only; JS API `check({ setup, txs, invariant, levels })`; DFS enumeration over query-send choices; blocked/aborted/deadlock handling; matrix + timeline output; 3 classic examples (lost update on withdraw, check-then-insert duplicate username, write skew on-call doctors); CLI `sqlloom run file.mjs`; tests against docker Postgres.
Out (later): pure-.sql file format, MySQL, Python API, random sampling for large spaces, `FOR UPDATE` fix suggestions.

## Not Doing (and Why)
- Black-box history checking (Elle style) — isocheck does it; we enumerate instead.
- Fake/in-memory SQL engine — the point is the real database's semantics.
- MySQL/SQLite in v0.1 — SQLite has no concurrent writers; MySQL doubles the lock-detection work.

## Open Questions
- Statement-level timeout vs pg_stat_activity polling latency — measure in spike.
