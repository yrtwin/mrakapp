/* СДЭК API v2 (https://api-docs.cdek.ru): city suggest, pickup points, tariff quote, shipment, status, waybill.
   CDEK_MODE=test runs against CDEK's sandbox with the public test account from their docs — nothing ships there. */
import type { CdekCity, CdekMode, CdekPoint, CdekQuote, CdekShipment } from '@mrak8/shared';
import type { Config } from '../config.js';
import type { OrderItemRow, OrderRow } from './orders.js';

const SANDBOX = { base: 'https://api.edu.cdek.ru/v2', id: 'wqGwiQx0gg8mLtiEKsUinjVSICCjtTEP', secret: 'RmAmgvSgSl1yirlz9QupbzOJVqhCxcP5' };
/** «Посылка склад-склад» to a pickup point, «склад-дверь» to the door: the shop drops parcels at a CDEK office */
export const TARIFF: Record<CdekMode, number> = { pvz: 136, door: 137 };
/** a parcel the courier has taken, or that sits at the sender's office, is on its way */
const ON_THE_WAY = /^(RECEIVED_AT_SHIPMENT_WAREHOUSE|READY_TO_SHIP_AT_SENDING_OFFICE|TAKEN_BY_TRANSPORTER|SENT_TO_|ACCEPTED_IN_|ACCEPTED_AT_|RECEIVED_AT_|READY_FOR_SHIPMENT|TAKEN_BY_COURIER|ACCEPTED_AT_PICK_UP_POINT)/;

export class CdekError extends Error {}

export interface Cdek {
  cities(q: string): Promise<CdekCity[]>;
  points(cityCode: number): Promise<CdekPoint[]>;
  quote(cityCode: number, mode: CdekMode, qty: number): Promise<CdekQuote>;
  createShipment(order: OrderRow, items: OrderItemRow[]): Promise<{ uuid: string }>;
  shipment(uuid: string): Promise<{ number?: string; status?: string; statusName?: string; error?: string }>;
  waybill(uuid: string): Promise<Buffer>;
}

/** what a CDEK status means for the order */
export const cdekStage = (status?: string) => (status === 'DELIVERED' ? 'delivered' : status === 'ACCEPTED_AT_PICK_UP_POINT' ? 'at_point' : status && ON_THE_WAY.test(status) ? 'shipped' : 'waiting');

export function createCdek(cfg: Config): Cdek | null {
  if (cfg.CDEK_MODE === 'off') return null;
  const live = cfg.CDEK_MODE === 'live';
  if (live && !(cfg.CDEK_ACCOUNT && cfg.CDEK_SECURE)) throw new Error('CDEK_MODE=live needs CDEK_ACCOUNT and CDEK_SECURE');
  const base = live ? 'https://api.cdek.ru/v2' : SANDBOX.base;
  const [grams, dims] = cfg.CDEK_PARCEL.split(':');
  const [length, width, height] = dims.split('x').map(Number);
  const shipmentPoint = cfg.CDEK_SHIPMENT_POINT || (live ? '' : 'MSK2');
  const parcel = (qty: number) => ({ weight: Number(grams) * qty, length, width, height: height * qty });

  let token = { value: '', until: 0 };
  const auth = async () => {
    if (token.value && Date.now() < token.until) return token.value;
    const q = new URLSearchParams({ grant_type: 'client_credentials', client_id: live ? cfg.CDEK_ACCOUNT : SANDBOX.id, client_secret: live ? cfg.CDEK_SECURE : SANDBOX.secret });
    const r = await fetch(`${base}/oauth/token?${q}`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!r.ok || !j.access_token) throw new CdekError('СДЭК не пустил: проверьте CDEK_ACCOUNT / CDEK_SECURE');
    token = { value: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 120) * 1000 };
    return token.value;
  };
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${await auth()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new CdekError((j as { errors?: { message: string }[] } | null)?.errors?.map((e) => e.message).join('; ') || `СДЭК ответил ${r.status}`);
    return j as T;
  };

  const pointCache = new Map<number, { at: number; list: CdekPoint[] }>();

  return {
    async cities(q) {
      if (q.trim().length < 2) return [];
      const list = await call<{ code: number; full_name: string }[]>('GET', `/location/suggest/cities?name=${encodeURIComponent(q.trim())}&country_code=RU`);
      // «Казань, городской округ Казань, Татарстан, Россия» → «Казань, Татарстан»
      const short = (n: string) => n.split(', ').filter((p) => p !== 'Россия' && !/^(городской округ|муниципальный округ|городское поселение) /i.test(p)).join(', ');
      return list.slice(0, 10).map((c) => ({ code: c.code, name: short(c.full_name) }));
    },
    async points(cityCode) {
      const hit = pointCache.get(cityCode);
      if (hit && Date.now() - hit.at < 3_600_000) return hit.list;
      const raw = await call<{ code: string; name: string; work_time?: string; nearest_metro_station?: string; is_handout?: boolean; location?: { address?: string; latitude?: number; longitude?: number } }[]>('GET', `/deliverypoints?city_code=${cityCode}&type=PVZ`);
      const list = raw.filter((p) => p.is_handout !== false).map((p) => ({
        code: p.code, name: p.name, address: p.location?.address ?? p.name, workTime: p.work_time ?? '',
        metro: (p.nearest_metro_station ?? '').replace(/^ст\.?\s*м\.?\s*/i, '').trim(), lat: p.location?.latitude ?? null, lon: p.location?.longitude ?? null,
      }));
      list.sort((a, b) => a.address.localeCompare(b.address, 'ru'));
      pointCache.set(cityCode, { at: Date.now(), list });
      return list;
    },
    async quote(cityCode, mode, qty) {
      const r = await call<{ delivery_sum: number; period_min: number; period_max: number }>('POST', '/calculator/tariff', {
        tariff_code: TARIFF[mode], from_location: { code: cfg.CDEK_FROM_CITY }, to_location: { code: cityCode }, packages: [parcel(Math.max(1, qty))],
      });
      return { price: Math.ceil(r.delivery_sum / 10) * 10, daysMin: r.period_min, daysMax: r.period_max };
    },
    async createShipment(order, items) {
      const c = order.cdek;
      if (!c) throw new CdekError('в заказе нет данных СДЭК');
      if (!shipmentPoint) throw new CdekError('не задан CDEK_SHIPMENT_POINT — код пункта СДЭК, куда вы сдаёте посылки');
      const qty = items.reduce((a, i) => a + i.qty, 0);
      const r = await call<{ entity?: { uuid: string }; requests?: { state: string; errors?: { message: string }[] }[] }>('POST', '/orders', {
        type: 1, // интернет-магазин: the buyer has already paid, CDEK collects nothing on delivery
        number: order.no,
        tariff_code: TARIFF[c.mode],
        comment: order.comment || undefined,
        shipment_point: shipmentPoint,
        ...(c.mode === 'pvz' ? { delivery_point: c.pvzCode } : { to_location: { code: c.cityCode, address: order.address.replace(/^[^,]+,\s*/, '') } }),
        recipient: { name: order.name, phones: [{ number: order.phone }] },
        packages: [{
          number: '1', ...parcel(qty), comment: 'MRAK8',
          items: items.map((i) => ({ name: `${i.title} / ${i.sizeLabel}`, ware_key: `${i.productNo}-${i.sizeLabel}`, payment: { value: 0 }, cost: i.price, weight: Number(grams), amount: i.qty })),
        }],
      });
      const bad = r.requests?.find((q) => q.state === 'INVALID');
      if (bad || !r.entity?.uuid) throw new CdekError(bad?.errors?.map((e) => e.message).join('; ') || 'СДЭК не принял отправление');
      return { uuid: r.entity.uuid };
    },
    async shipment(uuid) {
      const r = await call<{ entity?: { cdek_number?: string; statuses?: { code: string; name: string; date_time: string }[] }; requests?: { state: string; errors?: { message: string }[] }[] }>('GET', `/orders/${uuid}`);
      const last = [...(r.entity?.statuses ?? [])].sort((a, b) => b.date_time.localeCompare(a.date_time))[0];
      const bad = r.requests?.find((q) => q.state === 'INVALID');
      return { number: r.entity?.cdek_number, status: last?.code, statusName: last?.name, error: bad?.errors?.map((e) => e.message).join('; ') };
    },
    async waybill(uuid) {
      const req = await call<{ entity?: { uuid: string } }>('POST', '/print/orders', { orders: [{ order_uuid: uuid }], copy_count: 2 });
      if (!req.entity?.uuid) throw new CdekError('СДЭК не начал печать накладной');
      for (let i = 0; i < 15; i++) {
        await new Promise((ok) => setTimeout(ok, 1000));
        const st = await call<{ entity?: { url?: string } }>('GET', `/print/orders/${req.entity.uuid}`);
        if (st.entity?.url) {
          // the bearer token goes only to CDEK itself, whatever url the response names
          const u = new URL(st.entity.url);
          if (u.protocol !== 'https:' || !/(^|\.)cdek\.ru$/.test(u.hostname)) throw new CdekError('СДЭК дал ссылку на накладную не на cdek.ru');
          const pdf = await fetch(st.entity.url, { headers: { authorization: `Bearer ${await auth()}` }, signal: AbortSignal.timeout(20_000) });
          if (!pdf.ok) throw new CdekError(`накладная не скачалась (${pdf.status})`);
          return Buffer.from(await pdf.arrayBuffer());
        }
      }
      throw new CdekError('СДЭК долго готовит накладную — попробуйте через минуту');
    },
  };
}

/** what the shop stores about the subject's choice before CDEK knows the order */
export const choiceTitle = (s: Pick<CdekShipment, 'mode'>) => (s.mode === 'pvz' ? 'СДЭК · пункт выдачи' : 'СДЭК · курьер');
