import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseSqlScenario, check } from '../src/index.js';
import { splitStatements } from '../src/sqlfile.js';
import { url } from './helpers.js';

test('splitStatements: one statement per trailing semicolon, comments and multi-line', () => {
  assert.deepEqual(splitStatements(`
-- a comment
SELECT 1;
UPDATE t
   SET v = 2
 WHERE id = 1;   -- trailing comment
SELECT 'a;b' AS x;
SELECT 3`), ['SELECT 1', 'UPDATE t\n   SET v = 2\n WHERE id = 1', "SELECT 'a;b' AS x", 'SELECT 3']);
});

test('parseSqlScenario: sections, duplicate names and stray SQL', () => {
  const s = parseSqlScenario('-- setup\nCREATE TABLE t (v int);\n-- transaction a\nSELECT 1;\n-- tx b\nSELECT 2;\n-- invariant\nSELECT true;');
  assert.deepEqual(Object.keys(s.transactions), ['a', 'b']);
  assert.match(s.setup, /CREATE TABLE t/);
  assert.equal(typeof s.invariant, 'function');
  assert.throws(() => parseSqlScenario('SELECT 1;\n-- setup\n'), /before the first section/);
  assert.throws(() => parseSqlScenario('-- tx a\nSELECT 1;\n-- tx a\nSELECT 2;'), /defined twice/);
});

test('.sql examples give the textbook answers', async () => {
  const atomic = await check({ url, ...parseSqlScenario(readFileSync('examples/withdraw-atomic.sql', 'utf8')) });
  assert.deepEqual(atomic.levels.map((l) => l.verdict), ['safe', 'retry', 'retry']);
  const counter = await check({ url, ...parseSqlScenario(readFileSync('examples/counter.sql', 'utf8')) });
  assert.deepEqual(counter.levels.map((l) => l.verdict), ['unsafe', 'retry', 'retry']);
  assert.match(counter.levels[0].worst.problem.message, /→ false/);
});

test('CLI: exit codes and .sql files', () => {
  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ['bin/sqlloom.js', ...args], { encoding: 'utf8', env: { ...process.env, SQLLOOM_URL: url } }) };
    } catch (e) {
      return { code: e.status, out: e.stdout + e.stderr };
    }
  };
  assert.equal(run('examples/counter.sql', '--levels', 'rc').code, 1);
  assert.equal(run('examples/counter.sql', '--level', 'serializable', '--levels', 'serializable').code, 0);
  const json = run('examples/withdraw-atomic.sql', '--json', '--levels', 'rc');
  assert.equal(JSON.parse(json.out).levels[0].verdict, 'safe');
  assert.equal(run().code, 2);
  assert.equal(run('examples/nope.mjs').code, 2);
});
