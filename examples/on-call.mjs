// Write skew: at least one doctor must stay on call. Both check, both see two, both leave.
export default {
  setup: `
    CREATE TABLE doctors (name text PRIMARY KEY, on_call boolean NOT NULL);
    INSERT INTO doctors VALUES ('alice', true), ('bob', true);
  `,
  transactions: {
    alice: goOffCall('alice'),
    bob: goOffCall('bob'),
  },
  invariant: async (db) => {
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM doctors WHERE on_call');
    if (n === 0) throw new Error('nobody is on call');
  },
};

function goOffCall(name) {
  return async (db) => {
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM doctors WHERE on_call');
    if (n < 2) throw new Error('you are the last one on call');
    await db.query('UPDATE doctors SET on_call = false WHERE name = $1', [name]);
  };
}
