import { check, assertSafe, formatReport, UnsafeError, type Scenario } from 'sqlloom';

const scenario: Scenario = {
  setup: 'CREATE TABLE t (id int PRIMARY KEY, v int)',
  transactions: {
    a: async (db) => {
      const rows = await db.query<{ v: number }>('SELECT v FROM t WHERE id = $1', [1]);
      const v: number = rows[0].v;
      return rows.rowCount ?? v;
    },
    b: async (db) => { await db.query('UPDATE t SET v = 1'); },
  },
  invariant: async (db) => (await db.query('SELECT 1')).length > 0,
};

const report = await check({ ...scenario, levels: ['rc', 'serializable'], level: 'rc' });
const verdict: 'unsafe' | 'retry' | 'safe' = report.levels[0].verdict;
console.log(formatReport(report, { color: true }), verdict, report.levels[0].worst?.trace[0].tx);
try { await assertSafe(scenario); } catch (e) { if (e instanceof UnsafeError) console.log(e.report.levels.length); }
