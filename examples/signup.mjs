// Check-then-insert without a UNIQUE constraint: two signups grab the same username.
export default {
  setup: 'CREATE TABLE users (id int PRIMARY KEY, username text NOT NULL)',
  transactions: {
    'signup 1': signup(1, 'ada'),
    'signup 2': signup(2, 'ada'),
  },
  invariant: async (db) => {
    const dupes = await db.query('SELECT username FROM users GROUP BY username HAVING count(*) > 1');
    if (dupes.length) throw new Error(`duplicate username "${dupes[0].username}"`);
  },
};

function signup(id, username) {
  return async (db) => {
    const taken = await db.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (taken.length) throw new Error('username taken');
    await db.query('INSERT INTO users VALUES ($1, $2)', [id, username]);
  };
}
