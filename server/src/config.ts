import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const ids = z
  .string()
  .default('')
  .transform((s) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite));
const optNum = z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number().optional());

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(8080),
  /** public https url of this backend (webhook + local media). e.g. https://api.mrak8.ru */
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  /** where the mini app (web/dist) is served. e.g. https://app.mrak8.ru */
  WEBAPP_URL: z.string().default('http://localhost:5173'),
  /** direct mini app link for channels and deep links: https://t.me/<bot>/<app> or https://t.me/<bot> (main mini app) */
  MINIAPP_LINK: z.string().default('https://t.me/mrak8_bot/shop'),
  CORS_ORIGINS: z.string().default(''),
  SERVE_WEB: bool.default(false),
  /** a tunnel writes its current https address here (docker:public); once it answers, the mini app moves to it */
  PUBLIC_URL_FILE: z.string().default(''),

  BOT_TOKEN: z.string().default(''),
  BOT_MODE: z.enum(['webhook', 'polling', 'off', 'auto']).default('auto'),
  WEBHOOK_SECRET: z.string().default(''),
  /** override Bot API root (tests / local bot api server) */
  BOT_API_ROOT: z.string().default('https://api.telegram.org'),
  /** if Telegram is only reachable through a VPN/proxy on this machine: http://127.0.0.1:10809 */
  TELEGRAM_PROXY: z.string().default(''),
  /** test = Telegram's test environment (its own accounts and bots); there the mini app may be plain http, e.g. http://127.0.0.1:8088 */
  TELEGRAM_ENV: z.enum(['prod', 'test']).default('prod'),
  ADMIN_IDS: ids,
  ADMIN_CHAT_ID: z.string().default(''),
  CHANNEL_ID: z.string().default(''),

  PAYMENT_PROVIDER: z.enum(['yookassa', 'tbank', 'cloudpayments', 'none']).default('yookassa'),
  PAYMENT_PROVIDER_TOKEN: z.string().default(''),
  /** 54-ФЗ: vat_code from your provider's docs (YooKassa: 1 = без НДС). Ask your accountant. */
  RECEIPT_VAT_CODE: z.coerce.number().default(1),
  RECEIPT_TAX_SYSTEM_CODE: optNum,
  /** where the buyer's receipt goes: phone from the protocol form, or e-mail requested in Telegram's payment form */
  RECEIPT_CONTACT: z.enum(['phone', 'email']).default('phone'),
  RESERVE_MINUTES: z.coerce.number().default(15),

  /** СДЭК API: off — fixed delivery prices; test — CDEK's sandbox (nothing ships); live — CDEK_ACCOUNT/CDEK_SECURE */
  CDEK_MODE: z.enum(['off', 'test', 'live']).default('off'),
  CDEK_ACCOUNT: z.string().default(''),
  CDEK_SECURE: z.string().default(''),
  /** city code parcels leave from (44 — Москва) and the CDEK office they are dropped at */
  CDEK_FROM_CITY: z.coerce.number().default(44),
  CDEK_SHIPMENT_POINT: z.string().default(''),
  /** one packed item: grams:length x width x height (cm) */
  CDEK_PARCEL: z.string().regex(/^\d+:\d+x\d+x\d+$/).default('1000:35x25x10'),

  /** postgres://user:pass@host:5432/db — if empty, an embedded PGlite database is used (dev/tests) */
  DATABASE_URL: z.string().default(''),
  PGLITE_DIR: z.string().default('./data/pglite'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  MEDIA_DIR: z.string().default('./data/media'),
  /** public base url for uploaded media. local default: PUBLIC_URL/media */
  MEDIA_PUBLIC_URL: z.string().default(''),
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('ru-central1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_PUBLIC_URL: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool.default(false),

  /** non-production only: accept `X-Dev-User` instead of Telegram initData */
  DEV_AUTH: bool.default(false),
  INIT_DATA_MAX_AGE: z.coerce.number().default(86400),
});

export type Config = z.infer<typeof Schema> & { isProd: boolean; mediaPublicUrl: string; botEnabled: boolean; testPayments: boolean; webAppButtons: boolean; webAppLocal: boolean };

/** the .env.example placeholder is public: a webhook protected by it is not protected */
const SECRET_PLACEHOLDER = 'change-me-to-a-long-random-string';
/** Telegram allows A-Z a-z 0-9 _ - in secret_token; anything shorter than 32 chars is guessable */
export const weakWebhookSecret = (s: string) => s.length < 32 || s.length > 256 || !/^[A-Za-z0-9_-]+$/.test(s) || s === SECRET_PLACEHOLDER;
const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(u);

/** whether this user gets buttons that open the mini app */
export const canOpenWebApp = (cfg: Config, userId?: number) => cfg.webAppButtons && (!cfg.webAppLocal || (!!userId && cfg.ADMIN_IDS.includes(userId)));

const webFlags = (url: string, env: 'prod' | 'test') => ({
  // Telegram rejects web_app buttons and the menu button without https — except in the test environment
  webAppButtons: /^https:\/\//.test(url) || env === 'test',
  // the mini app is served from this computer (https://127.0.0.1): only the operators sitting at it can open it
  webAppLocal: env === 'prod' && /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url),
});

/** the backend and the mini app moved to a new public address (a tunnel reconnected) */
export function setPublicUrl(cfg: Config, url: string) {
  cfg.PUBLIC_URL = cfg.WEBAPP_URL = url;
  Object.assign(cfg, webFlags(url, cfg.TELEGRAM_ENV));
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error('Invalid environment:\n' + msg);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === 'production';
  if (isProd) {
    const missing = ['BOT_TOKEN', 'WEBAPP_URL', 'PUBLIC_URL'].filter((k) => !(c as Record<string, unknown>)[k]);
    if (missing.length) throw new Error('Missing required env in production: ' + missing.join(', '));
    if (c.DEV_AUTH) throw new Error('DEV_AUTH must be off in production');
    // without the secret anyone can post updates to /telegram/webhook as any user, the admins included
    if (c.BOT_TOKEN && c.BOT_MODE !== 'polling' && c.BOT_MODE !== 'off' && weakWebhookSecret(c.WEBHOOK_SECRET)) {
      throw new Error('WEBHOOK_SECRET must be 32–256 random chars [A-Za-z0-9_-] in production (openssl rand -hex 32)');
    }
    if (!c.DATABASE_URL) console.warn('[config] DATABASE_URL is empty: using embedded PGlite in production is not recommended');
  }
  // DEV_AUTH lets anyone act as anyone and pay without money: only on this computer, whatever NODE_ENV says
  if (c.DEV_AUTH && c.NODE_ENV !== 'test' && !isLocalUrl(c.PUBLIC_URL)) throw new Error('DEV_AUTH=1 is only allowed with a localhost PUBLIC_URL');
  const mediaPublicUrl = (c.STORAGE_DRIVER === 's3' ? c.S3_PUBLIC_URL : c.MEDIA_PUBLIC_URL || `${c.PUBLIC_URL.replace(/\/$/, '')}/media`).replace(/\/$/, '');
  return {
    ...c,
    isProd,
    mediaPublicUrl,
    botEnabled: !!c.BOT_TOKEN && c.BOT_MODE !== 'off',
    testPayments: /:TEST:/.test(c.PAYMENT_PROVIDER_TOKEN),
    ...webFlags(c.WEBAPP_URL, c.TELEGRAM_ENV),
  };
}
