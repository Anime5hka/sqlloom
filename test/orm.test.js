import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { check, formatReport } from '../src/index.js';
import { url, level } from './helpers.js';
import scenario, { products, orders } from '../examples/orm/drizzle-checkout.mjs';

test('Drizzle: the real db.transaction() code oversells at read committed', async () => {
  const r = await check({ url, ...scenario });
  assert.deepEqual(r.warnings, []);
  assert.equal(level(r, 'read committed').verdict, 'unsafe');
  assert.equal(level(r, 'read committed').worst.problem.message, 'sold 2 items, had 1 in stock');
  // The ORM wraps the 40001 in its own error: still recognised as a retryable abort.
  assert.equal(level(r, 'repeatable read').verdict, 'retry');
});

test('Drizzle: .for("update") makes it safe at read committed', async () => {
  const checkout = (db, buyer) => db.transaction(async (tx) => {
    const [p] = await tx.select().from(products).where(eq(products.id, 1)).for('update');
    if (p.stock < 1) throw new Error('out of stock');
    await tx.update(products).set({ stock: p.stock - 1 }).where(eq(products.id, 1));
    await tx.insert(orders).values({ buyer, productId: 1, qty: 1 });
  });
  const r = await check({
    url,
    ...scenario,
    levels: ['rc'],
    transactions: { alice: (db) => checkout(drizzle(db.pg), 'alice'), bob: (db) => checkout(drizzle(db.pg), 'bob') },
  });
  assert.equal(level(r, 'read committed').verdict, 'safe', formatReport(r));
});

test('Kysely: pool-shaped db.pg, retries see through to the pg error', async () => {
  const withdraw = (amount) => async (db) => {
    const k = new Kysely({ dialect: new PostgresDialect({ pool: db.pg }) });
    return k.transaction().execute(async (trx) => {
      const { balance } = await trx.selectFrom('accounts').select('balance').where('id', '=', 1).executeTakeFirstOrThrow();
      if (balance < amount) throw new Error('insufficient funds');
      await trx.updateTable('accounts').set({ balance: balance - amount }).where('id', '=', 1).execute();
      return balance - amount;
    });
  };
  const r = await check({
    url,
    setup: 'CREATE TABLE accounts (id int PRIMARY KEY, balance int NOT NULL); INSERT INTO accounts VALUES (1, 100);',
    transactions: { alice: withdraw(80), bob: withdraw(50) },
    levels: ['rc', 'rr'],
    retries: 1,
  });
  assert.deepEqual(r.warnings, []);
  assert.equal(level(r, 'read committed').verdict, 'unsafe');
  assert.equal(level(r, 'read committed').worst.problem.kind, 'anomaly');
  // With the retry loop modelled, every aborted withdrawal succeeds on its second attempt.
  assert.equal(level(r, 'repeatable read').verdict, 'safe');
  assert.ok(level(r, 'repeatable read').retried > 0);
  // ORM-issued BEGIN/COMMIT are answered locally, never shown as steps.
  assert.ok(level(r, 'read committed').worst.trace.every((s) => !/^(begin|commit)$/i.test(s.op) || s.op === 'COMMIT'));
});

test('a level requested by the app code does not override the level under test', async () => {
  const withdraw = (amount, requested) => async (db) => {
    const k = new Kysely({ dialect: new PostgresDialect({ pool: db.pg }) });
    return k.transaction().setIsolationLevel(requested).execute(async (trx) => {
      await sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`.execute(trx); // Prisma's way
      const { balance } = await trx.selectFrom('accounts').select('balance').where('id', '=', 1).executeTakeFirstOrThrow();
      if (balance < amount) throw new Error('insufficient funds');
      await trx.updateTable('accounts').set({ balance: balance - amount }).where('id', '=', 1).execute();
    });
  };
  const r = await check({
    url,
    setup: 'CREATE TABLE accounts (id int PRIMARY KEY, balance int NOT NULL); INSERT INTO accounts VALUES (1, 100);',
    transactions: { alice: withdraw(80, 'serializable'), bob: withdraw(50, 'serializable') },
    levels: ['rc'],
  });
  assert.equal(level(r, 'read committed').verdict, 'unsafe');
});

test('ROLLBACK from the transaction code rolls back; savepoints go to Postgres', async () => {
  const r = await check({
    url,
    setup: 'CREATE TABLE t (id int PRIMARY KEY, v int); INSERT INTO t VALUES (1, 0);',
    transactions: {
      a: async (db) => {
        await db.pg.query('SAVEPOINT s1');
        await db.pg.query('UPDATE t SET v = v + 1 WHERE id = 1');
        await db.pg.query('ROLLBACK TO SAVEPOINT s1');
        await db.pg.query('UPDATE t SET v = v + 5 WHERE id = 1');
      },
      b: async (db) => {
        await db.pg.query('UPDATE t SET v = v + 10 WHERE id = 1');
        await db.pg.query('ROLLBACK');
      },
    },
    levels: ['rc'],
    replay: '0.0.0.0.0',
  });
  const run = r.levels[0].replayed;
  assert.equal(run.trace.filter((s) => s.op === 'ROLLBACK TO SAVEPOINT s1').length, 1);
  assert.equal(run.outcomes.a.kind, 'committed');
  assert.equal(run.outcomes.b.kind, 'failed');
  assert.equal(run.outcomes.b.error.message, 'the transaction code sent ROLLBACK');
  assert.deepEqual(run.state.t, [{ id: 1, v: 5 }]);
});

test('a broken scenario is reported instead of looking safe', async () => {
  const r = await check({
    url,
    setup: 'CREATE TABLE t (id int)',
    transactions: { a: async (db) => db.query('SELECT nope FROM t'), b: async (db) => db.query('SELECT 1') },
    levels: ['rc'],
  });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^a fails even when it runs alone: column "nope" does not exist \(42703\)/);
  assert.match(formatReport(r), /⚠ a fails even when it runs alone/);
});
