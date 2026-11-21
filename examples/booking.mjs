// Last seat, two customers: count, check capacity, insert. Inserts are phantoms to each other.
export default {
  setup: `
    CREATE TABLE shows (id int PRIMARY KEY, capacity int NOT NULL);
    CREATE TABLE bookings (show int NOT NULL, customer text NOT NULL);
    INSERT INTO shows VALUES (1, 10);
    INSERT INTO bookings SELECT 1, 'guest ' || i FROM generate_series(1, 9) i;
  `,
  transactions: {
    alice: book(1, 'alice'),
    bob: book(1, 'bob'),
  },
  invariant: async (db) => {
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM bookings WHERE show = 1');
    if (n > 10) throw new Error(`overbooked: ${n}/10`);
  },
};

function book(show, customer) {
  return async (db) => {
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM bookings WHERE show = $1', [show]);
    const [{ capacity }] = await db.query('SELECT capacity FROM shows WHERE id = $1', [show]);
    if (n >= capacity) throw new Error('sold out');               // app logic between queries
    await db.query('INSERT INTO bookings VALUES ($1, $2)', [show, customer]);
  };
}
