// Your real Prisma code, unchanged. Run it with:
//   npx prisma generate --schema examples/orm/prisma/schema.prisma
//   npx sqlloom examples/orm/prisma/checkout.ts        (Node 22.18+ runs .ts directly)
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.ts';

// ---- app code ----
export async function checkout(prisma: PrismaClient, buyer: string, productId: number) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
    if (product.stock < 1) throw new Error('out of stock');
    await tx.product.update({ where: { id: productId }, data: { stock: product.stock - 1 } });
    await tx.order.create({ data: { buyer, productId } });
  });
}
// ------------------

// Prisma qualifies every table with a schema, so point it at the one sqlloom made for this run.
const prisma = (db: { pg: unknown; schema: string }) => new PrismaClient({ adapter: new PrismaPg(db.pg as any, { schema: db.schema }) });

export default {
  setup: `
    CREATE TABLE products (id int PRIMARY KEY, stock int NOT NULL);
    CREATE TABLE orders (id serial PRIMARY KEY, buyer text NOT NULL, product_id int NOT NULL);
    INSERT INTO products VALUES (1, 1);
  `,
  transactions: {
    alice: (db: any) => checkout(prisma(db), 'alice', 1),
    bob: (db: any) => checkout(prisma(db), 'bob', 1),
  },
  invariant: async (db: any) => {
    const [{ sold }] = await db.query('SELECT count(*)::int AS sold FROM orders');
    if (sold > 1) throw new Error(`sold ${sold} items, had 1 in stock`);
  },
  // serial ids differ between runs when a transaction aborts: compare business columns only
  snapshot: async (db: any) => ({
    products: [...await db.query('SELECT * FROM products')],
    orders: [...await db.query('SELECT buyer, product_id FROM orders ORDER BY buyer')],
  }),
};
