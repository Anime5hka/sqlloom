---
name: sqlloom
description: Check whether database transaction code is safe under concurrency by running every interleaving of its queries on a real Postgres with sqlloom. Use when code reads then writes the same rows in a transaction (balances, inventory, counters, seat booking, "at most N", unique-ish checks done in app code), when choosing between READ COMMITTED / REPEATABLE READ / SERIALIZABLE / SELECT FOR UPDATE, when writing a retry loop for serialization failures (40001), or when a data-corruption bug only happens under load.
---

# Checking transactions with sqlloom

sqlloom runs 2–3 transactions on separate connections to a real Postgres and tries every order in which their queries can reach the database, once per isolation level. It reports which levels are unsafe, which are safe if aborted transactions are retried, and the shortest interleaving that breaks. It also flags any result that no serial order could produce, so a lost update is found even without an invariant.

## Setup

```sh
docker run -d --name sqlloom-pg -e POSTGRES_PASSWORD=sqlloom -p 54329:5432 postgres:17-alpine
export SQLLOOM_URL=postgres://postgres:sqlloom@localhost:54329/postgres
npm install --save-dev github:Anime5hka/sqlloom
```

Never point `SQLLOOM_URL` at a production database. sqlloom only creates and drops its own `sqlloom_*` schemas, but the scenario's setup SQL runs there.

## Workflow

1. **Extract the transaction.** Copy the real queries *and the app logic between them* into an async function `(db) => { ... }` that uses `await db.query(sql, params)`, which returns the rows array. Keep the same statements, `FOR UPDATE` clauses and conditions. If the app uses Prisma 7, Drizzle, Kysely or anything else built on node-postgres, call the app's real function instead: pass it `new PrismaClient({ adapter: new PrismaPg(db.pg, { schema: db.schema }) })`, `drizzle(db.pg)` `new Kysely({ dialect: new PostgresDialect({ pool: db.pg }) })` or `knex({ client: 'pg', connectionPool: db.pg, version: '17' })`. The ORM's own `db.transaction(...)` is fine; sqlloom answers its BEGIN/COMMIT itself. For other ORMs, write the SQL the ORM emits.
2. **Minimal setup.** Write only the tables and rows the transactions touch (`CREATE TABLE …; INSERT …`). Use the real constraints (`UNIQUE`, `CHECK`, foreign keys), because they change the answer.
3. **Pick the racing pair.** Usually two copies of the same operation (two withdrawals, two bookings), or the operation plus the one that conflicts with it. Three at most.
4. **Invariant (optional but sharp).** Throw if the business rule is broken: `balance >= 0`, `seats_taken <= capacity`, `count(*) per username = 1`. Write invariants that still hold when Postgres legitimately aborts one transaction.
5. **Run** `npx --no sqlloom scenario.mjs --level <the level the app uses>`. Add `--retries 2` if the app retries on 40001/40P01.
6. **Read the matrix.** `✗ UNSAFE` means the bug is real at that level, and the timeline shows how. `✓ safe … abort` means it's safe only if the app retries. `✓ safe` means safe as written. `(all)` means every interleaving was run, so this is a proof for this scenario. `(sampled)` means the budget ran out.
7. **Fix and re-run.** Typical fixes, from least to most invasive: make the check and the write one statement (`UPDATE … WHERE balance >= $1`), add a constraint, `SELECT … FOR UPDATE`, or raise the level to SERIALIZABLE and add a retry loop. Re-run until your level says safe, and keep the scenario as a test with `assertSafe`.

## Scenario template (`scenario.mjs`)

```js
export default {
  setup: `
    CREATE TABLE shows (id int PRIMARY KEY, capacity int NOT NULL);
    CREATE TABLE bookings (show int NOT NULL, customer text NOT NULL);
    INSERT INTO shows VALUES (1, 10);
    INSERT INTO bookings SELECT 1, 'guest ' || i FROM generate_series(1, 9) i;
  `,
  transactions: {
    alice: book(1, 'alice'),
    bob: book(1, 'bob'),
  },
  invariant: async (db) => {
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM bookings WHERE show = 1');
    if (n > 10) throw new Error(`overbooked: ${n}/10`);
  },
};

function book(show, customer) {
  return async (db) => {
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM bookings WHERE show = $1', [show]);
    const [{ capacity }] = await db.query('SELECT capacity FROM shows WHERE id = $1', [show]);
    if (n >= capacity) throw new Error('sold out');               // app logic between queries
    await db.query('INSERT INTO bookings VALUES ($1, $2)', [show, customer]);
  };
}
```

A transaction that throws is rolled back, which is the right way to model "the app refused". Its return value is compared with the serial runs, so return what the app would show the user.

Pure-SQL transactions with no logic in between can go in a `.sql` file instead. Its sections are `-- setup`, `-- transaction <name>` and `-- invariant`, and every row of every invariant query must be `true`.

## In a test suite

```js
import { assertSafe } from 'sqlloom';
await assertSafe({ ...scenario, level: 'read committed' });   // throws UnsafeError with the timeline
```

## Reporting back

Show the matrix and the shortest timeline verbatim. Then explain the timeline in the user's domain ("both requests read 9 seats taken before either wrote, so both booked the last seat"), and propose the smallest fix together with the sqlloom result *after* the fix. If a level is safe only with retries, say so explicitly, and check that the app actually retries on 40001/40P01.

## Pitfalls

- `now()`, `random()` or sequence-generated ids can make results differ from every serial run even when the logic is fine. Pass `snapshot: (db) => db.query('SELECT <business columns> …')` to compare only what matters.
- An invariant like "n = 2" fails whenever Postgres aborts one transaction. Count what actually committed instead.
- If the report starts with `⚠ <name> fails even when it runs alone`, the scenario is broken (typo, missing table, wrong column name). Fix that first; the matrix is meaningless until then.
- Each `db.query` must be awaited before the next one in the same transaction.
