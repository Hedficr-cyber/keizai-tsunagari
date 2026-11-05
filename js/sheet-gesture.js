// 下から出る詳細を、下へスライドして閉じる。上の取っ手はいつでも、本文はいちばん上まで戻っているときだけ。
// 閉じる処理と履歴は app.js の close に任せ、ここでは指に追従する見た目だけを持つ。
export function initSheetGesture({ sheet, scrim, isOpen, close }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let g = null;

  function follow(y) {
    scrim.style.transition = 'none';
    sheet.style.transform = `translateY(${y}px)`;
    scrim.style.opacity = String(Math.max(0, 1 - y / Math.max(240, sheet.offsetHeight)));
  }
  function release(closing) {
    sheet.classList.remove('is-dragging');
    scrim.style.transition = '';
    if (closing) {
      sheet.style.transform = 'translateY(100%)';
      scrim.style.opacity = '';
      close();
      const clear = () => { sheet.style.transform = ''; };
      if (reduced.matches) clear();
      else sheet.addEventListener('transitionend', clear, { once: true });
      setTimeout(clear, 450);
    } else {
      sheet.style.transform = '';
      scrim.style.opacity = '';
    }
  }
  function begin(x, y, target) {
    if (!isOpen()) return null;
    return { x, y, lastY: y, lastT: performance.now(), v: 0, onGrab: !!target.closest('.grab'), atTop: sheet.scrollTop <= 0, active: false };
  }
  // 縦の動きが下向きで、取っ手か本文の先頭からなら追従を始める。それ以外はふつうのスクロールに任せる。
  function step(x, y) {
    const dx = x - g.x, dy = y - g.y;
    if (!g.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { g = null; return false; }
      if (dy < -6) { g = null; return false; }
      if (dy < 8) return false;
      if (!(g.onGrab || (g.atTop && sheet.scrollTop <= 0))) { g = null; return false; }
      g.active = true;
      g.y = y;
      sheet.classList.add('is-dragging');
    }
    const now = performance.now();
    g.v = (y - g.lastY) / Math.max(1, now - g.lastT);
    g.lastY = y; g.lastT = now;
    follow(Math.max(0, y - g.y));
    return true;
  }
  function finish(y) {
    if (!g?.active) { g = null; return; }
    const moved = Math.max(0, y - g.y);
    const closing = moved > Math.min(140, sheet.offsetHeight * .25) || (moved > 40 && g.v > .5);
    g = null;
    release(closing);
  }

  sheet.addEventListener('touchstart', ev => {
    g = ev.touches.length === 1 ? begin(ev.touches[0].clientX, ev.touches[0].clientY, ev.target) : null;
    if (ev.touches.length > 1 && sheet.classList.contains('is-dragging')) release(false);
  }, { passive: true });
  sheet.addEventListener('touchmove', ev => {
    if (!g || ev.touches.length !== 1) return;
    // 追従を始めたら、ブラウザの引っぱりやスクロールを止める
    if (step(ev.touches[0].clientX, ev.touches[0].clientY) && ev.cancelable) ev.preventDefault();
  }, { passive: false });
  sheet.addEventListener('touchend', ev => finish(ev.changedTouches[0]?.clientY ?? 0));
  sheet.addEventListener('touchcancel', () => { if (g?.active) release(false); g = null; });

  // パソコンでは取っ手をつかんで下げられる（タッチは上の処理が受け持つ）
  const grab = sheet.querySelector('.grab');
  grab?.addEventListener('pointerdown', ev => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0 || ev.target.closest('button')) return;
    g = begin(ev.clientX, ev.clientY, ev.target);
    if (g) grab.setPointerCapture(ev.pointerId);
  });
  grab?.addEventListener('pointermove', ev => { if (g && ev.pointerType === 'mouse') step(ev.clientX, ev.clientY); });
  grab?.addEventListener('pointerup', ev => { if (ev.pointerType === 'mouse') finish(ev.clientY); });
  grab?.addEventListener('pointercancel', () => { if (g?.active) release(false); g = null; });
}
