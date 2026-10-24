import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CATEGORIES, ORDER_STATUS_LABEL, ORDER_STATUSES, PRODUCT_STATUSES, type ApiAdminDashboard, type ApiAdminProductInput } from '@mrak8/shared';
import { InputFile } from 'grammy';
import type { AppCtx } from '../app.js';
import { announceProduct, notifyOrderUpdate } from '../bot/index.js';
import { deliveryMethods, dropWatchers, orderItems, orders, productImages, products, productSizes } from '../db/schema.js';
import { getAdminProduct, listDelivery, listProducts, toApiImage } from '../services/catalog.js';
import { processImage, type Crop } from '../services/media.js';
import { cancelOrder, OrderError, toAdminOrders } from '../services/orders.js';
import { registerShipment } from '../services/shipping.js';

const n = z.number().int().min(0).nullable();
const ProductInput = z.object({
  no: z.string().trim().regex(/^\d{3,4}$/, 'номер вещдока: 3–4 цифры'),
  slug: z.string().trim().regex(/^[a-z0-9-]{2,80}$/),
  title: z.string().trim().min(2).max(120),
  name: z.string().trim().max(60).default(''),
  sub: z.string().trim().max(80).default(''),
  category: z.enum(CATEGORIES),
  price: z.number().int().min(0).max(10_000_000),
  oldPrice: z.number().int().min(0).nullable().default(null),
  color: z.string().trim().max(40).default(''),
  batch: z.string().trim().max(20).default(''),
  status: z.enum(PRODUCT_STATUSES),
  dropAt: z.string().datetime({ offset: true }).nullable().default(null),
  proto: z.array(z.object({ k: z.string().trim().min(1).max(40), v: z.string().trim().max(240), todo: z.boolean().optional() })).max(30).default([]),
  hotspots: z
    .object({
      front: z.array(z.object({ x: z.number(), y: z.number(), fx: z.number().optional(), fy: z.number().optional(), n: z.number().int().min(1).max(99).optional(), t: z.string().max(60), s: z.string().max(80) })).max(8),
      back: z.array(z.object({ x: z.number(), y: z.number(), fx: z.number().optional(), fy: z.number().optional(), n: z.number().int().min(1).max(99).optional(), t: z.string().max(60), s: z.string().max(80) })).max(8),
    })
    .default({ front: [], back: [] }),
  sizes: z
    .array(z.object({ label: z.string().trim().min(1).max(8), stock: z.number().int().min(0).max(100000), heightMin: n, heightMax: n, length: n, width: n, sleeve: n }))
    .max(12),
  sort: z.number().int().optional(),
});

export const adminRoutes = (ctx: AppCtx) => async (app: FastifyInstance) => {
  const { cfg, db, storage, bot } = ctx;
  const botDeps = (log: FastifyBaseLogger) => ({ cfg, db, storage, log });

  // ADMIN_IDS is checked here, on the server, from the signed initData — never on the client
  app.addHook('preHandler', async (req, reply) => {
    if (!req.tg?.isAdmin) return reply.status(403).send({ error: 'FORBIDDEN', message: 'Доступ запрещён. Попытка зафиксирована.' });
  });

  app.get('/dashboard', async (): Promise<ApiAdminDashboard> => {
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart.getTime() - 6 * 864e5);
    const paidStatuses = ['paid', 'assembled', 'shipped', 'delivered'] as const;
    const recent = await db.select().from(orders).where(and(inArray(orders.status, [...paidStatuses]), gte(orders.paidAt, new Date(weekStart.getTime() - 864e5))));
    const week = Array(7).fill(0) as number[];
    const hours = Array(24).fill(0) as number[];
    let today = 0, yesterday = 0;
    for (const o of recent) {
      const t = o.paidAt!.getTime();
      const di = Math.floor((t - weekStart.getTime()) / 864e5);
      if (di >= 0 && di < 7) week[di] += o.total;
      if (t >= dayStart.getTime()) { today += o.total; hours[o.paidAt!.getHours()] += o.total; }
      else if (t >= dayStart.getTime() - 864e5) yesterday += o.total;
    }
    const [{ c: ordersNew }] = await db.select({ c: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.status, 'paid'), gte(orders.paidAt, dayStart)));
    const [{ c: waiting }] = await db.select({ c: sql<number>`count(*)::int` }).from(orders).where(eq(orders.status, 'paid'));
    const [{ avg }] = await db.select({ avg: sql<number>`coalesce(round(avg(${orders.total})), 0)::int` }).from(orders).where(inArray(orders.status, [...paidStatuses]));
    const topRows = await db
      .select({ productId: orderItems.productId, no: orderItems.productNo, title: orderItems.title, qty: sql<number>`sum(${orderItems.qty})::int` })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(inArray(orders.status, [...paidStatuses]))
      .groupBy(orderItems.productId, orderItems.productNo, orderItems.title)
      .orderBy(desc(sql`sum(${orderItems.qty})`))
      .limit(1);
    let top: ApiAdminDashboard['top'] = null;
    if (topRows[0]) {
      const [img] = await db.select().from(productImages).where(and(eq(productImages.productId, topRows[0].productId), eq(productImages.slot, 'front')));
      top = { ...topRows[0], image: img ? toApiImage(img, storage) : null };
    }
    const low = await db
      .select({ productId: productSizes.productId, no: products.no, size: productSizes.label, available: sql<number>`(${productSizes.stock} - ${productSizes.reserved})::int` })
      .from(productSizes)
      .innerJoin(products, eq(products.id, productSizes.productId))
      .where(and(inArray(products.status, ['live', 'drop']), sql`${productSizes.stock} - ${productSizes.reserved} <= 3`))
      .orderBy(asc(products.no), asc(productSizes.position));
    const [{ w }] = await db.select({ w: sql<number>`count(*)::int` }).from(dropWatchers);
    return { revenueToday: today, revenueYesterday: yesterday, revenueWeek: week, hours, ordersNew, ordersWaiting: waiting, avgCheck: avg, top, lowStock: low, watchers: w };
  });

  /* ---------------------------------------------------------------- products */
  app.get('/products', async () => {
    const list = await listProducts(db, storage, { includeDrafts: true });
    const sizes = list.length ? await db.select().from(productSizes).where(inArray(productSizes.productId, list.map((p) => p.id))).orderBy(asc(productSizes.position)) : [];
    return list.map((p) => ({ ...p, sizesAdmin: sizes.filter((s) => s.productId === p.id).map((s) => ({ label: s.label, stock: s.stock, reserved: s.reserved, heightMin: s.heightMin, heightMax: s.heightMax, length: s.length, width: s.width, sleeve: s.sleeve })) }));
  });

  app.get<{ Params: { id: string } }>('/products/:id', async (req, reply) => (await getAdminProduct(db, storage, Number(req.params.id))) ?? reply.status(404).send({ error: 'NOT_FOUND' }));

  const saveSizes = async (productId: number, sizes: ApiAdminProductInput['sizes']) => {
    const existing = await db.select().from(productSizes).where(eq(productSizes.productId, productId));
    for (const [i, s] of sizes.entries()) {
      const row = existing.find((e) => e.label === s.label);
      const vals = { position: i, stock: s.stock, heightMin: s.heightMin, heightMax: s.heightMax, length: s.length, width: s.width, sleeve: s.sleeve };
      if (row) await db.update(productSizes).set(vals).where(eq(productSizes.id, row.id));
      else await db.insert(productSizes).values({ productId, label: s.label, ...vals });
    }
    for (const e of existing.filter((e) => !sizes.some((s) => s.label === e.label))) {
      const used = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.sizeId, e.id)).limit(1);
      if (used.length) await db.update(productSizes).set({ stock: e.reserved }).where(eq(productSizes.id, e.id)); // keep history, stop selling
      else await db.delete(productSizes).where(eq(productSizes.id, e.id));
    }
  };

  app.post('/products', async (req) => {
    const b = ProductInput.parse(req.body);
    const [{ m }] = await db.select({ m: max(products.sort) }).from(products);
    const [p] = await db
      .insert(products)
      .values({ no: b.no, slug: b.slug, sig: `SIG.${b.no}`, title: b.title, name: b.name, sub: b.sub, category: b.category, price: b.price, oldPrice: b.oldPrice, color: b.color, batch: b.batch, status: b.status, dropAt: b.dropAt ? new Date(b.dropAt) : null, proto: b.proto, hotspots: b.hotspots, sort: b.sort ?? (m ?? 0) + 1 })
      .returning();
    await saveSizes(p.id, b.sizes);
    return getAdminProduct(db, storage, p.id);
  });

  app.put<{ Params: { id: string } }>('/products/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const b = ProductInput.parse(req.body);
    const [p] = await db
      .update(products)
      .set({ no: b.no, slug: b.slug, sig: `SIG.${b.no}`, title: b.title, name: b.name, sub: b.sub, category: b.category, price: b.price, oldPrice: b.oldPrice, color: b.color, batch: b.batch, status: b.status, dropAt: b.dropAt ? new Date(b.dropAt) : null, proto: b.proto, hotspots: b.hotspots, ...(b.sort != null ? { sort: b.sort } : {}), updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    if (!p) return reply.status(404).send({ error: 'NOT_FOUND' });
    await saveSizes(id, b.sizes);
    return getAdminProduct(db, storage, id);
  });

  app.delete<{ Params: { id: string } }>('/products/:id', async (req) => {
    const id = Number(req.params.id);
    const used = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.productId, id)).limit(1);
    if (used.length) {
      await db.update(products).set({ status: 'archive', updatedAt: new Date() }).where(eq(products.id, id));
      return { ok: true, archived: true };
    }
    const imgs = await db.select().from(productImages).where(eq(productImages.productId, id));
    await db.delete(products).where(eq(products.id, id));
    await storage.remove(imgs.flatMap((i) => i.widths.flatMap((w) => i.formats.map((f) => `${i.key}-${w}.${f}`))));
    return { ok: true, archived: false };
  });

  /* ------------------------------------------------------------------ photos */
  app.post<{ Params: { id: string } }>('/products/:id/images', async (req, reply) => {
    const id = Number(req.params.id);
    const [p] = await db.select().from(products).where(eq(products.id, id));
    if (!p) return reply.status(404).send({ error: 'NOT_FOUND' });
    const file = await req.file();
    if (!file) return reply.status(400).send({ error: 'NO_FILE', message: 'Файл не получен' });
    const field = (k: string) => { const f = file.fields[k] as { value?: string } | undefined; return f && 'value' in f ? String(f.value) : ''; };
    const slot = z.enum(['front', 'back', 'detail']).parse(field('slot') || 'detail');
    const crop = (['none', '45', '11'].includes(field('crop')) ? field('crop') : 'none') as Crop;
    const cutout = field('cutout') === 'black' ? 'black' : 'none';
    if (!/^image\//.test(file.mimetype)) return reply.status(400).send({ error: 'BAD_FILE', message: 'Нужна картинка' });
    const buf = await file.toBuffer();
    const img = await processImage(buf, storage, { prefix: `products/${p.no}/${slot}`, crop, cutout });
    if (slot !== 'detail') {
      const old = await db.select().from(productImages).where(and(eq(productImages.productId, id), eq(productImages.slot, slot)));
      if (old.length) {
        await db.delete(productImages).where(inArray(productImages.id, old.map((o) => o.id)));
        await storage.remove(old.flatMap((i) => i.widths.flatMap((w) => i.formats.map((f) => `${i.key}-${w}.${f}`))));
      }
    }
    const [{ m }] = await db.select({ m: max(productImages.position) }).from(productImages).where(eq(productImages.productId, id));
    const [row] = await db.insert(productImages).values({ productId: id, slot, position: (m ?? 0) + 1, ...img }).returning();
    return toApiImage(row, storage);
  });

  app.delete<{ Params: { imageId: string } }>('/images/:imageId', async (req) => {
    const [i] = await db.delete(productImages).where(eq(productImages.id, Number(req.params.imageId))).returning();
    if (i) await storage.remove(i.widths.flatMap((w) => i.formats.map((f) => `${i.key}-${w}.${f}`)));
    return { ok: !!i };
  });

  app.post<{ Params: { id: string } }>('/products/:id/images/order', async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int()) }).parse(req.body);
    for (const [pos, imageId] of ids.entries()) await db.update(productImages).set({ position: pos }).where(and(eq(productImages.id, imageId), eq(productImages.productId, Number(req.params.id))));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/products/:id/announce', async (req, reply) => {
    if (!bot) return reply.status(501).send({ error: 'NO_BOT', message: 'Бот не подключён' });
    const { caption } = z.object({ caption: z.string().max(1000).optional() }).parse(req.body ?? {});
    const m = await announceProduct(botDeps(req.log), bot, Number(req.params.id), caption);
    return { ok: true, messageId: m.message_id };
  });

  /* ------------------------------------------------------------------ orders */
  app.get<{ Querystring: { status?: string; q?: string } }>('/orders', async (req) => {
    const st = req.query.status && (ORDER_STATUSES as readonly string[]).includes(req.query.status) ? (req.query.status as (typeof ORDER_STATUSES)[number]) : null;
    const q = (req.query.q || '').trim();
    const list = await db
      .select()
      .from(orders)
      .where(and(st ? eq(orders.status, st) : undefined, q ? sql`(${orders.no} ILIKE ${'%' + q + '%'} OR ${orders.name} ILIKE ${'%' + q + '%'} OR ${orders.phone} ILIKE ${'%' + q + '%'} OR ${orders.subjectNo} ILIKE ${'%' + q + '%'})` : undefined))
      .orderBy(desc(orders.createdAt))
      .limit(300);
    return toAdminOrders(db, storage, list);
  });

  app.patch<{ Params: { no: string } }>('/orders/:no', async (req, reply) => {
    const b = z.object({ status: z.enum(ORDER_STATUSES).optional(), trackNo: z.string().trim().max(64).nullable().optional(), notify: z.boolean().default(true) }).parse(req.body);
    const [o] = await db.select().from(orders).where(eq(orders.no, req.params.no));
    if (!o) return reply.status(404).send({ error: 'NOT_FOUND' });
    if (b.status === 'cancelled' && o.status === 'pending') await cancelOrder(db, o.userId, o.no!);
    const patch: Partial<typeof orders.$inferInsert> = { updatedAt: new Date() };
    if (b.status && !(b.status === 'cancelled' && o.status === 'pending')) patch.status = b.status;
    if (b.trackNo !== undefined) patch.trackNo = b.trackNo || null;
    if (b.trackNo && !b.status && (o.status === 'paid' || o.status === 'assembled')) patch.status = 'shipped'; // a track number means the parcel left
    const [u] = await db.update(orders).set(patch).where(eq(orders.id, o.id)).returning();
    const changed = (patch.status && patch.status !== o.status) || (patch.trackNo !== undefined && patch.trackNo !== o.trackNo);
    let notified = false;
    if (bot && b.notify && changed) {
      try { await notifyOrderUpdate(botDeps(req.log), bot, u); notified = true; } catch (e) { req.log.warn({ err: e }, 'order notify failed'); }
    }
    const [api] = await toAdminOrders(db, storage, [u]);
    return { ...api, notified };
  });

  // СДЭК: hand a paid order over again (CDEK was down, the shipment point was missing) and get the waybill PDF
  const cdekOrder = async (no: string) => {
    if (!ctx.cdek) throw new OrderError('NO_CDEK', 'СДЭК выключен: CDEK_MODE=off', 400);
    const [o] = await db.select().from(orders).where(eq(orders.no, no));
    if (!o?.cdek) throw new OrderError('NOT_CDEK', 'Это дело не через СДЭК', 400);
    return { cdek: ctx.cdek, o };
  };
  app.post<{ Params: { no: string } }>('/orders/:no/cdek', async (req) => {
    const { cdek, o } = await cdekOrder(req.params.no);
    if (o.status === 'pending' || o.status === 'cancelled' || o.status === 'expired') throw new OrderError('NOT_PAID', 'Дело не оплачено', 409);
    const u = await registerShipment(db, cdek, req.log, o.cdek?.error ? { ...o, cdek: { ...o.cdek, error: undefined } } : o);
    const [api] = await toAdminOrders(db, storage, [u]);
    return api;
  });
  app.post<{ Params: { no: string } }>('/orders/:no/waybill', async (req) => {
    const { cdek, o } = await cdekOrder(req.params.no);
    if (!o.cdek?.uuid) throw new OrderError('NO_SHIPMENT', 'Отправление ещё не создано в СДЭК', 409);
    if (!bot) throw new OrderError('NO_BOT', 'Бот выключен', 503);
    const pdf = await cdek.waybill(o.cdek.uuid);
    await bot.api.sendDocument(req.tg!.user.id, new InputFile(pdf, `${o.no}-cdek.pdf`), { caption: `Накладная СДЭК · CASE #${o.no}${o.cdek.number ? ` · № ${o.cdek.number}` : ''}` });
    return { ok: true };
  });

  const ordersCsv = async () => {
    const list = await db.select().from(orders).orderBy(desc(orders.createdAt)).limit(10000);
    const items = list.length ? await db.select().from(orderItems).where(inArray(orderItems.orderId, list.map((o) => o.id))) : [];
    const head = ['case', 'status', 'created_at', 'paid_at', 'subject', 'telegram_id', 'name', 'phone', 'delivery', 'address', 'items', 'items_total', 'delivery_price', 'total', 'track', 'telegram_charge_id', 'provider_charge_id', 'comment'];
    // a leading = + - @ (or tab/CR) makes Excel run the cell as a formula: names and comments come from customers
    const cell = (v: unknown) => `"${String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
    const rows = list.map((o) => [o.no, ORDER_STATUS_LABEL[o.status], o.createdAt.toISOString(), o.paidAt?.toISOString() ?? '', o.subjectNo, o.userId, o.name, o.phone, o.deliveryTitle, o.address, items.filter((i) => i.orderId === o.id).map((i) => `${i.title} / ${i.sizeLabel} ×${i.qty}`).join('; '), o.itemsTotal, o.deliveryPrice, o.total, o.trackNo, o.telegramChargeId, o.providerChargeId, o.comment].map(cell).join(';'));
    return '\uFEFF' + [head.join(';'), ...rows].join('\r\n');
  };
  const csvName = () => `mrak8-orders-${new Date().toISOString().slice(0, 10)}.csv`;

  app.get('/orders.csv', async (_req, reply) => {
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${csvName()}"`);
    return ordersCsv();
  });

  /** inside Telegram a file download is awkward — the bot sends the CSV to the admin's chat instead */
  app.post('/orders/export', async (req, reply) => {
    if (!bot) return reply.status(501).send({ error: 'NO_BOT', message: 'Бот не подключён' });
    const csv = await ordersCsv();
    await bot.api.sendDocument(req.tg!.user.id, new InputFile(Buffer.from(csv, 'utf8'), csvName()), { caption: 'Экспорт дел MRAK8 · CONTROL ROOM' });
    return { ok: true };
  });

  /* ---------------------------------------------------------- delivery & drops */
  app.get('/delivery', async () => listDelivery(db, true));
  app.put('/delivery', async (req) => {
    const list = z.array(z.object({ key: z.string().regex(/^[a-z0-9_-]{2,32}$/), title: z.string().min(1).max(60), subtitle: z.string().max(120).default(''), price: z.number().int().min(0), needsAddress: z.boolean(), active: z.boolean() })).max(12).parse(req.body);
    for (const [position, d] of list.entries()) {
      await db.insert(deliveryMethods).values({ ...d, position }).onConflictDoUpdate({ target: deliveryMethods.key, set: { ...d, position } });
    }
    return listDelivery(db, true);
  });

  app.get('/drops', async () => {
    const list = await db.select().from(products).where(eq(products.status, 'drop')).orderBy(asc(products.dropAt));
    const counts = list.length
      ? await db.select({ productId: dropWatchers.productId, c: sql<number>`count(*)::int` }).from(dropWatchers).where(inArray(dropWatchers.productId, list.map((p) => p.id))).groupBy(dropWatchers.productId)
      : [];
    return list.map((p) => ({ id: p.id, no: p.no, title: p.title, dropAt: p.dropAt?.toISOString() ?? null, watchers: counts.find((c) => c.productId === p.id)?.c ?? 0 }));
  });
};
