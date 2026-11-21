import pg from 'pg';

export const url = process.env.SQLLOOM_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('\nTests need a Postgres. Start one with:\n  docker run -d --name sqlloom-pg -e POSTGRES_PASSWORD=sqlloom -p 54329:5432 postgres:17-alpine\nthen: SQLLOOM_URL=postgres://postgres:sqlloom@localhost:54329/postgres npm test\n');
  process.exit(1);
}

export function level(report, name) {
  return report.levels.find((l) => l.level === name);
}

export async function leftoverSchemas() {
  const c = new pg.Client(url);
  await c.connect();
  const { rows } = await c.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'sqlloom\\_%'");
  await c.end();
  return rows.map((r) => r.nspname);
}
