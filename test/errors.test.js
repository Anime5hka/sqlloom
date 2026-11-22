import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbError, isRetryable } from '../src/errors.js';

// Found by rubberstamp (https://github.com/Anime5hka/rubberstamp): every other test still passed
// when dbError returned undefined.
test('dbError digs the Postgres error out of an ORM wrapper', () => {
  const pg = Object.assign(new Error('could not serialize access'), { code: '40001' });
  const drizzle = Object.assign(new Error('Failed query: update ...'), { cause: pg });
  assert.equal(dbError(drizzle), pg);
  assert.equal(dbError(pg), pg);
});

test('dbError skips Prisma codes and gives up on errors without a SQLSTATE', () => {
  const prisma = Object.assign(new Error('write conflict'), { code: 'P2034' });
  assert.equal(dbError(prisma), null);
  assert.equal(dbError(new Error('plain')), null);
  assert.equal(dbError(undefined), null);
  assert.equal(isRetryable(prisma), true);
});
