// Two withdrawals from the same account: read the balance, check it in app code, write it back.
export default {
  setup: `
    CREATE TABLE accounts (id int PRIMARY KEY, balance int NOT NULL);
    INSERT INTO accounts VALUES (1, 100);
  `,
  transactions: {
    alice: withdraw(80),
    bob: withdraw(50),
  },
  invariant: async (db) => {
    const [{ balance }] = await db.query('SELECT balance FROM accounts WHERE id = 1');
    if (balance < 0) throw new Error(`balance is ${balance}`);
  },
};

function withdraw(amount) {
  return async (db) => {
    const [{ balance }] = await db.query('SELECT balance FROM accounts WHERE id = $1', [1]);
    if (balance < amount) throw new Error('insufficient funds');
    await db.query('UPDATE accounts SET balance = $1 WHERE id = $2', [balance - amount, 1]);
    return balance - amount;
  };
}
