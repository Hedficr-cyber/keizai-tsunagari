// ナビのレンズと横スワイプ。画面・読書位置・詳細履歴は既存ルーターが管理する。
export function initNavigation({ nav, main, getView, canNavigate, navigate }) {
  const links = [...nav.querySelectorAll('a[data-v]')];
  const views = links.map(a => a.dataset.v);
  const lens = nav.querySelector('.nav-lens');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let gesture = null, current = getView(), entry = null, snap = null;
  let suppressedClick = null;

  const zoomed = () => (window.visualViewport?.scale || 1) > 1.02;
  const ready = () => canNavigate() && !zoomed();
  const page = () => main.querySelector('.view.on');
  function metrics() {
    const rect = nav.getBoundingClientRect();
    const scale = rect.width / nav.offsetWidth || 1;
    return links.map(a => {
      const r = a.getBoundingClientRect();
      return { x: (r.left - rect.left) / scale - nav.clientLeft, width: r.width / scale, center: (r.left + r.right) / 2 };
    });
  }
  function moveLens(index, x = null) {
    const m = metrics()[index];
    if (!m) return;
    lens.style.width = `${m.width}px`;
    lens.style.transform = `translateX(${x ?? m.x}px)`;
  }
  function settleLens() {
    nav.classList.remove('is-dragging');
    delete nav.dataset.preview;
    moveLens(views.indexOf(getView()));
  }
  function resetPage(animate = false) {
    const el = gesture?.page;
    if (!el) return;
    const from = el.style.transform;
    el.style.transform = '';
    el.style.willChange = '';
    if (animate && from && !reduced.matches) {
      snap?.cancel();
      snap = el.animate([{ transform: from }, { transform: 'translateX(0)' }], { duration: 180, easing: 'ease-out' });
    }
  }
  function cancel(animate = false) {
    const old = gesture;
    resetPage(animate);
    gesture = null;
    settleLens();
    if (old?.owner.hasPointerCapture?.(old.id)) old.owner.releasePointerCapture(old.id);
  }
  function suppress(g) {
    suppressedClick = { until: performance.now() + 450, target: g.target };
  }
  function indexAt(x) {
    const ms = metrics();
    return ms.reduce((best, m, i) => Math.abs(x - m.center) < Math.abs(x - ms[best].center) ? i : best, 0);
  }
  function hasHorizontalScroller(target) {
    for (let el = target; el && el !== main; el = el.parentElement) {
      if (el.matches('.chips.scroll,[data-no-swipe],input,textarea,select,[contenteditable],video,audio,canvas')) return true;
      const overflow = getComputedStyle(el).overflowX;
      if (/(auto|scroll)/.test(overflow) && el.scrollWidth > el.clientWidth + 1) return true;
    }
    return false;
  }
  function start(ev, kind) {
    if (!ev.isPrimary || !ready() || (ev.pointerType === 'mouse' && (kind === 'page' || ev.button !== 0))) return;
    if (gesture) cancel();
    if (kind === 'page' && (ev.clientX < 24 || ev.clientX > innerWidth - 24 || hasHorizontalScroller(ev.target) || window.getSelection()?.toString())) return;
    entry?.cancel(); snap?.cancel();
    const owner = kind === 'nav' ? nav : main;
    gesture = { kind, owner, id: ev.pointerId, target: ev.target, x: ev.clientX, y: ev.clientY, start: performance.now(), index: views.indexOf(getView()), active: false, page: kind === 'page' ? page() : null };
  }
  function move(ev) {
    const g = gesture;
    if (!g || g.id !== ev.pointerId) return;
    if (!ready()) { cancel(); return; }
    const dx = ev.clientX - g.x, dy = ev.clientY - g.y;
    if (!g.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { cancel(); return; }
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
      g.active = true;
      g.owner.setPointerCapture(ev.pointerId);
      if (g.kind === 'nav') nav.classList.add('is-dragging');
      else g.page.style.willChange = 'transform';
    }
    if (ev.cancelable) ev.preventDefault();
    if (g.kind === 'nav') {
      const ms = metrics(), rect = nav.getBoundingClientRect(), scale = rect.width / nav.offsetWidth || 1;
      const index = indexAt(ev.clientX);
      const width = ms[index].width;
      const x = Math.max(ms[0].x, Math.min(ms.at(-1).x, (ev.clientX - rect.left) / scale - nav.clientLeft - width / 2));
      nav.dataset.preview = views[index];
      moveLens(index, x);
    } else if (!reduced.matches) {
      const outside = (g.index === 0 && dx > 0) || (g.index === views.length - 1 && dx < 0);
      const offset = outside ? dx * .12 : dx * .65;
      g.page.style.transform = `translateX(${Math.max(-160, Math.min(160, offset))}px)`;
    }
  }
  function end(ev) {
    const g = gesture;
    if (!g || g.id !== ev.pointerId) return;
    if (!g.active || !ready()) { cancel(); return; }
    const dx = ev.clientX - g.x, dy = ev.clientY - g.y;
    let next = g.index;
    if (g.kind === 'nav') {
      const rect = nav.getBoundingClientRect();
      if (ev.clientY >= rect.top - 32 && ev.clientY <= rect.bottom + 32) next = indexAt(ev.clientX);
    } else {
      const distance = Math.abs(dx), elapsed = performance.now() - g.start;
      const threshold = Math.max(56, Math.min(96, innerWidth * .18));
      if (distance > Math.abs(dy) * 1.35 && (distance >= threshold || (distance >= 28 && distance / elapsed > .45))) next += dx < 0 ? 1 : -1;
      next = Math.max(0, Math.min(views.length - 1, next));
    }
    suppress(g);
    cancel(next === g.index);
    if (next !== g.index) navigate(views[next]);
  }
  nav.addEventListener('pointerdown', ev => start(ev, 'nav'));
  main.addEventListener('pointerdown', ev => start(ev, 'page'));
  document.addEventListener('pointerdown', ev => { if (!ev.isPrimary) cancel(); }, true);
  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', () => cancel());
  nav.addEventListener('lostpointercapture', ev => { if (gesture && ev.target === nav) cancel(); });
  main.addEventListener('lostpointercapture', ev => { if (gesture && ev.target === main) cancel(); });
  document.addEventListener('touchstart', ev => { if (ev.touches.length > 1) cancel(); }, { passive: true });
  window.addEventListener('blur', () => cancel());
  function viewportChanged() {
    document.documentElement.classList.toggle('page-zoomed', zoomed());
    if (gesture) cancel();
    else settleLens();
  }
  window.visualViewport?.addEventListener('resize', viewportChanged);
  viewportChanged();
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  document.addEventListener('click', ev => {
    if (!suppressedClick || performance.now() > suppressedClick.until || ev.detail === 0) return;
    // dragの直後にブラウザが作るclickだけを止める。別のタップとキーボード操作は通す。
    if (ev.target === suppressedClick.target || ev.target.contains(suppressedClick.target) || suppressedClick.target.contains(ev.target) || ev.target === nav || ev.target === main) {
      ev.preventDefault(); ev.stopImmediatePropagation(); suppressedClick = null;
    }
  }, true);
  document.addEventListener('pointerdown', () => { suppressedClick = null; }, true);
  nav.addEventListener('keydown', ev => {
    if (ev.altKey || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key) || !ready()) return;
    const i = links.indexOf(ev.target.closest('a[data-v]'));
    if (i < 0) return;
    ev.preventDefault();
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? views.length - 1 : Math.max(0, Math.min(views.length - 1, i + (ev.key === 'ArrowRight' ? 1 : -1)));
    links[next].focus({ preventScroll: true });
    navigate(views[next]);
  });
  new ResizeObserver(() => { if (gesture) cancel(); else settleLens(); }).observe(nav);
  return {
    sync(view) {
      if (gesture) cancel();
      settleLens();
      entry?.cancel();
      if (current !== view && !reduced.matches) {
        const direction = views.indexOf(view) > views.indexOf(current) ? 1 : -1;
        entry = page()?.animate([{ opacity: .6, transform: `translateX(${direction * 72}px)` }, { opacity: 1, transform: 'translateX(0)' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
      current = view;
    },
  };
}
