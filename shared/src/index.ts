/* MRAK8 — code shared by server and web: identifiers, labels, API contract. */

/** SUBJECT number shown in the header, splash and receipt. Deterministic from the Telegram user id (FNV-1a 32). */
export function subjectNo(id: number | string): string {
  let h = 0x811c9dc5;
  for (const c of String(id)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return '08-' + String(h % 10000).padStart(4, '0');
}

export const orderNo = (id: number): string => 'MRK-' + String(id).padStart(6, '0');

/** "6 900 ₽" with no-break spaces (prices are whole rubles everywhere in MRAK8). */
export const formatRub = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';

export const PRODUCT_STATUSES = ['draft', 'drop', 'live', 'soldout', 'archive'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const PRODUCT_STATUS_LABEL: Record<ProductStatus, string> = {
  draft: 'ЧЕРНОВИК',
  drop: 'ДРОП СКОРО',
  live: 'В ПРОДАЖЕ',
  soldout: 'SOLD OUT',
  archive: 'АРХИВ',
};

export const CATEGORIES = ['hoodie', 'tee', 'acc', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = { hoodie: 'ХУДИ', tee: 'ФУТБОЛКИ', acc: 'АКСЕССУАРЫ', other: 'ПРОЧЕЕ' };

export const ORDER_STATUSES = ['pending', 'paid', 'assembled', 'shipped', 'delivered', 'cancelled', 'expired'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'ОЖИДАЕТ ОПЛАТЫ',
  paid: 'ПРИНЯТ',
  assembled: 'СОБРАН',
  shipped: 'ЭТАПИРОВАН',
  delivered: 'ДОСТАВЛЕН',
  cancelled: 'ОТМЕНЁН',
  expired: 'РЕЗЕРВ ИСТЁК',
};
/** the four public steps shown in the dossier */
export const ORDER_STEPS: OrderStatus[] = ['paid', 'assembled', 'shipped', 'delivered'];

export const IMAGE_SLOTS = ['front', 'back', 'detail'] as const;
export type ImageSlot = (typeof IMAGE_SLOTS)[number];
export const IMAGE_WIDTHS = [360, 720, 1200, 2400] as const;

/* ------------------------------------------------------------------ API contract */
export interface ApiImage {
  id: number;
  slot: ImageSlot;
  /** url prefix; files are `${base}-${width}.${format}` */
  base: string;
  widths: number[];
  formats: ('avif' | 'webp')[];
  lqip: string;
  /** garment bbox in % of the image: [x0, y0, x1, y1] */
  bbox: [number, number, number, number] | null;
  w: number;
  h: number;
  alpha: boolean;
}
export interface ApiSize {
  label: string;
  available: number;
  heightMin: number | null;
  heightMax: number | null;
  length: number | null;
  width: number | null;
  sleeve: number | null;
}
/** evidence marker on the photo, x/y in %; `n` overrides the shown number (one detail marked in several places) */
export interface ApiHotspot { x: number; y: number; fx?: number; fy?: number; n?: number; t: string; s: string }
export interface ApiProtoRow { k: string; v: string; todo?: boolean }
export interface ApiProduct {
  id: number;
  no: string;
  slug: string;
  sig: string;
  title: string;
  name: string;
  sub: string;
  category: Category;
  price: number;
  oldPrice: number | null;
  color: string;
  batch: string;
  status: ProductStatus;
  dropAt: string | null;
  proto: ApiProtoRow[];
  hotspots: { front: ApiHotspot[]; back: ApiHotspot[] };
  images: { front: ApiImage | null; back: ApiImage | null; details: ApiImage[] };
  sizes: ApiSize[];
  watching?: boolean;
  todo?: string[];
}
export interface ApiDelivery { key: string; title: string; subtitle: string; price: number; needsAddress: boolean }
export interface ApiMe { id: number; subjectNo: string; firstName: string; lastName: string; username: string | null; photoUrl: string | null; height: number | null; isAdmin: boolean }
export interface ApiBootstrap {
  me: ApiMe;
  products: ApiProduct[];
  delivery: ApiDelivery[];
  config: { miniappLink: string; reserveMinutes: number; paymentsLive: boolean; testMode: boolean; cdek: boolean };
}
export interface ApiOrderItem { productId: number; no: string; title: string; size: string; qty: number; price: number; image: ApiImage | null }
export interface ApiOrder {
  no: string;
  status: OrderStatus;
  createdAt: string;
  paidAt: string | null;
  reservedUntil: string | null;
  items: ApiOrderItem[];
  delivery: { key: string; title: string; price: number };
  itemsTotal: number;
  total: number;
  name: string;
  trackNo: string | null;
}
/**
 * t.me link that opens MRAK8 at `param`. A named mini app (t.me/<bot>/<app>) takes `startapp`; a plain bot link
 * gets `/start <param>` and the bot answers with a button into the mini app — `?startapp` on a bot without a Main
 * Mini App fails with «bot invalid».
 */
export function deepLink(base: string, param?: string) {
  if (!param) return base;
  const named = /^https:\/\/t\.me\/[^/?#]+\/[^/?#]+/.test(base);
  return `${base}?${named ? 'startapp' : 'start'}=${encodeURIComponent(param)}`;
}

/** how a track mixes: tempo, first downbeat and end of audio (s), Camelot key, loudness (dBFS) */
export interface DjMix { bpm: number; beat: number; end: number; key: string; db: number }
/** a DJ set track; the audio itself is at /dj/<id>; `mix` is null until the server has analysed it */
export interface ApiDjTrack { id: number; title: string; performer: string; duration: number; mix: DjMix | null }

/* СДЭК: city from the suggest, a pickup point (ПВЗ), a price quote, what the subject chose */
export type CdekMode = 'pvz' | 'door';
export interface CdekCity { code: number; name: string }
export interface CdekPoint { code: string; name: string; address: string; workTime: string; metro: string; lat: number | null; lon: number | null }
export interface CdekQuote { price: number; daysMin: number; daysMax: number }
export interface CdekChoice { cityCode: number; city: string; mode: CdekMode; pvzCode?: string }
/** the shipment as the shop sees it (Control room) */
export interface CdekShipment extends CdekChoice { pvzAddress?: string; uuid?: string; number?: string; status?: string; statusName?: string; error?: string }

export interface CreateOrderBody {
  items: { productId: number; size: string; qty: number }[];
  protocol: { name: string; phone: string; delivery: string; address?: string; comment?: string; cdek?: CdekChoice };
}
export interface CreateOrderResult { order: ApiOrder; invoiceLink: string }

/* admin */
export interface ApiAdminDashboard {
  revenueToday: number;
  revenueYesterday: number;
  revenueWeek: number[];
  hours: number[];
  ordersNew: number;
  ordersWaiting: number;
  avgCheck: number;
  top: { productId: number; no: string; title: string; qty: number; image: ApiImage | null } | null;
  lowStock: { productId: number; no: string; size: string; available: number }[];
  watchers: number;
}
export interface ApiAdminOrder extends ApiOrder { id: number; userId: number; subjectNo: string; phone: string; address: string; comment: string; cdek: CdekShipment | null }
export interface ApiAdminProductInput {
  no: string;
  slug: string;
  title: string;
  name: string;
  sub: string;
  category: Category;
  price: number;
  oldPrice: number | null;
  color: string;
  batch: string;
  status: ProductStatus;
  dropAt: string | null;
  proto: ApiProtoRow[];
  hotspots: { front: ApiHotspot[]; back: ApiHotspot[] };
  sizes: { label: string; stock: number; heightMin: number | null; heightMax: number | null; length: number | null; width: number | null; sleeve: number | null }[];
  sort?: number;
}
export interface ApiAdminProduct extends ApiProduct { sizesAdmin: (ApiAdminProductInput['sizes'][number] & { reserved: number })[]; sort: number }
export * from './qr.js';
