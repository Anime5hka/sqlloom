// The fix: lock the row while reading it.
import withdraw from './withdraw.mjs';

export default {
  ...withdraw,
  transactions: { alice: withdrawLocked(80), bob: withdrawLocked(50) },
};

function withdrawLocked(amount) {
  return async (db) => {
    const [{ balance }] = await db.query('SELECT balance FROM accounts WHERE id = $1 FOR UPDATE', [1]);
    if (balance < amount) throw new Error('insufficient funds');
    await db.query('UPDATE accounts SET balance = $1 WHERE id = $2', [balance - amount, 1]);
    return balance - amount;
  };
}
