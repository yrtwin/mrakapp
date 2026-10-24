import { useEffect, useRef, useState } from 'react';
import { CATEGORY_LABEL, formatRub, MAX_PER_SIZE, type ApiHotspot, type ApiImage, type ApiProduct, type ApiSize } from '@mrak8/shared';
import { api } from '../lib/api';
import { anim, done, flyToBag, reduced, scramble, slam } from '../lib/fx';
import { go } from '../lib/router';
import { cartTotal, set, sizeOf, stockOf, toast, useStore } from '../lib/store';
import { haptic } from '../lib/telegram';
import { Classified, Countdown, HChart, imgUrl, Picture, Tape } from '../components/brand';
import { useMainButton } from '../components/useMainButton';
import { StockTag, watchDrop } from './Catalog';

const RULER = { from: 150, to: 200, h: 320 };
type Side = 'front' | 'back';

function Face({ side, img, hot, title }: { side: Side; img: ApiImage; hot: ApiHotspot[]; title: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={`face face--${side}`}>
      <img className="lq" src={img.lqip} alt="" aria-hidden="true" onLoad={side === 'front' ? (e) => {
        // the photo box follows the front photo's proportions (see .flip in app.css)
        const i = e.currentTarget;
        if (i.naturalWidth && i.naturalHeight) i.closest<HTMLElement>('.flip')?.style.setProperty('--ar', (i.naturalWidth / i.naturalHeight).toFixed(4));
      } : undefined} />
      <Picture img={img} className={`hi ${loaded ? 'is-in' : ''}`} alt={`${title} — ${side === 'front' ? 'фас' : 'спина'}`} eager={side === 'front'} onLoad={() => setLoaded(true)} />
      {hot.map((m, i) => (
        <button key={i} className="mark" type="button" data-hot={`${side}:${i}`} style={{ left: `${m.x}%`, top: `${m.y}%` }} aria-label={`Деталь ${m.n ?? i + 1}: ${m.t}`}>{m.n ?? i + 1}</button>
      ))}
    </div>
  );
}

/** swipe-flip ФАС/СПИНА in 3D, evidence markers and the loupe with a caption */
function wireHero(hero: HTMLElement, p: ApiProduct) {
  const inner = hero.querySelector<HTMLElement>('.flip__in')!, loupe = hero.querySelector<HTMLElement>('.loupe')!, line = hero.querySelector<HTMLElement>('.loupe__line')!;
  const glass = loupe.querySelector<HTMLElement>('.loupe__glass')!, cap = loupe.querySelector<HTMLElement>('.loupe__cap')!;
  const hasBack = !!p.images.back;
  let face: Side = 'front', ry = 0, start: { x: number; y: number; ry: number } | null = null, moved = false;
  const closeLoupe = () => {
    loupe.classList.remove('is-on');
    line.getAnimations().forEach((a) => a.cancel());
    line.style.opacity = '0';
    hero.querySelectorAll('.mark').forEach((m) => m.classList.remove('is-on'));
  };
  const setFace = (f: Side, animate = true) => {
    if (f === 'back' && !hasBack) f = 'front';
    if (f !== face) haptic.select();
    face = f;
    hero.dataset.face = f;
    inner.classList.toggle('is-anim', animate);
    // the nearest angle that shows this face: a released swipe finishes its own turn instead of unwinding
    // back through the other side (that was the 1.5-turn spin), and the ФАС/СПИНА buttons always turn forward
    const base = f === 'front' ? 0 : 180;
    ry = base + 360 * Math.round((ry - base) / 360);
    inner.style.setProperty('--ry', ry + 'deg');
    hero.querySelectorAll<HTMLElement>('.facesw button').forEach((b) => b.classList.toggle('is-on', b.dataset.face === f));
    scramble(hero.querySelector('[data-placard]'), `#${p.no} · ${f === 'front' ? 'ФАС' : 'СПИНА'}`, 240);
    closeLoupe();
  };
  const openLoupe = (side: Side, x: number, y: number, title: string, sub: string) => {
    const img = p.images[side];
    if (!img) return;
    const fr = hero.querySelector('.flip')!.getBoundingClientRect(), hr = hero.getBoundingClientRect();
    // the photo box has the photo's proportions, so x / y in % map straight onto the photo
    const W = fr.width, H = fr.height, Z = 3.2, G = 156;
    glass.style.backgroundImage = `url(${imgUrl(img, 2400)}), url(${imgUrl(img, 1200)})`;
    glass.style.backgroundSize = `${W * Z}px ${H * Z}px`;
    glass.style.backgroundPosition = `${G / 2 - (x / 100) * W * Z}px ${G / 2 - (y / 100) * H * Z}px`;
    cap.innerHTML = '';
    cap.append(`ФИГ. ${title}`);
    const span = document.createElement('span');
    span.textContent = `${sub} · УВЕЛ. ×${Z}`;
    cap.append(span);
    const px = fr.left - hr.left + (x / 100) * W, py = fr.top - hr.top + (y / 100) * H;
    const left = px > hr.width / 2 ? Math.max(8, px - G - 44) : Math.min(hr.width - G - 8, px + 44);
    const top = Math.max(8, Math.min(py - G / 2, hr.height - G - 70));
    loupe.style.left = left + 'px';
    loupe.style.top = top + 'px';
    loupe.style.setProperty('--ox', px - left + 'px');
    loupe.style.setProperty('--oy', py - top + 'px');
    loupe.classList.add('is-on');
    const lx = px > hr.width / 2 ? left + G : left, ly = top + G / 2;
    const ang = Math.atan2(ly - py, lx - px);
    line.style.left = px + 'px';
    line.style.top = py + 'px';
    line.style.width = Math.hypot(lx - px, ly - py) + 'px';
    anim(line, [{ opacity: 0, transform: `rotate(${ang}rad) scaleX(0)` }, { opacity: 1, transform: `rotate(${ang}rad) scaleX(1)` }], { duration: 220, fill: 'forwards', easing: 'cubic-bezier(.16,1,.3,1)' });
    haptic.impact('soft');
  };
  const down = (ev: PointerEvent) => {
    if ((ev.target as Element).closest('.facesw, .placard')) return;
    start = { x: ev.clientX, y: ev.clientY, ry };
    moved = false;
    inner.classList.remove('is-anim');
  };
  const move = (ev: PointerEvent) => {
    if (!start || !hasBack) return;
    const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
    if (!moved && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { moved = true; closeLoupe(); hero.classList.add('is-turning'); hero.setPointerCapture(ev.pointerId); }
    if (moved) { ry = start.ry + dx * 0.55; inner.style.setProperty('--ry', ry + 'deg'); inner.style.setProperty('--rx', Math.max(-6, Math.min(6, -dy * 0.05)) + 'deg'); }
  };
  const up = (ev: PointerEvent) => {
    if (!start) return;
    const dx = ev.clientX - start.x;
    inner.style.setProperty('--rx', '0deg');
    hero.classList.remove('is-turning');
    const t = ev.target as Element;
    if (moved) setFace(Math.abs(dx) > 60 ? (face === 'front' ? 'back' : 'front') : face);
    else {
      const mk = t.closest<HTMLElement>('.mark');
      if (mk) {
        const [side, i] = mk.dataset.hot!.split(':') as [Side, string];
        const hs = p.hotspots[side][+i];
        const was = mk.classList.contains('is-on');
        closeLoupe();
        if (!was) { mk.classList.add('is-on'); openLoupe(side, hs.fx ?? hs.x, hs.fy ?? hs.y, `${hs.n ?? +i + 1} — ${hs.t}`, hs.s); }
      } else if (t.closest('.face')) {
        const fr = hero.querySelector('.flip')!.getBoundingClientRect();
        const x = ((ev.clientX - fr.left) / fr.width) * 100, y = ((ev.clientY - fr.top) / fr.height) * 100;
        if (loupe.classList.contains('is-on')) closeLoupe();
        else if (x > 0 && x < 100 && y > 0 && y < 100) openLoupe(face, x, y, `УЧАСТОК ${Math.round(x)}/${Math.round(y)}`, face === 'front' ? 'ФАС' : 'СПИНА');
      } else closeLoupe();
    }
    start = null;
  };
  const cancel = () => { hero.classList.remove('is-turning'); if (start) { setFace(face); start = null; } };
  const sw = (ev: Event) => { const b = (ev.target as Element).closest<HTMLElement>('.facesw button'); if (b) { ev.stopPropagation(); setFace(b.dataset.face as Side); } };
  hero.addEventListener('pointerdown', down);
  hero.addEventListener('pointermove', move);
  hero.addEventListener('pointerup', up);
  hero.addEventListener('pointercancel', cancel);
  hero.addEventListener('click', sw);
  return () => {
    hero.removeEventListener('pointerdown', down);
    hero.removeEventListener('pointermove', move);
    hero.removeEventListener('pointerup', up);
    hero.removeEventListener('pointercancel', cancel);
    hero.removeEventListener('click', sw);
  };
}

function Sizer({ p, size, onSize }: { p: ApiProduct; size: string | null; onSize: (s: string) => void }) {
  const { from, to, h: H } = RULER;
  const y = (v: number) => ((to - v) / (to - from)) * H;
  const ruler = useRef<HTMLDivElement>(null);
  const sized = p.sizes.filter((s) => s.heightMin != null && s.heightMax != null);
  const cur = size ? sizeOf(p, size) : undefined;

  useEffect(() => {
    const el = ruler.current;
    if (!el || !sized.length) return;
    const mark = el.querySelector<HTMLElement>('.ruler__mark')!, hOut = el.querySelector<HTMLElement>('[data-h]')!;
    const bandOf = (v: number) => sized.find((s) => v >= s.heightMin! && v < s.heightMax!) ?? (v >= sized[sized.length - 1].heightMax! ? sized[sized.length - 1] : sized[0]);
    const center = (s: ApiSize) => Math.round((s.heightMin! + s.heightMax!) / 2);
    const nearestAvail = (v: number) => sized.filter((s) => s.available > 0).sort((a, b) => Math.abs(center(a) - v) - Math.abs(center(b) - v))[0];
    let hgt = useStore.getState().height ?? 176, curSize: string | null = null, lastTick = 0, lastCm: number | null = null, drag = false;
    const render = (v: number, snap = false) => {
      hgt = v;
      mark.style.transition = snap && !reduced ? 'transform .45s cubic-bezier(.3,1.5,.5,1)' : 'none';
      mark.style.setProperty('--y', y(v) + 'px');
      hOut.textContent = String(v);
      const hr = el.closest('.sizer')?.querySelector('[data-r="h"]');
      if (hr) hr.textContent = `${v} СМ`;
      const b = bandOf(v);
      el.setAttribute('aria-valuenow', String(v));
      el.setAttribute('aria-valuetext', `${v} см, размер ${b.label}${b.available ? '' : ' — нет в наличии'}`);
      el.querySelectorAll<HTMLElement>('.ruler__band').forEach((n) => n.classList.toggle('is-on', n.dataset.band === b.label));
      if (b.label !== curSize) {
        curSize = b.label;
        if (b.available) onSize(b.label);
        return true;
      }
      return false;
    };
    const commit = () => {
      const b = bandOf(hgt);
      if (!b.available) {
        const n = nearestAvail(hgt);
        if (n) {
          haptic.notify('warning');
          toast(`${b.label} — ИЗЪЯТ ДРУГИМ СУБЪЕКТОМ. ПРЕДЛАГАЕМ ${n.label}`);
          render(center(n), true);
        }
      }
      set({ height: hgt });
      api.setHeight(hgt).catch(() => {});
    };
    const fromY = (clientY: number) => { const r = el.getBoundingClientRect(); return Math.round(Math.max(from, Math.min(to - 1, to - ((clientY - r.top) / r.height) * (to - from)))); };
    const move = (ev: PointerEvent) => {
      if (!drag) return;
      const v = fromY(ev.clientY);
      if (v === lastCm) return;
      lastCm = v;
      if (render(v)) haptic.impact('light');
      else if (performance.now() - lastTick > 34) { haptic.select(); lastTick = performance.now(); }
    };
    const downH = (ev: PointerEvent) => { drag = true; el.classList.add('is-drag'); el.setPointerCapture(ev.pointerId); move(ev); };
    const upH = () => { if (!drag) return; drag = false; el.classList.remove('is-drag'); commit(); };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') { ev.preventDefault(); render(Math.max(from, Math.min(to - 1, hgt + (ev.key === 'ArrowUp' ? 1 : -1)))); haptic.select(); }
      if (ev.key === 'Enter') commit();
    };
    const btn = (ev: Event) => {
      const b = (ev.target as Element).closest<HTMLButtonElement>('[data-s]');
      if (!b || b.disabled) return;
      const s = sizeOf(p, b.dataset.s!);
      if (!s || s.heightMin == null) { onSize(b.dataset.s!); return; }
      haptic.select();
      render(center(s), true);
      set({ height: center(s) });
    };
    el.addEventListener('pointerdown', downH);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', upH);
    el.addEventListener('pointercancel', upH);
    el.addEventListener('keydown', key);
    const btns = el.parentElement!.parentElement!.querySelector('.sizebtns');
    btns?.addEventListener('click', btn);
    const b0 = bandOf(hgt);
    render(b0.available ? hgt : center(nearestAvail(hgt) ?? b0));
    return () => {
      el.removeEventListener('pointerdown', downH);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', upH);
      el.removeEventListener('pointercancel', upH);
      el.removeEventListener('keydown', key);
      btns?.removeEventListener('click', btn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id]);

  const big = useRef<HTMLElement>(null);
  useEffect(() => { if (cur) scramble(big.current, cur.label, 200); }, [cur?.label]);
  const me = useStore((s) => s.boot?.me);
  const height = useStore((s) => s.height);
  const ticks: React.ReactElement[] = [];
  for (let v = from; v <= to; v++) {
    const yy = y(v) + 0.5, maj = v % 5 === 0, lab = v % 10 === 0;
    ticks.push(<line key={v} x1="0" x2={lab ? 26 : maj ? 16 : 8} y1={yy} y2={yy} stroke="#8A8680" strokeOpacity={lab ? 0.9 : maj ? 0.6 : 0.32} />);
    if (lab && v !== from && v !== to) ticks.push(<text key={'t' + v} x="2" y={yy - 3} fill="#8A8680" fontFamily="JetBrains Mono Variable, monospace" fontSize="8" fontWeight="600">{v}</text>);
  }
  return (
    <section className="sizer" aria-label="Подбор размера">
      <div className="sec-h"><span className="label"><b>02</b> · РАЗМЕР ПО РОСТОМЕРУ</span><span className="label">ТЯНИ МЕТКУ ↕</span></div>
      <div className="sizer__body">
        <div className="ruler" ref={ruler} role="slider" tabIndex={0} aria-label="Ваш рост, см" aria-valuemin={from} aria-valuemax={to}>
          <div className="ruler__ticks"><svg width="100%" height={H} aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>{ticks}</svg></div>
          {sized.map((s) => (
            <div key={s.label} className={`ruler__band ${s.available ? '' : 'is-out'}`} data-band={s.label} style={{ top: y(s.heightMax!), height: y(s.heightMin!) - y(s.heightMax!) }}>
              <b>{s.label}</b><small>{s.heightMin}–{s.heightMax}</small>
            </div>
          ))}
          <div className="ruler__mark"><div className="ruler__handle"><span data-h>176</span><span>СМ</span></div></div>
        </div>
        <div className="readout">
          <div className="big"><b ref={big}>{cur?.label ?? '—'}</b><span>РАЗМЕР<br />ПО РОСТУ</span></div>
          <dl>
            <div className="kv"><dt>РОСТ</dt><dd data-r="h">{height ?? '—'} СМ</dd></div>
            <div className="kv"><dt>ДЛИНА</dt><dd>{cur?.length ?? '—'} СМ</dd></div>
            <div className="kv"><dt>ШИРИНА</dt><dd>{cur?.width ?? '—'} СМ</dd></div>
            <div className="kv"><dt>РУКАВ</dt><dd>{cur?.sleeve ?? '—'} СМ</dd></div>
            <div className={`kv ${cur && cur.available <= 3 ? 'stock-low' : ''}`}><dt>ОСТАТОК</dt><dd>{cur ? (cur.available ? `${cur.available} ШТ` : 'ИЗЪЯТ') : '—'}</dd></div>
          </dl>
          <div className="remember">РОСТ ПОДШИВАЕТСЯ К ДЕЛУ #{me?.subjectNo}</div>
        </div>
      </div>
      <div className="sizebtns" role="group" aria-label="Размер" style={{ gridTemplateColumns: `repeat(${p.sizes.length}, 1fr)` }}>
        {p.sizes.map((s) => <button key={s.label} type="button" data-s={s.label} className={size === s.label ? 'is-on' : ''} disabled={!s.available} aria-disabled={!s.available}>{s.label}</button>)}
      </div>
      <div className="sizer__hint"><span>ЗАМЕРЫ ИЗДЕЛИЯ, СМ · ПО ПЛОСКОСТИ</span>{p.todo?.includes('sizes') && <span className="todo">TODO: СЕТКА</span>}</div>
    </section>
  );
}

export function CaseScreen({ id }: { id: string }) {
  const p = useStore((s) => s.boot?.products.find((x) => String(x.id) === id || x.no === id));
  const cart = useStore((s) => s.cart);
  const [size, setSize] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hero = useRef<HTMLDivElement>(null);

  // the hero scan line runs until the hi-res photo is in
  useEffect(() => {
    const h = hero.current;
    if (!h || !p) return;
    const scan = h.querySelector('.scanline'), flip = h.querySelector<HTMLElement>('.flip')!;
    // bounding rects, not offsetTop: the photo box is centred with a transform
    const end = () => flip.getBoundingClientRect().bottom - h.getBoundingClientRect().top;
    const sweep = (n: number) => anim(scan, [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 1, transform: `translateY(${end()}px)`, offset: 0.92 }, { opacity: 0, transform: `translateY(${end()}px)` }], { duration: 900, easing: 'cubic-bezier(.65,0,.35,1)', iterations: n });
    const s = sweep(Infinity);
    const hi = h.querySelector<HTMLImageElement>('.face--front .hi');
    const fin = () => { s.cancel(); sweep(1); };
    if (!hi || (hi.complete && hi.naturalWidth)) fin(); else hi.addEventListener('load', fin, { once: true });
    const sw = setTimeout(() => h.querySelector('.hero__swipe')?.classList.add('is-on'), 900);
    const off = p.images.front ? wireHero(h, p) : () => {};
    return () => { s.cancel(); clearTimeout(sw); off(); };
  }, [p?.id]);

  const inCart = !!p && !!size && cart.some((c) => c.productId === p.id && c.size === size);
  const seize = async () => {
    if (!p || !size || busy) return;
    const sz = sizeOf(p, size);
    const held = cart.find((c) => c.productId === p.id && c.size === size)?.qty ?? 0;
    if (!sz || sz.available - held <= 0) { haptic.notify('error'); toast('РАЗМЕР ИЗЪЯТ ДРУГИМ СУБЪЕКТОМ'); return; }
    if (held >= MAX_PER_SIZE) { haptic.notify('error'); toast(`НЕ БОЛЬШЕ ${MAX_PER_SIZE} ШТ ОДНОГО РАЗМЕРА`); return; }
    setBusy(true);
    const h = hero.current!;
    const face = (h.dataset.face as Side) || 'front';
    const st = await slam(h, 'ИЗЪЯТО', { sub: `ВЕЩДОК #${p.no} · РАЗМЕР ${size}`, rot: -10, cls: 'dstamp', w: 300, h: 100 });
    set((s) => {
      const c = s.cart.map((x) => ({ ...x }));
      const row = c.find((x) => x.productId === p.id && x.size === size);
      if (row) row.qty += 1; else c.push({ productId: p.id, size, qty: 1 });
      return { cart: c };
    });
    const img = p.images[face] ?? p.images.front;
    if (img) await flyToBag(h.querySelector(`.face--${face} .hi`), imgUrl(img, 360));
    setBusy(false);
    setTimeout(() => void done(anim(st, [{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: 'forwards' }), 500).then(() => st.remove()), 900);
  };

  const live = p?.status === 'live' && stockOf(p) > 0;
  useMainButton(
    !p ? null
      : p.status === 'drop' ? { text: p.watching ? 'ВЫ НА НАБЛЮДЕНИИ ●' : 'УВЕДОМИТЬ МЕНЯ О ДРОПЕ', color: p.watching ? '#1C1C1C' : '#E0241B', textColor: p.watching ? '#F1ECE1' : '#FFFFFF', shine: !p.watching, onClick: () => void watchDrop(p) }
      : !live ? { text: 'УВЕДОМИТЬ О НОВОЙ ПАРТИИ', color: '#1C1C1C', textColor: '#F1ECE1', onClick: () => { haptic.notify('success'); toast('ВЫ В СПИСКЕ НАБЛЮДЕНИЯ'); } }
      : inCart ? { text: `ОФОРМИТЬ ЗАКАЗ — ${formatRub(cartTotal(cart))}`, onClick: () => { haptic.impact('medium'); go('#/protocol'); } }
      : { text: `ИЗЪЯТЬ — ${formatRub(p.price)}`, shine: true, active: !busy && !!size, onClick: () => void seize() },
    p && live && inCart ? { text: 'ЕЩЁ ВЕЩДОКИ', onClick: () => { haptic.impact('light'); go('#/'); } } : null,
  );

  if (!p) return <section className="screen"><div className="empty"><h2 className="display">Дело не найдено</h2><p>Вещдок снят с учёта или ещё засекречен.</p><button className="btn" onClick={() => go('#/')}>К вещдокам</button></div></section>;
  const today = new Date().toLocaleDateString('ru-RU');
  return (
    <section className="screen dossier" aria-label={p.title}>
      <div className="hero" ref={hero} data-face="front">
        <HChart from={150} to={200} strong={0.2} weak={0.08} labels={[150, 200, 10]} />
        <div className="hero__num" aria-hidden="true">#{p.no}</div>
        <div className="flip">
          <div className="flip__in">
            {p.images.front ? <Face side="front" img={p.images.front} hot={p.hotspots.front} title={p.title} /> : <div className="face face--front"><Classified /></div>}
            {p.images.back && <Face side="back" img={p.images.back} hot={p.hotspots.back} title={p.title} />}
          </div>
        </div>
        <div className="scanline" />
        <div className="loupe__line" />
        <div className="loupe" aria-hidden="true"><div className="loupe__glass" /><div className="loupe__cap" /></div>
        {p.images.back && <div className="hero__swipe">← СВАЙП — ПОВЕРНУТЬ ВЕЩДОК →</div>}
        <div className="hero__ui">
          {p.images.back ? <div className="facesw" role="group" aria-label="Ракурс"><button type="button" data-face="front" className="is-on">ФАС</button><button type="button" data-face="back">СПИНА</button></div> : <span />}
          <div className="placard"><span>MRAK8 · ВЕЩДОК</span><b data-placard>#{p.no} · ФАС</b><span>{today}</span></div>
        </div>
      </div>
      <div className="dtitle">
        <span className="label">ДЕЛО #{p.no} · {CATEGORY_LABEL[p.category]}{p.batch ? ` · ПАРТИЯ ${p.batch}` : ''} · {p.sig}</span>
        <h1 className="display">{p.name || p.title}<br />{p.sub}</h1>
        <div className="row"><span className="price">{formatRub(p.price)}{p.oldPrice ? <s>{formatRub(p.oldPrice)}</s> : null}{p.todo?.includes('price') && <span className="todo">TODO</span>}</span><StockTag p={p} /></div>
        {p.status === 'drop' && p.dropAt && <Countdown to={p.dropAt} />}
        {!live && p.status !== 'drop' && <p className="case__note">Вещдок изъят другим субъектом. Следующая партия — по решению центра.</p>}
      </div>
      <Tape />
      {live && <Sizer p={p} size={size} onSize={setSize} />}
      <section className="proto">
        <div className="proto__h"><h2>Протокол осмотра</h2><span className="label">ФОРМА 8-ОСМ</span></div>
        <dl>{p.proto.map((r) => <div className="kv" key={r.k}><dt>{r.k}</dt><dd>{r.v}{r.todo && <span className="todo">TODO</span>}</dd></div>)}</dl>
        <p className="proto__note">Вещдок выдаётся после оформления протокола. Срок этапирования 1–3 дня. Возврат — 7 дней после получения, если вещь не носили (см. оферту).</p>
      </section>
      <Tape text={`MRAK8 CENTRAL BOOKING & INTAKE CENTER · ДЕЛО #${p.no}`} cls="tape--dark" speed={30} />
      <div style={{ height: 24 }} />
    </section>
  );
}
