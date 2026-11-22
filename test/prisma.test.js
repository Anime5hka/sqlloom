import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { check } from '../src/index.js';
import { url, level } from './helpers.js';

// The generated Prisma 7 client is TypeScript, which Node runs directly from 22.18 on.
const generated = new URL('../examples/orm/prisma/generated/client.ts', import.meta.url);
const skip = !process.features.typescript ? 'needs a Node that runs .ts files (22.18+)'
  : !existsSync(generated) ? 'run `npx prisma generate --schema examples/orm/prisma/schema.prisma` first (npm test does)'
  : false;

test('Prisma: $transaction code via @prisma/adapter-pg, P2034 counts as a retryable abort', { skip }, async () => {
  const { default: scenario } = await import('../examples/orm/prisma/checkout.ts');
  const r = await check({ url, ...scenario, levels: ['rc', 'rr'] });
  assert.deepEqual(r.warnings, []);
  const rc = level(r, 'read committed');
  assert.equal(rc.verdict, 'unsafe');
  assert.equal(rc.worst.problem.message, 'sold 2 items, had 1 in stock');
  assert.ok(rc.worst.trace.every((s) => !s.op.includes('sqlloom_')), 'schema prefix is hidden');
  assert.equal(level(r, 'repeatable read').verdict, 'retry');
  const withRetry = await check({ url, ...scenario, levels: ['rr'], retries: 1 });
  assert.equal(level(withRetry, 'repeatable read').verdict, 'safe');
});
