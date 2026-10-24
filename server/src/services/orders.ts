import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { MAX_PER_SIZE, orderNo, type ApiAdminOrder, type ApiOrder, type CdekShipment, type CreateOrderBody } from '@mrak8/shared';
import type { DB } from '../db/index.js';
import { deliveryMethods, orderItems, orders, productImages, products, productSizes } from '../db/schema.js';
import { toApiImage } from './catalog.js';
import type { Storage } from './storage.js';

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

export class OrderError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'OrderError';
  }
}

export const CreateOrderSchema = z.object({
  items: z
    .array(z.object({ productId: z.number().int().positive(), size: z.string().min(1).max(8), qty: z.number().int().min(1).max(10) }))
    .min(1)
    .max(20),
  protocol: z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().refine((p) => /^\+?\d{10,15}$/.test(p.replace(/[\s()-]/g, '')), 'phone'),
    delivery: z.string().min(1).max(32),
    address: z.string().trim().max(400).optional().default(''),
    comment: z.string().trim().max(400).optional().default(''),
    cdek: z.object({ cityCode: z.number().int().positive(), city: z.string().trim().min(2).max(160), mode: z.enum(['pvz', 'door']), pvzCode: z.string().trim().max(40).optional() }).optional(),
  }),
});

const digits = (p: string) => p.replace(/\D/g, '');

/** releases the stock held by a pending order. Idempotent: only the first caller flips the status. */
async function releaseOrder(tx: Tx, orderId: number, to: 'cancelled' | 'expired'): Promise<boolean> {
  const done = await tx
    .update(orders)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'pending')))
    .returning({ id: orders.id });
  if (!done.length) return false;
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  for (const it of items) {
    await tx.update(productSizes).set({ reserved: sql`GREATEST(${productSizes.reserved} - ${it.qty}, 0)` }).where(eq(productSizes.id, it.sizeId));
  }
  return true;
}

/** atomically hold `qty` units; false if not enough left */
async function reserve(tx: Tx, sizeId: number, qty: number): Promise<boolean> {
  const r = await tx
    .update(productSizes)
    .set({ reserved: sql`${productSizes.reserved} + ${qty}` })
    .where(and(eq(productSizes.id, sizeId), sql`${productSizes.stock} - ${productSizes.reserved} >= ${qty}`))
    .returning({ id: productSizes.id });
  return r.length > 0;
}

export interface CreatedOrder { order: OrderRow; items: OrderItemRow[] }

/**
 * Prices and stock come from the DB only — the client sends ids, sizes and quantities.
 * Previous unpaid orders of the same subject are cancelled first, so one person never holds two reserves.
 */
/** a delivery priced outside the DB (a СДЭК quote, made by the route before the transaction) */
export interface PricedDelivery { title: string; price: number; address: string; cdek: CdekShipment }

export async function createOrder(db: DB, user: { id: number; subjectNo: string }, input: CreateOrderBody, reserveMinutes: number, priced?: PricedDelivery): Promise<CreatedOrder> {
  const body = CreateOrderSchema.parse(input);
  const merged = new Map<string, { productId: number; size: string; qty: number }>();
  for (const it of body.items) {
    const k = `${it.productId}:${it.size}`;
    const prev = merged.get(k);
    merged.set(k, { ...it, qty: (prev?.qty ?? 0) + it.qty });
  }
  const lines = [...merged.values()];
  // the per-line cap alone is bypassed by repeating a line — the limit applies to the merged quantity
  const over = lines.find((l) => l.qty > MAX_PER_SIZE);
  if (over) throw new OrderError('TOO_MANY', `Не больше ${MAX_PER_SIZE} шт. одного размера в одни руки`);

  return db.transaction(async (tx) => {
    // one subject's orders run one at a time, so «one pending order per subject» holds under concurrent requests
    await tx.execute(sql`select pg_advisory_xact_lock(${user.id})`);
    const [dv] = await tx.select().from(deliveryMethods).where(and(eq(deliveryMethods.key, body.protocol.delivery), eq(deliveryMethods.active, true)));
    if (!dv) throw new OrderError('BAD_DELIVERY', 'Способ этапирования недоступен');
    if (dv.needsAddress && !priced && body.protocol.address.length < 6) throw new OrderError('NO_ADDRESS', 'Укажите адрес доставки');

    const pending = await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.userId, user.id), eq(orders.status, 'pending')));
    for (const p of pending) await releaseOrder(tx, p.id, 'cancelled');

    const ids = [...new Set(lines.map((l) => l.productId))];
    const prods = await tx.select().from(products).where(inArray(products.id, ids));
    const sizes = await tx.select().from(productSizes).where(inArray(productSizes.productId, ids));
    const rows: Omit<typeof orderItems.$inferInsert, 'orderId'>[] = [];
    for (const l of lines) {
      const p = prods.find((x) => x.id === l.productId);
      if (!p || p.status !== 'live') throw new OrderError('NOT_FOR_SALE', `Вещдок ${p ? '#' + p.no : ''} не продаётся`.trim(), 409);
      const s = sizes.find((x) => x.productId === p.id && x.label === l.size);
      if (!s) throw new OrderError('NO_SIZE', `Размер ${l.size} не найден`, 409);
      if (!(await reserve(tx, s.id, l.qty))) throw new OrderError('OUT_OF_STOCK', `${p.title} / ${l.size} — изъят другим субъектом`, 409);
      rows.push({ productId: p.id, sizeId: s.id, sizeLabel: s.label, title: p.title, productNo: p.no, price: p.price, qty: l.qty });
    }
    const itemsTotal = rows.reduce((a, r) => a + r.price * r.qty, 0);
    const [order0] = await tx
      .insert(orders)
      .values({
        userId: user.id,
        subjectNo: user.subjectNo,
        payload: randomBytes(16).toString('hex'),
        name: body.protocol.name,
        phone: '+' + digits(body.protocol.phone).replace(/^8(\d{10})$/, '7$1'),
        deliveryKey: dv.key,
        deliveryTitle: priced?.title ?? dv.title,
        deliveryPrice: priced?.price ?? dv.price,
        address: priced?.address ?? (dv.needsAddress ? body.protocol.address : ''),
        cdek: priced?.cdek ?? null,
        comment: body.protocol.comment,
        itemsTotal,
        total: itemsTotal + (priced?.price ?? dv.price),
        reservedUntil: new Date(Date.now() + reserveMinutes * 60_000),
      })
      .returning();
    const [order] = await tx.update(orders).set({ no: orderNo(order0.id) }).where(eq(orders.id, order0.id)).returning();
    const items = await tx.insert(orderItems).values(rows.map((r) => ({ ...r, orderId: order.id }))).returning();
    return { order, items };
  });
}

export async function setInvoiceLink(db: DB, orderId: number, link: string) {
  await db.update(orders).set({ invoiceLink: link }).where(eq(orders.id, orderId));
}

export async function cancelOrder(db: DB, userId: number, no: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(and(eq(orders.no, no), eq(orders.userId, userId)));
    if (!o) return false;
    return releaseOrder(tx, o.id, 'cancelled');
  });
}

/** runs every minute: unpaid reserves older than RESERVE_MINUTES go back to stock */
export async function expireReservations(db: DB, now = new Date()): Promise<string[]> {
  const due = await db.select({ id: orders.id, no: orders.no }).from(orders).where(and(eq(orders.status, 'pending'), lt(orders.reservedUntil, now)));
  const out: string[] = [];
  for (const o of due) {
    const ok = await db.transaction((tx) => releaseOrder(tx, o.id, 'expired'));
    if (ok && o.no) out.push(o.no);
  }
  return out;
}

export type PreCheckoutResult = { ok: true; order: OrderRow } | { ok: false; error: string };

/** answer within 10 s: re-checks the reserve, the amount and the currency */
export async function preCheckout(db: DB, payload: string, totalAmount: number, currency: string, reserveMinutes: number): Promise<PreCheckoutResult> {
  return db.transaction(async (tx): Promise<PreCheckoutResult> => {
    const [o] = await tx.select().from(orders).where(eq(orders.payload, payload)).for('update');
    if (!o) return { ok: false, error: 'Дело не найдено. Оформите протокол заново.' };
    if (currency !== o.currency || totalAmount !== o.total * 100) return { ok: false, error: 'Сумма протокола изменилась. Оформите заново.' };
    if (o.status === 'paid' || o.telegramChargeId) return { ok: false, error: 'Это дело уже оформлено.' };
    if (o.status === 'pending') {
      // still holding stock — just make sure the reserve survives the payment
      await tx.update(orders).set({ reservedUntil: new Date(Date.now() + Math.max(5, reserveMinutes) * 60_000) }).where(eq(orders.id, o.id));
      return { ok: true, order: o };
    }
    if (o.status === 'expired') {
      // reserve ran out while the subject was typing a card number: try to grab the stock again
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id));
      for (const it of items) {
        if (!(await reserve(tx, it.sizeId, it.qty))) throw new OrderError('OUT_OF_STOCK', 'Резерв истёк: вещдок изъят другим субъектом.');
      }
      const [again] = await tx.update(orders).set({ status: 'pending', reservedUntil: new Date(Date.now() + reserveMinutes * 60_000), updatedAt: new Date() }).where(eq(orders.id, o.id)).returning();
      return { ok: true, order: again };
    }
    return { ok: false, error: 'Протокол отменён. Оформите заново.' };
  }).catch((e) => {
    if (e instanceof OrderError) return { ok: false as const, error: e.message };
    throw e;
  });
}

export interface PaidResult { order: OrderRow; items: OrderItemRow[]; already: boolean; oversold: boolean }

/** successful_payment: idempotent (telegram_payment_charge_id is unique, status flips once) */
export async function markPaid(db: DB, payload: string, charge: { telegram: string; provider: string; totalAmount: number }): Promise<PaidResult | null> {
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.payload, payload)).for('update');
    if (!o) return null;
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id));
    if (o.telegramChargeId || o.status === 'paid' || o.status === 'assembled' || o.status === 'shipped' || o.status === 'delivered') {
      return { order: o, items, already: true, oversold: false };
    }
    const held = o.status === 'pending';
    let oversold = false;
    for (const it of items) {
      if (held) {
        await tx.update(productSizes).set({ stock: sql`${productSizes.stock} - ${it.qty}`, reserved: sql`GREATEST(${productSizes.reserved} - ${it.qty}, 0)` }).where(eq(productSizes.id, it.sizeId));
      } else {
        // paid after the reserve was released (expired/cancelled race): take it from stock if it is still there
        const r = await tx
          .update(productSizes)
          .set({ stock: sql`${productSizes.stock} - ${it.qty}` })
          .where(and(eq(productSizes.id, it.sizeId), sql`${productSizes.stock} - ${productSizes.reserved} >= ${it.qty}`))
          .returning({ id: productSizes.id });
        if (!r.length) oversold = true;
      }
    }
    const [paid] = await tx
      .update(orders)
      .set({ status: 'paid', paidAt: new Date(), telegramChargeId: charge.telegram, providerChargeId: charge.provider, reservedUntil: null, updatedAt: new Date() })
      .where(eq(orders.id, o.id))
      .returning();
    return { order: paid, items, already: false, oversold };
  });
}

export async function findOrderByNo(db: DB, no: string) {
  const [o] = await db.select().from(orders).where(eq(orders.no, no));
  if (!o) return null;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, o.id));
  return { order: o, items };
}

async function imagesFor(db: DB, productIds: number[]) {
  if (!productIds.length) return [];
  return db.select().from(productImages).where(and(inArray(productImages.productId, productIds), eq(productImages.slot, 'front')));
}

export async function toApiOrders(db: DB, storage: Storage, list: OrderRow[]): Promise<ApiOrder[]> {
  if (!list.length) return [];
  const items = await db.select().from(orderItems).where(inArray(orderItems.orderId, list.map((o) => o.id)));
  const imgs = await imagesFor(db, [...new Set(items.map((i) => i.productId))]);
  return list.map((o) => ({
    no: o.no ?? '',
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    paidAt: o.paidAt ? o.paidAt.toISOString() : null,
    reservedUntil: o.reservedUntil ? o.reservedUntil.toISOString() : null,
    items: items
      .filter((i) => i.orderId === o.id)
      .map((i) => {
        const im = imgs.find((x) => x.productId === i.productId);
        return { productId: i.productId, no: i.productNo, title: i.title, size: i.sizeLabel, qty: i.qty, price: i.price, image: im ? toApiImage(im, storage) : null };
      }),
    delivery: { key: o.deliveryKey, title: o.deliveryTitle, price: o.deliveryPrice },
    itemsTotal: o.itemsTotal,
    total: o.total,
    name: o.name,
    trackNo: o.trackNo,
  }));
}

export async function listUserOrders(db: DB, storage: Storage, userId: number): Promise<ApiOrder[]> {
  const list = await db.select().from(orders).where(and(eq(orders.userId, userId), inArray(orders.status, ['paid', 'assembled', 'shipped', 'delivered', 'pending']))).orderBy(desc(orders.createdAt)).limit(50);
  return toApiOrders(db, storage, list);
}

export async function toAdminOrders(db: DB, storage: Storage, list: OrderRow[]): Promise<ApiAdminOrder[]> {
  const api = await toApiOrders(db, storage, list);
  return api.map((a, i) => ({ ...a, id: list[i].id, userId: list[i].userId, subjectNo: list[i].subjectNo, phone: list[i].phone, address: list[i].address, comment: list[i].comment, cdek: list[i].cdek ?? null }));
}
