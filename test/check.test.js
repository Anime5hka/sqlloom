import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, assertSafe, UnsafeError, formatReport } from '../src/index.js';
import { url, level, leftoverSchemas } from './helpers.js';
import withdraw from '../examples/withdraw.mjs';
import withdrawForUpdate from '../examples/withdraw-for-update.mjs';
import onCall from '../examples/on-call.mjs';
import signup from '../examples/signup.mjs';

test('lost update: unsafe at read committed, needs retries above it', async () => {
  const r = await check({ url, ...withdraw });
  const rc = level(r, 'read committed');
  assert.equal(rc.verdict, 'unsafe');
  assert.equal(rc.complete, true);
  assert.ok(rc.anomalies > 0);
  assert.equal(rc.worst.problem.kind, 'anomaly');
  assert.equal(rc.worst.switches, 2);
  assert.equal(level(r, 'repeatable read').verdict, 'retry');
  assert.equal(level(r, 'serializable').verdict, 'retry');
});

test('SELECT ... FOR UPDATE makes the withdrawal safe at read committed', async () => {
  const r = await check({ url, ...withdrawForUpdate, levels: ['rc'] });
  assert.equal(level(r, 'read committed').verdict, 'safe');
  assert.equal(level(r, 'read committed').complete, true);
});

test('write skew: unsafe at read committed and repeatable read, safe at serializable', async () => {
  const r = await check({ url, ...onCall });
  assert.equal(level(r, 'read committed').verdict, 'unsafe');
  assert.equal(level(r, 'repeatable read').verdict, 'unsafe');
  assert.equal(level(r, 'repeatable read').worst.problem.message, 'nobody is on call');
  assert.equal(level(r, 'serializable').verdict, 'retry');
});

test('check-then-insert duplicates without a constraint', async () => {
  const r = await check({ url, ...signup, levels: ['rc', 'serializable'] });
  assert.equal(level(r, 'read committed').verdict, 'unsafe');
  assert.equal(level(r, 'serializable').verdict, 'retry');
});

test('a UNIQUE constraint fixes it: the loser fails, which matches a serial order', async () => {
  const r = await check({
    url,
    ...signup,
    setup: 'CREATE TABLE users (id int PRIMARY KEY, username text NOT NULL UNIQUE)',
    levels: ['rc'],
  });
  const rc = level(r, 'read committed');
  assert.equal(rc.verdict, 'safe', formatReport(r));
});

test('replay runs one interleaving; lock waits name the holder', async () => {
  const r = await check({
    url,
    setup: 'CREATE TABLE t (id int PRIMARY KEY, v int); INSERT INTO t VALUES (1, 0);',
    transactions: {
      a: async (db) => { await db.query('UPDATE t SET v = v + 1 WHERE id = 1'); },
      b: async (db) => { await db.query('UPDATE t SET v = v + 10 WHERE id = 1'); },
    },
    levels: ['rc'],
    replay: '0.1.0.0',
  });
  const rc = level(r, 'read committed');
  assert.equal(rc.schedules, 1);
  assert.equal(rc.verdict, 'safe');
  const t = rc.replayed.trace;
  assert.deepEqual(t.map((s) => [s.type, s.tx, s.op]), [
    ['send', 'a', 'UPDATE t SET v = v + 1 WHERE id = 1'],
    ['send', 'b', 'UPDATE t SET v = v + 10 WHERE id = 1'],
    ['send', 'a', 'COMMIT'],
    ['unblock', 'b', 'UPDATE t SET v = v + 10 WHERE id = 1'],
    ['send', 'b', 'COMMIT'],
  ]);
  assert.deepEqual(t[1].blockedBy, ['a']);
  assert.deepEqual(rc.replayed.state, { t: [{ id: 1, v: 11 }] });
});

test('deadlocks are detected and reported as retryable aborts', async () => {
  const r = await check({
    url,
    setup: 'CREATE TABLE t (id int PRIMARY KEY, v int); INSERT INTO t VALUES (1, 0), (2, 0);',
    transactions: {
      ab: async (db) => {
        await db.query('UPDATE t SET v = v + 1 WHERE id = 1');
        await db.query('UPDATE t SET v = v + 1 WHERE id = 2');
      },
      ba: async (db) => {
        await db.query('UPDATE t SET v = v + 1 WHERE id = 2');
        await db.query('UPDATE t SET v = v + 1 WHERE id = 1');
      },
    },
    levels: ['rc'],
  });
  const rc = level(r, 'read committed');
  assert.equal(rc.verdict, 'retry', formatReport(r));
  assert.ok(rc.aborts > 0);
});

test('three transactions', async () => {
  const r = await check({
    url,
    setup: 'CREATE TABLE c (id int PRIMARY KEY, n int); INSERT INTO c VALUES (1, 0);',
    transactions: Object.fromEntries(['x', 'y', 'z'].map((name) => [name, async (db) => {
      const [{ n }] = await db.query('SELECT n FROM c WHERE id = 1');
      await db.query('UPDATE c SET n = $1 WHERE id = 1', [n + 1]);
    }])),
    invariant: async (db) => {
      const [{ n }] = await db.query('SELECT n FROM c WHERE id = 1');
      if (n !== 3) throw new Error(`counter is ${n}, expected 3`);
    },
    levels: ['rc'],
  });
  const rc = level(r, 'read committed');
  assert.equal(rc.verdict, 'unsafe');
  assert.match(rc.worst.problem.message, /counter is [12]/);
});

test('sending two queries at once from one transaction is an error', async () => {
  const r = await check({
    url,
    setup: 'CREATE TABLE t (id int)',
    transactions: {
      a: async (db) => { await Promise.all([db.query('SELECT 1'), db.query('SELECT 2')]); },
      b: async (db) => { await db.query('SELECT 1'); },
    },
    levels: ['rc'],
    serializable: false,
  });
  const out = r.levels[0];
  assert.equal(out.verdict, 'safe');
  // a failed in every schedule because of the misuse; that is visible in its outcome.
  const r2 = await check({
    url,
    setup: 'CREATE TABLE t (id int)',
    transactions: {
      a: async (db) => { await Promise.all([db.query('SELECT 1'), db.query('SELECT 2')]); },
      b: async (db) => { await db.query('SELECT 1'); },
    },
    levels: ['rc'],
    serializable: false,
    invariant: () => false,
  });
  assert.match(r2.levels[0].worst.outcomes.a.error.message, /another one was still running/);
});

test('budget: stops early and reports a sample', async () => {
  const r = await check({ url, ...onCall, levels: ['rc'], maxSchedules: 3 });
  assert.equal(level(r, 'read committed').schedules, 3);
  assert.equal(level(r, 'read committed').complete, false);
});

test('assertSafe throws UnsafeError with the timeline', async () => {
  await assert.rejects(assertSafe({ url, ...onCall }), (e) => {
    assert.ok(e instanceof UnsafeError);
    assert.match(e.message, /nobody is on call/);
    assert.match(e.message, /│ UPDATE doctors/);
    return true;
  });
  await assertSafe({ url, ...onCall, level: 'serializable' });
});

test('setup can be a function, and errors in setup surface', async () => {
  const r = await check({
    url,
    setup: async (db) => { await db.query('CREATE TABLE t (v int)'); await db.query('INSERT INTO t VALUES ($1)', [5]); },
    transactions: {
      a: async (db) => (await db.query('SELECT v FROM t'))[0].v,
      b: async (db) => (await db.query('SELECT v FROM t'))[0].v,
    },
    levels: ['rc'],
  });
  assert.equal(r.levels[0].verdict, 'safe');
  await assert.rejects(check({ url, setup: 'CREATE TABL oops', transactions: { a: async () => {}, b: async () => {} } }), /syntax error/);
});

test('cleans up its schemas', async () => {
  assert.deepEqual(await leftoverSchemas(), []);
});

test('input validation', async () => {
  await assert.rejects(check({ url, transactions: { a: async () => {} } }), /at least two/);
  await assert.rejects(check({ url, levels: ['snapshot'], transactions: { a: async () => {}, b: async () => {} } }), /unknown isolation level/);
});
