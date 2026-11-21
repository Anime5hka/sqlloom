#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { check, formatReport } from '../src/index.js';
import { normalizeLevel } from '../src/check.js';

const HELP = `sqlloom — run every interleaving of your SQL transactions on a real Postgres

Usage: sqlloom <scenario.mjs> [options]

  --url <url>          Postgres URL (default: $SQLLOOM_URL or $DATABASE_URL)
  --level <level>      The isolation level your app runs at (default: read committed).
                       Exit code is 1 if this level is unsafe.
  --levels <list>      Levels to test, comma-separated: rc,rr,serializable (default: all)
  --max <n>            Max schedules per level (default: 2000)
  --json               Print the report as JSON
  --no-color
  -h, --help

A scenario module default-exports { setup, transactions, invariant? }. See README.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    level: { type: 'string' },
    levels: { type: 'string' },
    max: { type: 'string' },
    json: { type: 'boolean' },
    'no-color': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length !== 1) {
  console.log(HELP);
  process.exit(values.help ? 0 : 2);
}

try {
  const mod = await import(pathToFileURL(resolve(positionals[0])).href);
  const scenario = mod.default ?? mod;
  const level = normalizeLevel(values.level ?? scenario.level ?? 'read committed');
  const report = await check({
    ...scenario,
    url: values.url ?? scenario.url,
    level,
    levels: values.levels ? values.levels.split(',') : scenario.levels,
    maxSchedules: values.max ? Number(values.max) : scenario.maxSchedules,
  });
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const color = !values['no-color'] && !!process.stdout.isTTY && !process.env.NO_COLOR;
    console.log(formatReport(report, { color }));
  }
  const mine = report.levels.find((l) => l.level === level);
  // exitCode, not exit(): exit() can cut off a large report written to a pipe.
  process.exitCode = mine && mine.verdict === 'unsafe' ? 1 : 0;
} catch (e) {
  console.error(`sqlloom: ${e.message.replace(/^sqlloom: /, '')}`);
  process.exitCode = 2;
}
