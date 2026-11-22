// Your real Drizzle code, unchanged: `checkout` is what would live in your app.
// sqlloom hands it a node-postgres look-alike (`db.pg`) whose queries it schedules.
//   npm i drizzle-orm && npx sqlloom examples/orm/drizzle-checkout.mjs
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

const products = pgTable('products', { id: integer().primaryKey(), stock: integer().notNull() });
const orders = pgTable('orders', { buyer: text().notNull(), productId: integer('product_id').notNull(), qty: integer().notNull() });

// ---- app code ----
export async function checkout(db, buyer, productId, qty) {
  return db.transaction(async (tx) => {
    const [product] = await tx.select().from(products).where(eq(products.id, productId));
    if (product.stock < qty) throw new Error('out of stock');
    await tx.update(products).set({ stock: product.stock - qty }).where(eq(products.id, productId));
    await tx.insert(orders).values({ buyer, productId, qty });
  });
}
// ------------------

export default {
  setup: `
    CREATE TABLE products (id int PRIMARY KEY, stock int NOT NULL);
    CREATE TABLE orders (buyer text NOT NULL, product_id int NOT NULL, qty int NOT NULL);
    INSERT INTO products VALUES (1, 1);
  `,
  transactions: {
    alice: (db) => checkout(drizzle(db.pg), 'alice', 1, 1),
    bob: (db) => checkout(drizzle(db.pg), 'bob', 1, 1),
  },
  invariant: async (db) => {
    const [{ sold }] = await db.query('SELECT coalesce(sum(qty), 0)::int AS sold FROM orders');
    if (sold > 1) throw new Error(`sold ${sold} items, had 1 in stock`);
  },
};

export { products, orders };
