import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal stand-in for https://api.telegram.org — records every call, answers like Telegram would. */
export interface Call { method: string; body: Record<string, any>; test: boolean }

export async function startFakeBotApi() {
  const calls: Call[] = [];
  const failures: Record<string, object[]> = {}; // method → queued Bot API errors, e.g. a 429 with retry_after
  const slow: Record<string, number> = {}; // method → ms to wait before answering
  const now = () => Math.floor(Date.now() / 1000);
  let mid = 100;
  const handlers: Record<string, (b: Record<string, any>) => unknown> = {
    getMe: () => ({ id: 777000123, is_bot: true, first_name: 'MRAK8', username: 'mrak8_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true }),
    createInvoiceLink: (b) => `https://t.me/$invoice-${b.payload}`,
    sendMessage: (b) => ({ message_id: ++mid, date: now(), chat: { id: Number(b.chat_id) || 0, type: 'private' }, text: b.text }),
    sendPhoto: (b) => ({ message_id: ++mid, date: now(), chat: { id: 0, type: 'channel', title: String(b.chat_id ?? '') }, photo: [] }),
    answerPreCheckoutQuery: () => true,
    getFile: (b) => ({ file_id: b.file_id, file_unique_id: 'u-' + b.file_id, file_path: 'music/file_1.mp3' }),
    savePreparedInlineMessage: () => ({ id: 'prep-1', expiration_date: now() + 3600 }),
  };
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };
  const server = createServer(async (req, res) => {
    if ((req.url || '').startsWith('/file/')) { res.end(Buffer.from('ID3-fake-mp3-bytes')); return; } // Bot API file download
    // test environment calls look like /bot<token>/test/<method>
    const [, test, method = ''] = (req.url || '').match(/^\/bot[^/]+\/(test\/)?(\w+)/) ?? [];
    const raw = await read(req);
    const ct = String(req.headers['content-type'] || '');
    let body: Record<string, any> = {};
    if (ct.includes('json')) body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    else if (ct.includes('multipart')) {
      // pull simple text fields out of the multipart body (enough for assertions)
      const text = raw.toString('latin1');
      for (const m of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) body[m[1]] = Buffer.from(m[2], 'latin1').toString('utf8');
      body.__multipart = raw.length;
    }
    calls.push({ method, body, test: !!test });
    if (slow[method]) await new Promise((r) => setTimeout(r, slow[method]));
    const failure = failures[method]?.shift();
    if (failure) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, ...failure })); return; }
    const result = handlers[method] ? handlers[method](body) : true;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    of: (method: string) => calls.filter((c) => c.method === method),
    failNext: (method: string, error: { error_code: number; description: string; parameters?: object }) => (failures[method] ??= []).push(error),
    slow,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
