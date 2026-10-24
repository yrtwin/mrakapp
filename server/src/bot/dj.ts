/* DJ set from the chat: an admin sends an mp3 to the bot → it joins the playlist; /dj lists, reorders, deletes. */
import { InlineKeyboard, type Bot } from 'grammy';
import { addTrack, listTracks, moveUp, removeTrack } from '../services/dj.js';
import { analyseTrack } from '../services/djAnalyze.js';
import type { BotDeps } from './index.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function registerDj(bot: Bot, deps: BotDeps) {
  const { cfg, db, log } = deps;
  const isAdmin = (id?: number) => !!id && cfg.ADMIN_IDS.includes(id);

  const playlist = async () => {
    const list = await listTracks(db);
    const kb = new InlineKeyboard();
    list.forEach((t, i) => {
      kb.text(`${i + 1}. ${t.performer ? t.performer + ' — ' : ''}${t.title}${t.mix ? ` · ${Math.round(t.mix.bpm)} ${t.mix.key}` : ''}`.slice(0, 64), `dj:noop:${t.id}`).row();
      if (i > 0) kb.text('⬆ выше', `dj:up:${t.id}`);
      kb.text('✖ удалить', `dj:del:${t.id}`).row();
    });
    const text = list.length
      ? `<b>DJ SET · ${list.length} ${list.length === 1 ? 'трек' : 'треков'}</b>\nИграют по кругу в этом порядке. Новый трек — просто пришлите mp3 сюда.`
      : '<b>DJ SET пуст</b>\nПришлите сюда mp3 (как аудио или файлом) — он сразу заиграет в мини-аппе.';
    return { text, kb };
  };

  bot.command('dj', async (c) => {
    if (!isAdmin(c.from?.id)) return;
    const { text, kb } = await playlist();
    await c.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  });

  // an mp3 from an admin: sent as audio, or as a file with an audio type
  bot.on(['message:audio', 'message:document'], async (c, next) => {
    const a = c.message.audio ?? (c.message.document?.mime_type?.startsWith('audio/') ? c.message.document : undefined);
    if (!a || !isAdmin(c.from?.id)) return next();
    if ((a.file_size ?? 0) > 20 * 1024 * 1024) return c.reply('Файл больше 20 МБ: бот такие не скачивает. Сожмите до 128–192 кбит/с и пришлите снова.');
    const t = await addTrack(db, a as Parameters<typeof addTrack>[1]);
    if (!t) return c.reply('Этот трек уже в DJ-сете.');
    const total = (await listTracks(db)).length;
    await c.reply(`🎧 Добавлено в DJ-сет: <b>${esc(t.performer ? `${t.performer} — ${t.title}` : t.title)}</b>${t.duration ? ` (${mmss(t.duration)})` : ''}\nТреков в сете: ${total}. Разбираю темп и тональность для сведения… Плейлист — /dj`, { parse_mode: 'HTML' });
    // seconds of analysis in its own process; the chat gets the result when it is done
    if (cfg.NODE_ENV !== 'test') void analyseTrack(cfg, db, bot, t.id)
      .then((m) => c.reply(m ? `🎚 ${esc(t.title)}: ${Math.round(m.bpm)} BPM, ключ ${m.key} — будет сводиться в такт с соседними треками.` : `⚠️ ${esc(t.title)}: не смог разобрать темп — трек будет входить простым переходом.`, { parse_mode: 'HTML' }))
      .catch((e) => log.warn({ err: e }, 'dj analysis failed'));
  });

  bot.callbackQuery(/^dj:(del|up|noop):(\d+)$/, async (c) => {
    if (!isAdmin(c.from.id)) return c.answerCallbackQuery({ text: 'Только для дежурных' });
    const [, act, id] = c.match;
    if (act === 'del') await removeTrack(cfg, db, Number(id));
    if (act === 'up') await moveUp(db, Number(id));
    await c.answerCallbackQuery(act === 'del' ? { text: 'Трек удалён' } : act === 'up' ? { text: 'Поднят выше' } : {});
    if (act === 'noop') return;
    const { text, kb } = await playlist();
    await c.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  });
}
