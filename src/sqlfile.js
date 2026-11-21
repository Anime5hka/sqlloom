// Plain-SQL scenarios:
//
//   -- setup
//   CREATE TABLE ...;
//   -- transaction alice
//   UPDATE ...;
//   -- transaction bob
//   UPDATE ...;
//   -- invariant
//   SELECT balance >= 0 FROM accounts;      -- every row of every query must be true
//
// One statement per `;` at the end of a line. Dollar-quoted bodies are not supported.

const HEADER = /^--\s*(setup|invariant|(?:transaction|tx)\s+(.+?))\s*$/i;

export function splitStatements(sql) {
  const out = [];
  let cur = [];
  for (const line of sql.split('\n')) {
    if (!cur.length && (/^\s*--/.test(line) || !line.trim())) continue;
    cur.push(line);
    if (/;\s*(--.*)?$/.test(line)) {
      out.push(cur.join('\n').trim().replace(/;\s*(--.*)?$/, '').trim());
      cur = [];
    }
  }
  const rest = cur.join('\n').trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

export function parseSqlScenario(text) {
  const sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    const m = line.trim().match(HEADER);
    if (m) {
      current = { kind: m[2] ? 'tx' : m[1].toLowerCase(), name: m[2]?.trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim() && !line.trim().startsWith('--')) {
      throw new Error('sqlloom: SQL before the first section; start with "-- setup" or "-- transaction <name>"');
    }
  }
  const transactions = {};
  const invariants = [];
  let setup = '';
  for (const s of sections) {
    const body = s.lines.join('\n');
    if (s.kind === 'setup') setup += `${body}\n`;
    else if (s.kind === 'invariant') invariants.push(...splitStatements(body));
    else {
      if (transactions[s.name]) throw new Error(`sqlloom: transaction "${s.name}" is defined twice`);
      const statements = splitStatements(body);
      transactions[s.name] = async (db) => {
        for (const st of statements) await db.query(st);
      };
    }
  }
  const scenario = { setup, transactions };
  if (invariants.length) {
    scenario.invariant = async (db) => {
      for (const q of invariants) {
        const rows = await db.query(q);
        for (const row of rows) {
          const v = Object.values(row)[0];
          if (v !== true) throw new Error(`${q} → ${JSON.stringify(v)}`);
        }
      }
    };
  }
  return scenario;
}
