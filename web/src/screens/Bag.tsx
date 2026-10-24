import { useEffect, useRef } from 'react';
import { formatRub, MAX_PER_SIZE } from '@mrak8/shared';
import { anim, done, strikePath, wait } from '../lib/fx';
import { go } from '../lib/router';
import { cartCount, cartTotal, productById, set, sizeOf, toast, useStore, type CartLine } from '../lib/store';
import { haptic } from '../lib/telegram';
import { Classified, Clock, Logo, imgUrl } from '../components/brand';
import { useMainButton } from '../components/useMainButton';

function Row({ line, i, onRemove }: { line: CartLine; i: number; onRemove: (row: HTMLElement) => void }) {
  const p = productById(line.productId);
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const r = row.current!, inn = r.querySelector<HTMLElement>('.irow__in')!;
    let x0: number | null = null, dx = 0;
    const down = (ev: PointerEvent) => { if ((ev.target as Element).closest('button')) return; x0 = ev.clientX; dx = 0; inn.style.transition = 'none'; };
    const move = (ev: PointerEvent) => { if (x0 == null) return; dx = Math.min(0, ev.clientX - x0); if (dx < -6) inn.setPointerCapture(ev.pointerId); inn.style.transform = `translateX(${Math.max(dx, -120)}px)`; };
    const end = () => { if (x0 == null) return; x0 = null; inn.style.transition = 'transform .25s cubic-bezier(.16,1,.3,1)'; if (dx < -84) onRemove(r); else inn.style.transform = ''; };
    inn.addEventListener('pointerdown', down);
    inn.addEventListener('pointermove', move);
    inn.addEventListener('pointerup', end);
    inn.addEventListener('pointercancel', end);
    return () => { inn.removeEventListener('pointerdown', down); inn.removeEventListener('pointermove', move); inn.removeEventListener('pointerup', end); inn.removeEventListener('pointercancel', end); };
  }, [onRemove]);
  if (!p) return null;
  const qty = (d: number) => {
    const sz = sizeOf(p, line.size);
    const q2 = line.qty + d;
    if (q2 < 1) return onRemove(row.current!);
    if (sz && q2 > sz.available) { haptic.notify('error'); toast(`В НАЛИЧИИ ТОЛЬКО ${sz.available} ШТ`); return; }
    if (q2 > MAX_PER_SIZE) { haptic.notify('error'); toast(`НЕ БОЛЬШЕ ${MAX_PER_SIZE} ШТ ОДНОГО РАЗМЕРА`); return; }
    haptic.select();
    set((s) => ({ cart: s.cart.map((r, k) => (k === i ? { ...r, qty: q2 } : r)) }));
  };
  return (
    <li className="irow" ref={row}>
      <button className="irow__del" type="button" onClick={() => onRemove(row.current!)}>ВЕРНУТЬ<br />СУБЪЕКТУ</button>
      <div className="irow__in">
        <span className="irow__n">{String(i + 1).padStart(2, '0')}.</span>
        <span className="irow__t">{p.title} / {line.size} / ×{line.qty}<small>ВЕЩДОК #{p.no} · {p.color}</small>
          <span className="irow__qty"><button type="button" onClick={() => qty(-1)} aria-label="Меньше">−</button><output>×{line.qty}</output><button type="button" onClick={() => qty(1)} aria-label="Больше">+</button></span>
        </span>
        <span className="irow__p">{formatRub(p.price * line.qty)}</span>
      </div>
    </li>
  );
}

export function Bag() {
  const cart = useStore((s) => s.cart);
  const me = useStore((s) => s.boot?.me);
  const root = useRef<HTMLElement>(null);
  const seal = async () => {
    const pull = root.current?.querySelector('.zip__pull'), teeth = root.current?.querySelector<HTMLElement>('.zip__teeth');
    if (pull && teeth) {
      haptic.impact('rigid');
      await done(anim(pull, [{ transform: 'translateX(0)' }, { transform: `translateX(${-teeth.offsetWidth}px)` }], { duration: 420, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }), 520);
      haptic.impact('light');
      await wait(120);
    }
    go('#/protocol');
  };
  const remove = async (row: HTMLElement) => {
    const i = Array.from(row.parentElement!.children).indexOf(row);
    const inn = row.querySelector<HTMLElement>('.irow__in')!;
    inn.style.transform = '';
    const w = row.offsetWidth;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'strike');
    svg.setAttribute('viewBox', `0 0 ${w} 20`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = `<path d="${strikePath(w)}" fill="none" stroke="#E0241B" stroke-width="3.2" stroke-linecap="round" stroke-opacity=".92"/>`;
    row.appendChild(svg);
    const path = svg.querySelector('path')!, len = path.getTotalLength();
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    haptic.impact('medium');
    await done(anim(path, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 300, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }), 400);
    inn.style.opacity = '.45';
    await wait(260);
    await done(anim(row, [{ height: row.offsetHeight + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 240, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }), 340);
    const removed = useStore.getState().cart[i];
    set((s) => ({ cart: s.cart.filter((_, k) => k !== i) }));
    toast('ВЕЩЬ ВОЗВРАЩЕНА СУБЪЕКТУ', { action: 'Отменить', onAction: () => set((s) => { const c = s.cart.slice(); c.splice(i, 0, removed); return { cart: c }; }) });
  };

  useMainButton(cart.length ? { text: `ОФОРМИТЬ ЗАКАЗ — ${formatRub(cartTotal(cart))}`, shine: true, onClick: () => void seal() } : null);

  if (!cart.length)
    return (
      <section className="screen" aria-label="Пакет">
        <div className="empty"><div className="empty__bag"><span>EVIDENCE</span></div><h2 className="display">Изъятых вещей нет.</h2><p>Подозрительно.</p><button className="btn" type="button" onClick={() => go('#/')}>К вещдокам</button></div>
      </section>
    );
  const thumbs = cart.slice(0, 4).map((c, i) => {
    const p = productById(c.productId);
    const pos = [[4, 4, -7], [34, 0, 6], [62, 6, -3], [18, 8, 10]][i];
    const style = { left: `${pos[0]}%`, top: pos[1], transform: `rotate(${pos[2]}deg)` };
    return p?.images.front ? <img key={i} src={imgUrl(p.images.front, 360)} alt="" style={style} /> : <div key={i} style={{ ...style, position: 'absolute', width: 112, height: 112 }}><Classified label="" /></div>;
  });
  return (
    <section className="screen" aria-label="Пакет" ref={root}>
      <div className="bagscr">
        <div className="scr-h"><div><span className="label">PERSONAL PROPERTY · ОПИСЬ</span><h1 className="display">Личные вещи</h1></div><span className="label">ПРЕДМЕТОВ: <b style={{ color: 'var(--mrak-cream)' }}>{cartCount(cart)}</b></span></div>
        <div className="bag">
          <div className="zip"><div className="zip__teeth" /><div className="zip__pull" /></div>
          <div className="bag__label">EVIDENCE</div>
          <div className="bag__items">{thumbs}</div>
          <div className="paper">
            <i className="tag-hole" />
            <div className="inv__h"><Logo /><h2>Опись изъятого</h2></div>
            <div className="inv__meta"><span>SUBJECT <b>#{me?.subjectNo}</b></span><span>ДАТА <b>{new Date().toLocaleDateString('ru-RU')}</b></span><span>CASE <b>— НЕ ПРИСВОЕН</b></span><span>ВРЕМЯ <b><Clock mode="time" /></b></span></div>
            <ul className="inv__rows">{cart.map((l, i) => <Row key={`${l.productId}:${l.size}`} line={l} i={i} onRemove={remove} />)}</ul>
            <div className="inv__tot"><span>Итого</span><b>{formatRub(cartTotal(cart))}</b></div>
            <div className="inv__sig"><span>ИЗЪЯЛ: ДЕЖУРНЫЙ MRAK8</span><span>ПОДПИСЬ: __________</span></div>
          </div>
        </div>
        <p className="bag__hint">← СВАЙП ПО СТРОКЕ — ВЕРНУТЬ ВЕЩЬ</p>
      </div>
    </section>
  );
}
