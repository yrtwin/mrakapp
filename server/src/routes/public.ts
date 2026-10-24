import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ApiBootstrap, CreateOrderResult } from '@mrak8/shared';
import type { AppCtx } from '../app.js';
import { prepareShare, receiptText, notifyAdmins } from '../bot/index.js';
import { dropWatchers, orders, products, users } from '../db/schema.js';
import { getProduct, listDelivery, listProducts } from '../services/catalog.js';
import { cancelOrder, createOrder, CreateOrderSchema, findOrderByNo, listUserOrders, markPaid, OrderError, preCheckout, setInvoiceLink, toApiOrders, type PricedDelivery } from '../services/orders.js';
import { priceCdek, registerShipment } from '../services/shipping.js';
import { listTracks, streamTrack, toApiTracks } from '../services/dj.js';
import { buildInvoice } from '../services/payments.js';

export const publicRoutes = (ctx: AppCtx) => async (app: FastifyInstance) => {
  const { cfg, db, storage, bot } = ctx;
  const cdek = ctx.cdek ?? null;
  const paymentsLive = !!bot && !!cfg.PAYMENT_PROVIDER_TOKEN && cfg.PAYMENT_PROVIDER !== 'none';

  // СДЭК for the protocol: cities as the subject types, pickup points of a city, the price of each mode
  const needCdek = () => { if (!cdek) throw new OrderError('NO_CDEK', 'Расчёт СДЭК выключен', 404); return cdek; };
  app.get<{ Querystring: { q?: string } }>('/api/cdek/cities', async (req) => needCdek().cities(req.query.q ?? ''));
  app.get<{ Querystring: { city?: string } }>('/api/cdek/points', async (req) => needCdek().points(Number(req.query.city)));
  app.get<{ Querystring: { city?: string; mode?: string; qty?: string } }>('/api/cdek/quote', async (req) => {
    const q = z.object({ city: z.coerce.number().int().positive(), mode: z.enum(['pvz', 'door']), qty: z.coerce.number().int().min(1).max(50).default(1) }).parse(req.query);
    return needCdek().quote(q.city, q.mode, q.qty);
  });

  // DJ set: the playlist for the mini app, and the audio itself at a plain URL (<audio> sends no auth headers)
  app.get('/api/dj', async () => toApiTracks(await listTracks(db)));
  app.get<{ Params: { id: string } }>('/dj/:id', (req, reply) => streamTrack(cfg, db, bot, req, reply));

  app.get('/api/bootstrap', async (req): Promise<ApiBootstrap> => {
    const t = req.tg!;
    const [u] = await db.select().from(users).where(eq(users.id, t.user.id));
    const [productsList, delivery] = await Promise.all([listProducts(db, storage, { userId: t.user.id }), listDelivery(db)]);
    return {
      me: { id: t.user.id, subjectNo: t.subjectNo, firstName: u?.firstName ?? '', lastName: u?.lastName ?? '', username: u?.username ?? null, photoUrl: u?.photoUrl ?? null, height: u?.height ?? null, isAdmin: t.isAdmin },
      products: productsList,
      delivery: delivery.map(({ key, title, subtitle, price, needsAddress }) => ({ key, title, subtitle, price, needsAddress })),
      config: { miniappLink: cfg.MINIAPP_LINK, reserveMinutes: cfg.RESERVE_MINUTES, paymentsLive, testMode: !paymentsLive || cfg.testPayments, cdek: !!cdek },
    };
  });

  app.get<{ Params: { id: string } }>('/api/products/:id', async (req, reply) => {
    const p = await getProduct(db, storage, Number(req.params.id), { userId: req.tg!.user.id });
    return p ?? reply.status(404).send({ error: 'NOT_FOUND', message: 'Вещдок не найден' });
  });

  app.post('/api/me/height', async (req) => {
    const { height } = z.object({ height: z.number().int().min(120).max(230) }).parse(req.body);
    await db.update(users).set({ height }).where(eq(users.id, req.tg!.user.id));
    return { ok: true };
  });

  app.post('/api/orders', async (req, reply): Promise<CreateOrderResult | undefined> => {
    const t = req.tg!;
    const body = CreateOrderSchema.parse(req.body);
    // СДЭК is priced here, outside the order transaction: a call to CDEK must not hold row locks
    let priced: PricedDelivery | undefined;
    if (cdek && body.protocol.delivery === 'cdek') {
      if (!body.protocol.cdek) throw new OrderError('NO_CITY', 'Выберите город и пункт выдачи СДЭК', 400);
      priced = await priceCdek(cdek, body.protocol.cdek, body.protocol.address, body.items.reduce((a, i) => a + i.qty, 0));
    }
    const { order, items } = await createOrder(db, { id: t.user.id, subjectNo: t.subjectNo }, body, cfg.RESERVE_MINUTES, priced);
    let invoiceLink = `demo:${order.no}`;
    if (paymentsLive && bot) {
      const inv = buildInvoice(cfg, order, items);
      try {
        invoiceLink = await bot.api.createInvoiceLink(inv.title, inv.description, inv.payload, cfg.PAYMENT_PROVIDER_TOKEN, inv.currency, inv.prices, inv.other);
      } catch (e) {
        req.log.error({ err: e }, 'createInvoiceLink failed');
        await cancelOrder(db, t.user.id, order.no!);
        reply.status(502).send({ error: 'PAYMENT_UNAVAILABLE', message: 'Касса не отвечает. Повторите через минуту.' });
        return;
      }
      await setInvoiceLink(db, order.id, invoiceLink);
    } else if (cfg.isProd) {
      await cancelOrder(db, t.user.id, order.no!);
      reply.status(503).send({ error: 'PAYMENT_DISABLED', message: 'Оплата не настроена' });
      return;
    }
    const [api] = await toApiOrders(db, storage, [order]);
    return { order: api, invoiceLink };
  });

  app.get('/api/orders', async (req) => listUserOrders(db, storage, req.tg!.user.id));

  app.get<{ Params: { no: string } }>('/api/orders/:no', async (req, reply) => {
    const [o] = await db.select().from(orders).where(and(eq(orders.no, req.params.no), eq(orders.userId, req.tg!.user.id)));
    if (!o) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Дело не найдено' });
    const [api] = await toApiOrders(db, storage, [o]);
    return api;
  });

  app.post<{ Params: { no: string } }>('/api/orders/:no/cancel', async (req) => ({ ok: await cancelOrder(db, req.tg!.user.id, req.params.no) }));

  app.post<{ Params: { id: string } }>('/api/drops/:id/watch', async (req, reply) => {
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    const productId = Number(req.params.id);
    const [p] = await db.select({ id: products.id }).from(products).where(eq(products.id, productId));
    if (!p) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Вещдок не найден' });
    if (on) await db.insert(dropWatchers).values({ productId, userId: req.tg!.user.id }).onConflictDoNothing();
    else await db.delete(dropWatchers).where(and(eq(dropWatchers.productId, productId), eq(dropWatchers.userId, req.tg!.user.id)));
    return { ok: true, on };
  });

  app.post<{ Params: { no: string } }>('/api/share/:no', async (req, reply) => {
    if (!bot) return reply.status(501).send({ error: 'NO_BOT', message: 'Бот не подключён' });
    const found = await findOrderByNo(db, req.params.no);
    if (!found || found.order.userId !== req.tg!.user.id) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Дело не найдено' });
    const prepared = await prepareShare({ cfg, db, storage, log: req.log }, bot, req.tg!.user.id, req.params.no);
    return { id: prepared.id };
  });

  /* local development without real money: emulate pre_checkout_query + successful_payment for an own pending order */
  if (!cfg.isProd) {
    app.post<{ Params: { no: string } }>('/api/dev/pay/:no', async (req, reply) => {
      const found = await findOrderByNo(db, req.params.no);
      if (!found || found.order.userId !== req.tg!.user.id) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Дело не найдено' });
      const pc = await preCheckout(db, found.order.payload, found.order.total * 100, 'RUB', cfg.RESERVE_MINUTES);
      if (!pc.ok) throw new OrderError('PRECHECKOUT', pc.error, 409);
      const r = await markPaid(db, found.order.payload, { telegram: `dev-${Date.now()}`, provider: 'dev', totalAmount: found.order.total * 100 });
      if (r && !r.already && bot) {
        try {
          await bot.api.sendMessage(r.order.userId, receiptText(r.order, r.items), { parse_mode: 'HTML' });
          await notifyAdmins({ cfg, db, storage, log: req.log }, bot, r.order, r.items, r.oversold);
        } catch (e) { req.log.warn({ err: e }, 'dev receipt not sent'); }
      }
      if (r && !r.already && cdek && r.order.cdek) r.order = await registerShipment(db, cdek, req.log, r.order, r.items);
      const [api] = await toApiOrders(db, storage, [r!.order]);
      return api;
    });
  }
};
