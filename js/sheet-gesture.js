// 下から出る詳細を、下へスライドして閉じる。上の取っ手はいつでも、本文はいちばん上まで戻っているときだけ。
// 閉じる処理と履歴は app.js の close に任せ、ここでは指に追従する見た目だけを持つ。
// なめらかに動かすため、位置は1コマに1回だけ書き、動かしている間は大きさを読み直さない。
// 離したあとは指の速さに合わせて閉じる（出だしだけ急に進まない）。
export function initSheetGesture({ sheet, scrim, isOpen, close }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const grab = sheet.querySelector('.grab');
  let g = null, frame = 0, pendingY = 0;

  function paint() {
    frame = 0;
    if (!g?.active) return;
    sheet.style.transform = `translate3d(0,${pendingY}px,0)`;
    scrim.style.opacity = String(Math.max(0, 1 - pendingY / g.h));
  }
  function follow(y) {
    pendingY = y;
    if (!frame) frame = requestAnimationFrame(paint);
  }
  function clearStyles() {
    sheet.style.transition = '';
    sheet.style.transform = '';
  }
  function release(closing, velocity = 0, moved = 0, height = sheet.offsetHeight) {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    sheet.classList.remove('is-dragging');
    scrim.style.transition = '';
    scrim.style.willChange = '';
    if (closing) {
      // 残りの距離を、離したときの指の速さで進む長さにする（180〜320ms）
      const remaining = Math.max(0, height - moved);
      const duration = reduced.matches ? 0 : Math.round(Math.max(180, Math.min(320, 1.8 * remaining / Math.max(velocity, .9))));
      sheet.style.transition = duration ? `transform ${duration}ms cubic-bezier(.25,.46,.45,.94)` : 'none';
      sheet.style.transform = 'translate3d(0,100%,0)';
      scrim.style.opacity = '';
      close();
      const done = () => { if (!sheet.classList.contains('on')) clearStyles(); };
      if (duration) sheet.addEventListener('transitionend', done, { once: true });
      setTimeout(done, duration + 80);
    } else {
      sheet.style.transform = '';
      scrim.style.opacity = '';
    }
  }
  function begin(x, y, target) {
    if (!isOpen()) return null;
    return { x, y, lastY: y, lastT: performance.now(), v: 0, onGrab: !!grab?.contains(target), atTop: sheet.scrollTop <= 0, active: false };
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
      g.h = Math.max(240, sheet.offsetHeight);
      sheet.classList.add('is-dragging');
      scrim.style.transition = 'none';
      scrim.style.willChange = 'opacity';
    }
    const now = performance.now();
    // 速さは直近の動きを重く見てならす（1回の揺れで判断しない）
    g.v = g.v * .4 + ((y - g.lastY) / Math.max(1, now - g.lastT)) * .6;
    g.lastY = y; g.lastT = now;
    follow(Math.max(0, y - g.y));
    return true;
  }
  function finish(y) {
    if (!g?.active) { g = null; return; }
    const moved = Math.max(0, y - g.y), { v, h } = g;
    const closing = moved > Math.min(140, h * .25) || (moved > 40 && v > .5);
    g = null;
    release(closing, v, moved, h);
  }
  const onMove = ev => {
    if (!g || ev.touches.length !== 1) return;
    // 追従を始めたら、ブラウザの引っぱりやスクロールを止める
    if (step(ev.touches[0].clientX, ev.touches[0].clientY) && ev.cancelable) ev.preventDefault();
  };
  // 止められる（passive でない）指の動きの受け取りは、本文が先頭にあるときと取っ手だけに付ける。
  // 読み進めている間のスクロールは、ブラウザがこちらを待たずに進められる。
  let watching = false;
  function watchTop() {
    const top = sheet.scrollTop <= 0;
    if (top === watching) return;
    watching = top;
    if (top) sheet.addEventListener('touchmove', onMove, { passive: false });
    else sheet.removeEventListener('touchmove', onMove, { passive: false });
  }
  watchTop();
  sheet.addEventListener('scroll', watchTop, { passive: true });
  grab?.addEventListener('touchmove', ev => { if (!watching) onMove(ev); }, { passive: false });

  sheet.addEventListener('touchstart', ev => {
    watchTop();
    g = ev.touches.length === 1 ? begin(ev.touches[0].clientX, ev.touches[0].clientY, ev.target) : null;
    if (ev.touches.length > 1 && sheet.classList.contains('is-dragging')) release(false);
  }, { passive: true });
  sheet.addEventListener('touchend', ev => finish(ev.changedTouches[0]?.clientY ?? 0));
  sheet.addEventListener('touchcancel', () => { if (g?.active) release(false); g = null; });

  // パソコンでは取っ手をつかんで下げられる（タッチは上の処理が受け持つ）
  grab?.addEventListener('pointerdown', ev => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0 || ev.target.closest('button')) return;
    g = begin(ev.clientX, ev.clientY, ev.target);
    if (g) grab.setPointerCapture(ev.pointerId);
  });
  grab?.addEventListener('pointermove', ev => { if (g && ev.pointerType === 'mouse') step(ev.clientX, ev.clientY); });
  grab?.addEventListener('pointerup', ev => { if (ev.pointerType === 'mouse') finish(ev.clientY); });
  grab?.addEventListener('pointercancel', () => { if (g?.active) release(false); g = null; });
}
