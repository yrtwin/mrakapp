import type { ApiAdminDashboard, ApiDjTrack, ApiAdminOrder, ApiAdminProduct, ApiAdminProductInput, ApiBootstrap, ApiDelivery, ApiImage, ApiOrder, CdekCity, CdekMode, CdekPoint, CdekQuote, CreateOrderBody, CreateOrderResult, OrderStatus } from '@mrak8/shared';
import { devUserHeader, emulated, initData } from './telegram';

const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const headers = (): Record<string, string> => (initData ? { authorization: `tma ${initData}` } : emulated ? { 'x-dev-user': devUserHeader } : {});

async function call<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { ...headers(), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'OFFLINE', 'Связь с центром потеряна');
  }
  if (!res.ok) {
    let j: { error?: string; message?: string } = {};
    try { j = await res.json(); } catch { /* not json */ }
    throw new ApiError(res.status, j.error || 'HTTP_' + res.status, j.message || 'Ошибка центра оформления');
  }
  return (raw ? res.blob() : res.json()) as Promise<T>;
}

export const api = {
  bootstrap: () => call<ApiBootstrap>('GET', '/api/bootstrap'),
  setHeight: (height: number) => call('POST', '/api/me/height', { height }),
  createOrder: (b: CreateOrderBody) => call<CreateOrderResult>('POST', '/api/orders', b),
  orders: () => call<ApiOrder[]>('GET', '/api/orders'),
  order: (no: string) => call<ApiOrder>('GET', `/api/orders/${no}`),
  cancelOrder: (no: string) => call('POST', `/api/orders/${no}/cancel`),
  devPay: (no: string) => call<ApiOrder>('POST', `/api/dev/pay/${no}`),
  dj: () => call<ApiDjTrack[]>('GET', '/api/dj'),
  cdekCities: (q: string) => call<CdekCity[]>('GET', `/api/cdek/cities?q=${encodeURIComponent(q)}`),
  cdekPoints: (city: number) => call<CdekPoint[]>('GET', `/api/cdek/points?city=${city}`),
  cdekQuote: (city: number, mode: CdekMode, qty: number) => call<CdekQuote>('GET', `/api/cdek/quote?city=${city}&mode=${mode}&qty=${qty}`),
  watch: (productId: number, on: boolean) => call('POST', `/api/drops/${productId}/watch`, { on }),
  share: (no: string) => call<{ id: string }>('POST', `/api/share/${no}`),
  admin: {
    dashboard: () => call<ApiAdminDashboard>('GET', '/api/admin/dashboard'),
    products: () => call<ApiAdminProduct[]>('GET', '/api/admin/products'),
    product: (id: number) => call<ApiAdminProduct>('GET', `/api/admin/products/${id}`),
    create: (p: ApiAdminProductInput) => call<ApiAdminProduct>('POST', '/api/admin/products', p),
    update: (id: number, p: ApiAdminProductInput) => call<ApiAdminProduct>('PUT', `/api/admin/products/${id}`, p),
    remove: (id: number) => call<{ ok: boolean; archived: boolean }>('DELETE', `/api/admin/products/${id}`),
    upload: (id: number, file: File, slot: string, crop: string, cutout: boolean) => {
      const fd = new FormData();
      fd.append('slot', slot);
      fd.append('crop', crop);
      fd.append('cutout', cutout ? 'black' : 'none');
      fd.append('file', file);
      return call<ApiImage>('POST', `/api/admin/products/${id}/images`, fd);
    },
    removeImage: (imageId: number) => call('DELETE', `/api/admin/images/${imageId}`),
    announce: (id: number) => call<{ ok: boolean }>('POST', `/api/admin/products/${id}/announce`, {}),
    orders: (status?: OrderStatus | '', q?: string) => call<ApiAdminOrder[]>('GET', `/api/admin/orders?status=${status || ''}&q=${encodeURIComponent(q || '')}`),
    patchOrder: (no: string, p: { status?: OrderStatus; trackNo?: string | null }) => call<ApiAdminOrder & { notified: boolean }>('PATCH', `/api/admin/orders/${no}`, p),
    exportToChat: () => call<{ ok: boolean }>('POST', '/api/admin/orders/export'),
    cdekShip: (no: string) => call<ApiAdminOrder>('POST', `/api/admin/orders/${no}/cdek`, {}),
    cdekWaybill: (no: string) => call<{ ok: boolean }>('POST', `/api/admin/orders/${no}/waybill`, {}),
    csv: () => call<Blob>('GET', '/api/admin/orders.csv', undefined, true),
    delivery: () => call<(ApiDelivery & { active: boolean })[]>('GET', '/api/admin/delivery'),
    saveDelivery: (list: (ApiDelivery & { active: boolean })[]) => call('PUT', '/api/admin/delivery', list),
    drops: () => call<{ id: number; no: string; title: string; dropAt: string | null; watchers: number }[]>('GET', '/api/admin/drops'),
  },
};
