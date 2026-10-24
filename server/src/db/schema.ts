import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ApiHotspot, ApiProtoRow, CdekShipment } from '@mrak8/shared';

export const productStatus = pgEnum('product_status', ['draft', 'drop', 'live', 'soldout', 'archive']);
export const category = pgEnum('category', ['hoodie', 'tee', 'acc', 'other']);
export const orderStatus = pgEnum('order_status', ['pending', 'paid', 'assembled', 'shipped', 'delivered', 'cancelled', 'expired']);
export const imageSlot = pgEnum('image_slot', ['front', 'back', 'detail']);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).primaryKey(), // telegram user id
  username: text('username'),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  photoUrl: text('photo_url'),
  languageCode: text('language_code'),
  subjectNo: text('subject_no').notNull(),
  height: integer('height'),
  phone: text('phone'),
  createdAt: ts('created_at').defaultNow().notNull(),
  lastSeenAt: ts('last_seen_at').defaultNow().notNull(),
});

export const products = pgTable(
  'products',
  {
    id: serial('id').primaryKey(),
    no: text('no').notNull(), // evidence number, "001"
    slug: text('slug').notNull(),
    sig: text('sig').notNull().default(''),
    title: text('title').notNull(),
    name: text('name').notNull().default(''),
    sub: text('sub').notNull().default(''),
    category: category('category').notNull().default('other'),
    price: integer('price').notNull().default(0), // whole rubles
    oldPrice: integer('old_price'),
    color: text('color').notNull().default(''),
    batch: text('batch').notNull().default(''),
    status: productStatus('status').notNull().default('draft'),
    dropAt: ts('drop_at'),
    proto: jsonb('proto').$type<ApiProtoRow[]>().notNull().default(sql`'[]'::jsonb`),
    hotspots: jsonb('hotspots').$type<{ front: ApiHotspot[]; back: ApiHotspot[] }>().notNull().default(sql`'{"front":[],"back":[]}'::jsonb`),
    todo: jsonb('todo').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    sort: integer('sort').notNull().default(0),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('products_no_uq').on(t.no), uniqueIndex('products_slug_uq').on(t.slug), index('products_status_idx').on(t.status)],
);

export const productSizes = pgTable(
  'product_sizes',
  {
    id: serial('id').primaryKey(),
    productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    position: integer('position').notNull().default(0),
    stock: integer('stock').notNull().default(0),
    /** units held by pending orders; available = stock - reserved */
    reserved: integer('reserved').notNull().default(0),
    heightMin: integer('height_min'),
    heightMax: integer('height_max'),
    length: integer('length'),
    width: integer('width'),
    sleeve: integer('sleeve'),
  },
  (t) => [uniqueIndex('product_sizes_uq').on(t.productId, t.label)],
);

export const productImages = pgTable(
  'product_images',
  {
    id: serial('id').primaryKey(),
    productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    slot: imageSlot('slot').notNull(),
    position: integer('position').notNull().default(0),
    key: text('key').notNull(), // storage key prefix, e.g. products/001/front-ab12
    widths: jsonb('widths').$type<number[]>().notNull(),
    formats: jsonb('formats').$type<('avif' | 'webp')[]>().notNull(),
    w: integer('w').notNull(),
    h: integer('h').notNull(),
    lqip: text('lqip').notNull(),
    bbox: jsonb('bbox').$type<[number, number, number, number] | null>(),
    alpha: boolean('alpha').notNull().default(false),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('product_images_product_idx').on(t.productId)],
);

export const deliveryMethods = pgTable('delivery_methods', {
  key: text('key').primaryKey(),
  title: text('title').notNull(),
  subtitle: text('subtitle').notNull().default(''),
  price: integer('price').notNull().default(0),
  needsAddress: boolean('needs_address').notNull().default(true),
  active: boolean('active').notNull().default(true),
  position: integer('position').notNull().default(0),
});

export const orders = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),
    no: text('no'),
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id),
    subjectNo: text('subject_no').notNull(),
    status: orderStatus('status').notNull().default('pending'),
    /** invoice payload (random), what Telegram sends back in pre_checkout / successful_payment */
    payload: text('payload').notNull(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    deliveryKey: text('delivery_key').notNull(),
    deliveryTitle: text('delivery_title').notNull(),
    deliveryPrice: integer('delivery_price').notNull().default(0),
    address: text('address').notNull().default(''),
    comment: text('comment').notNull().default(''),
    itemsTotal: integer('items_total').notNull(),
    total: integer('total').notNull(),
    currency: text('currency').notNull().default('RUB'),
    invoiceLink: text('invoice_link'),
    reservedUntil: ts('reserved_until'),
    telegramChargeId: text('telegram_payment_charge_id'),
    providerChargeId: text('provider_payment_charge_id'),
    trackNo: text('track_no'),
    /** СДЭК shipment: the subject's choice, then uuid / number / status from CDEK */
    cdek: jsonb('cdek').$type<CdekShipment>(),
    paidAt: ts('paid_at'),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('orders_no_uq').on(t.no),
    uniqueIndex('orders_payload_uq').on(t.payload),
    uniqueIndex('orders_tg_charge_uq').on(t.telegramChargeId),
    index('orders_user_idx').on(t.userId),
    index('orders_status_idx').on(t.status),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: serial('id').primaryKey(),
    orderId: integer('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
    productId: integer('product_id').notNull().references(() => products.id),
    sizeId: integer('size_id').notNull().references(() => productSizes.id),
    sizeLabel: text('size_label').notNull(),
    title: text('title').notNull(),
    productNo: text('product_no').notNull(),
    price: integer('price').notNull(),
    qty: integer('qty').notNull(),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
);

export const dropWatchers = pgTable(
  'drop_watchers',
  {
    productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id),
    createdAt: ts('created_at').defaultNow().notNull(),
    notifiedAt: ts('notified_at'),
  },
  (t) => [primaryKey({ columns: [t.productId, t.userId] })],
);

/** bot messages with buttons into the mini app: re-pointed when a tunnel moves it to a new address */
export const appButtons = pgTable(
  'app_buttons',
  {
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: integer('message_id').notNull(),
    base: text('base').notNull(), // WEBAPP_URL the buttons were made with
    markup: jsonb('markup').notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.messageId] }), index('app_buttons_created').on(t.createdAt)],
);

/** DJ set: tracks live in Telegram (sent to the bot by an admin); only the file id and the title are stored */
export const djTracks = pgTable('dj_tracks', {
  id: serial('id').primaryKey(),
  fileId: text('file_id').notNull(),
  fileUniqueId: text('file_unique_id').notNull().unique(),
  title: text('title').notNull(),
  performer: text('performer').notNull().default(''),
  duration: integer('duration').notNull().default(0),
  size: integer('size').notNull().default(0),
  position: integer('position').notNull().default(0),
  createdAt: ts('created_at').defaultNow().notNull(),
});
