import { makeGraph, dirWord, dirNum, dirClass } from "./graph.js";
import { renderRelationships, relationshipDetail, relationshipReason } from "./relationships.js";
import { VERSION } from "./versions.js";
import { initNavigation } from "./navigation.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => (/^https:\/\//.test(u || "") ? u : "");
let G = null;
let D = null;
let GLOSSARY = null;
let loadStatus = "loading";
// 日をまたぐデータ：流れ・答え合わせ・週のまとめ
let X = { threads: [], reviews: [], weeks: [], weekly: null };
const newsById = {};
const expertById = {};
const threadByName = {};
const state = {
  view: "today",
  newsMode: "list",
  newsCat: "all",
  expert: "all",
  connectionCat: "all",
  connectionDirections: {},
  connectionTarget: null,
  viewScroll: {},
};

// ---------- 用語をタップで説明 ----------
let TERMS = {}; // 用語 → { t, e, n, c, ai }
let ALIAS = {}; // 文中の言い方 → 用語
let TERM_RE = null;
let termContext = null;
let termReturnFocus = null;
function setTerms(glossary, aiTerms) {
  TERMS = {};
  ALIAS = {};
  for (const t of glossary?.terms || []) {
    TERMS[t.t] = t;
    for (const k of [t.t, ...(t.a || [])]) ALIAS[k] = t.t;
  }
  // その日のニュースに出てきた、用語集にない言葉（AI の説明）
  for (const t of aiTerms || []) {
    if (t.term && t.explain && !ALIAS[t.term]) { TERMS[t.term] = { t: t.term, e: t.explain, c: "今日の用語", ai: true }; ALIAS[t.term] = t.term; }
  }
  const keys = Object.keys(ALIAS).sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  TERM_RE = keys.length ? new RegExp(keys.join("|"), "g") : null;
}
// 文章の中の用語に点線を付ける。seen を渡すと、同じ画面では最初の1回だけにする
function gl(text, seen, context = null) {
  const s = String(text ?? "");
  const re = context ? context.termRe : TERM_RE;
  const aliases = context ? context.aliases : ALIAS;
  if (!re || !s) return esc(s);
  let out = "", last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(s))) {
    const key = aliases[m[0]];
    out += esc(s.slice(last, m.index));
    if (seen?.has(key)) out += esc(m[0]);
    else { seen?.add(key); out += `<span class="term" data-term="${esc(key)}" role="button" tabindex="0">${esc(m[0])}</span>`; }
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}
function showTerm(key, context = detailContext()) {
  const t = context.terms[key];
  if (!t) return;
  termReturnFocus = captureFocus(sheetOpen ? $("#sheet") : $("#v-" + state.view));
  termContext = context;
  $("#tc-term").textContent = t.t;
  $("#tc-tag").textContent = t.ai ? "AI の説明" : t.c || "";
  $("#tc-exp").textContent = t.e;
  const nb = $("#tc-node");
  if (t.n && G.byId[t.n]) { nb.hidden = false; nb.dataset.to = t.n; nb.textContent = `「${G.byId[t.n].short}」のつながりを見る`; } else nb.hidden = true;
  const card = $("#termcard");
  card.hidden = false;
  syncModalState();
  $("#tc-close").focus({ preventScroll: true });
  requestAnimationFrame(() => card.classList.add("on"));
}
function hideTerm(restoreFocus = true) {
  const c = $("#termcard");
  const wasOpen = !c.hidden;
  c.classList.remove("on"); c.hidden = true; termContext = null;
  syncModalState();
  if (wasOpen && restoreFocus) restoreFocusRef(termReturnFocus);
  termReturnFocus = null;
}

// ---------- 小さな部品 ----------
const ARROW = { up: "↑", down: "↓", mix: "⇅" };
function chip(nodeId, dir, opts = {}) {
  const n = G.byId[nodeId];
  if (!n) return "";
  const held = dir === "hold" && ["boj", "fed"].includes(nodeId);
  const d = held || dir === undefined || dir === null ? null : dirNum(dir);
  const cls = d === null ? "" : dirClass(d);
  const word = held ? `<span>据え置き</span>` : d === null ? "" : `<span>${esc(dirWord(n, d))}</span><span class="ar">${ARROW[cls]}</span>`;
  const label = opts.full ? n.name : n.short;
  // ボタンの中に置くときは span にする（ボタンの入れ子はブラウザが崩す）
  const tagName = opts.span ? "span" : "button";
  // span のときはタップを外側のボタンに任せる（テーマ・ニュース・波及の行を開く）
  const target = opts.span ? "" : ` data-node="${esc(n.id)}"`;
  return `<${tagName} class="tag ${cls} ${opts.conf ? "conf" : ""}"${target}><span class="nm">${esc(label)}</span>${word}</${tagName}>`;
}
const chainHtml = (chain, span = false) => (chain || []).map((c, k) => {
  const previous = chain[k - 1];
  const fromDir = previous && dirNum(previous.dir), toDir = dirNum(c.dir);
  const linked = previous && [1, -1].includes(fromDir) && [1, -1].includes(toDir)
    && G.out[previous.node]?.some(e => e.to === c.node && fromDir * e.sign === toDir);
  return (k ? linked ? `<span class="arrow">→</span>` : `<span class="chain-break" aria-hidden="true"></span>` : "")
    + chip(c.node, c.dir, { span, conf: !!c.conflict });
}).join("");
// シナリオは独立した因果経路ごとに描く。旧データも、不明な隣接を矢印で結ばない。
function scenarioPathsHtml(c) {
  const paths = [];
  for (const source of c.paths || (c.chain ? [c.chain] : [])) {
    let path = [];
    for (const tag of source) {
      if (!G.byId[tag.node] || !["up", "down", "hold"].includes(tag.dir)) continue;
      if (tag.dir === "hold" && !["boj", "fed"].includes(tag.node)) continue;
      const previous = path[path.length - 1];
      const connected = previous && ["up", "down"].includes(previous.dir) && ["up", "down"].includes(tag.dir)
        && G.out[previous.node].some(e => e.to === tag.node && dirNum(previous.dir) * e.sign === dirNum(tag.dir));
      if (previous && !connected) { paths.push(path); path = []; }
      path.push(tag);
    }
    if (path.length) paths.push(path);
  }
  return `<div class="case-paths">${paths.map(path => `<div class="chain">${chainHtml(path)}</div>`).join("")}</div>`;
}
function fmtTime(iso, withDate = true) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm;
}
function ago(iso) {
  const ms = Date.now() - new Date(iso);
  if (!(ms >= 0)) return fmtTime(iso);
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))}分前`;
  if (h < 24) return `${h}時間前`;
  return fmtTime(iso);
}
const WD = "日月火水木金土";
const todayStr = () => new Date().toLocaleDateString("sv");
function md(iso) { const d = new Date(iso + "T00:00:00"); return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`; }
function dayLabel(iso) {
  const n = Math.round((new Date(iso + "T00:00:00") - new Date(todayStr() + "T00:00:00")) / 86400000);
  return n === 0 ? "今日" : n === 1 ? "あす" : n === -1 ? "きのう" : n > 0 ? `あと${n}日` : `${-n}日前`;
}
// 要点がないときは、最初の一文を使う
const firstSentence = s => { const t = String(s || "").split("。")[0]; return t ? (t.length > 60 ? t.slice(0, 58) + "…" : t + "。") : ""; };
function spark(series, cls = "", big = false) {
  if (!series || series.length < 2) return "";
  const vs = series.map(p => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const w = 100, h = big ? 60 : 26;
  const pts = vs.map((v, i) => `${((i / (vs.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - lo) / span) * (h - 6)).toFixed(1)}`).join(" ");
  return `<svg class="${big ? "spark-lg" : ""} ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="${big ? 1.6 : 1.4}" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}
function marketChange(m) {
  const s = m.series;
  const last = s[s.length - 1];
  const target = new Date(last.d); target.setDate(target.getDate() - 30);
  const base = [...s].reverse().find(p => new Date(p.d) <= target) || s[0];
  return { last, base, diff: last.v - base.v };
}
function marketCard(key) {
  const m = D.markets?.[key];
  const n = G.byId[key];
  if (!m || !n || !m.series?.length) return "";
  const { last, diff } = marketChange(m);
  const cls = diff > 0 ? "up" : diff < 0 ? "down" : "";
  const val = m.unit === "%" ? last.v.toFixed(3) : last.v.toFixed(2);
  const dd = m.unit === "%" ? `${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(2)}pt` : `${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(2)}円`;
  const word = diff === 0 ? "" : dirWord(n, diff > 0 ? 1 : -1);
  return `<button class="mk" data-node="${esc(key)}">
    <span class="l">${esc(m.name.replace("の10年国債利回り", " 10年金利"))}</span>
    <span class="v">${esc(val)}<small>${esc(m.unit)}</small></span>
    <span class="c ${cls}-t">1か月 ${esc(dd)} ${esc(word)}</span>
    ${spark(m.series, cls + "-t")}
  </button>`;
}
function lv(n) { return `<span class="lv" aria-label="重要度${n}">${[1, 2, 3].map(i => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`; }
// 画面の下には版だけを出す（説明や注意書きは置かない）
const foot = () => `<p class="foot">${esc(VERSION)}</p>`;
const VERDICT = { 当たり: "hit", 一部当たり: "part", 外れ: "miss", まだわからない: "wait" };
const HINT = "";
const relList = (ids, context = null) => ids.map(id => (context?.news || newsById)[id]).filter(Boolean).slice(0, 4)
  .map(n => `<button data-news="${esc(n.id)}">${esc(newsTitle(n))}<span class="src">${esc(n.source)}・${esc(ago(n.time))}</span></button>`).join("");

// ---------- 今日 ----------
// 一覧では要点だけを見せ、くわしい中身はタップで開く
function renderToday() {
  const b = D.brief || { themes: [] };
  const upd = D.collected || D.updated ? new Date(D.collected || D.updated) : null;
  const moving = (D.moving || []).slice(0, 8).map(m => chip(m.node, m.dir)).join("");
  const wk = X.weekly;
  const showWeek = wk && (Date.now() - new Date(wk.made)) < 4 * 86400000;
  const rv = X.reviews[0];
  $("#v-today").innerHTML = `
    <p class="date-line">${upd ? `${upd.getMonth() + 1}月${upd.getDate()}日（${WD[upd.getDay()]}）の世の中` : ""}</p>
    <h1 class="headline">${esc(b.headline || "今日のニュースを集めています")}</h1>
    <div class="markets">${["usdjpy", "jgb10", "ust10"].map(marketCard).join("")}</div>
    ${showWeek ? `<button class="card week-card" data-weekly="${esc(wk.id)}"><div class="no">今週のまとめ・${esc(md(wk.from))}〜${esc(md(wk.to))}</div><h3>${esc(wk.title)}</h3><span class="chev-r" aria-hidden="true">›</span></button>` : ""}
    <div class="sec"><h2>今日のテーマ</h2></div>
    <div class="trows">${(b.themes || []).map(themeRow).join("") || `<p class="empty">次の更新で表示されます。</p>`}</div>
    ${agendaRows(3)}
    ${moving ? `<div class="sec"><h2>いま動いているもの</h2></div><div class="chips">${moving}</div>` : ""}
    ${rv && rv.reviewed === todayStr() ? `<div class="sec"><h2>答え合わせ</h2></div><button class="card link-card" data-reviewfull><div class="no">${esc(md(rv.target))}の「この先どうなるかも」</div><p>${esc(rv.summary)}</p><span class="chev-r" aria-hidden="true">›</span></button>` : ""}
    ${foot()}`;
}
function themeRow(t, i) {
  const th = threadByName[t.thread];
  return `<button class="card trow" data-theme="${i}">
    <div class="tr-top"><h3>${esc(t.title)}</h3><span class="chev-r" aria-hidden="true">›</span></div>
    <p class="tr-pt">${esc(t.point || firstSentence(t.what))}${th && th.entries.length > 1 ? `<span class="tr-days">${th.entries.length}日目</span>` : ""}</p>
    <div class="chain">${chainHtml(t.chain, true)}</div>
  </button>`;
}
function openTheme(i, context = detailContext()) {
  const t = context.data.brief?.themes?.[i];
  if (!t) return;
  const S = new Set();
  const th = context.threads[t.thread];
  // 点線は画面の上から最初の1回だけ付けるので、表示の順に組み立てる（有識者の見方は下で作る）
  const voices = () => (t.experts || []).map(id => context.experts[id]).filter(Boolean).slice(0, 2)
    .map(e => `<div class="voice"><div class="who">${esc(e.name)}<span class="muted" style="font-weight:500">｜${esc(e.role)}</span></div>${gl(e.view, S, context)}</div>`).join("");
  const hasVoices = (t.experts || []).some(id => context.experts[id]);
  const rel = relList(t.news || [], context);
  const conf = (t.chain || []).filter(c => c.conflict).map(c => `<p class="conf-note">※ ${esc(c.conflict)}</p>`).join("");
  const first = (t.chain || [])[0];
  openSheet(`
    ${th && th.entries.length > 1 ? `<p class="cat">流れ「${esc(th.name)}」${th.entries.length}日目</p>` : ""}
    <h2>${esc(t.title)}</h2>
    <div class="q-sec"><div class="q-h">何が起きた？</div><p>${gl(t.what, S, context)}</p></div>
    <div class="q-sec"><div class="q-h">どうつながる？</div><div class="chain">${chainHtml(t.chain)}</div><p>${gl(t.chain_text, S, context)}</p>${conf}</div>
    <div class="q-sec"><div class="q-h">この先どうなるかも</div><ul class="outlook">${(t.outlook || []).map(o => `<li>${gl(o, S, context)}</li>`).join("")}</ul></div>
    ${t.watch ? `<div class="q-sec"><div class="q-h">次に見るもの</div><p>${gl(t.watch, S, context)}</p></div>` : ""}
    ${hasVoices ? `<div class="q-sec"><div class="q-h">有識者はどう見ている？</div>${voices()}</div>` : ""}
    ${rel ? `<div class="q-sec"><div class="q-h">元のニュース</div><div class="rel">${rel}</div></div>` : ""}
    <div class="row-btns">${first ? `<button class="btn" data-connection-to="${esc(first.node)}:${esc(first.dir)}">つながりを見る</button>` : ""}${th && th.entries.length > 1 ? `<button class="btn ghost" data-thread="${esc(th.name)}">これまでの流れ</button>` : ""}</div>
    ${HINT}`, context);
}

// ---------- 予定とシナリオ ----------
let AGENDA = [];
function agendaItems(data = D) {
  const today = todayStr();
  // 結果が出たあとも、次の日までは残す（シナリオと照らせるように）
  const y = new Date(); y.setDate(y.getDate() - 1);
  const since = y.toLocaleDateString("sv");
  const cal = (data.calendar || []).filter(e => e.date >= since);
  const sc = [...(data.scenarios || [])];
  const items = cal.map(e => {
    // 同じ日の予定にシナリオを合わせる（名前の一部が重なるものを優先）
    const i = sc.findIndex(s => s.date === e.date && (s.event.includes(e.name.slice(0, 3)) || e.name.includes(s.event.slice(0, 3))));
    const j = i >= 0 ? i : sc.findIndex(s => s.date === e.date);
    return { ...e, scenario: j >= 0 ? sc.splice(j, 1)[0] : null };
  });
  // 公式の日程にない予定（ニュースから AI が拾ったもの）
  for (const s of sc) if (!s.date || s.date >= since) items.push({ date: s.date, name: s.event, note: s.date ? "" : "日付はニュースから未確定", nodes: [], scenario: s });
  return items.sort((a, b) => (a.date || "9999") < (b.date || "9999") ? -1 : 1);
}
function agendaRow(e, i) {
  return `<button class="ag-row" data-agi="${i}">
    <div class="ag-date">${e.date ? `${esc(md(e.date))}<span>${esc(dayLabel(e.date))}</span>` : `<span>日付未定</span>`}</div>
    <div class="ag-main"><b>${esc(e.name)}</b>${e.date && e.date < todayStr() ? `<span>結果が出ました</span>` : ""}</div>
    <span class="chev" aria-hidden="true">›</span></button>`;
}
function agendaRows(limit) {
  AGENDA = agendaItems();
  if (!AGENDA.length) return "";
  return `<div class="sec"><h2>これからの予定</h2></div>
    <div class="card ag-list">${AGENDA.slice(0, limit).map(agendaRow).join("")}
    ${AGENDA.length > limit ? `<button class="ag-all" data-agenda>予定をすべて見る（${AGENDA.length}）</button>` : ""}</div>`;
}
function openAgendaItem(i, context = detailContext()) {
  const e = context.agenda[i];
  if (!e) return;
  const s = e.scenario;
  const S = new Set();
  openSheet(`<p class="cat">これからの予定${e.date ? `・${esc(md(e.date))}（${esc(dayLabel(e.date))}）` : ""}</p>
    <h2>${esc(e.name)}</h2>
    ${e.note ? `<p class="muted small">${esc(e.note)}</p>` : ""}
    ${(e.nodes || []).length ? `<div class="q-sec"><div class="q-h">動きそうなもの</div><div class="chips">${e.nodes.map(n => chip(n)).join("")}</div></div>` : ""}
    ${e.date && e.date < todayStr() ? `<p class="muted small">結果が出ました</p>` : ""}
    ${s ? `<div class="q-sec"><div class="q-h">焦点</div><p>${gl(s.focus, S, context)}</p></div>
      <div class="q-sec"><div class="q-h">結果しだいで、こう広がるかも</div>
      <div class="cases">${s.cases.map((c, k) => `<div class="case c${k}"><div class="case-l">${esc(c.label)}</div>${scenarioPathsHtml(c)}<p>${gl(c.text, S, context)}</p></div>`).join("")}</div></div>` : ""}
    ${HINT}`, context);
}
function openAgenda(context = detailContext()) {
  openSheet(`<p class="cat">これからの予定</p><h2>予定</h2>
    <div class="card ag-list" style="margin-top:14px">${context.agenda.map(agendaRow).join("")}</div>`, context);
}

// ---------- ニュース ----------
// 分類は AI が選んだ1つ（古いデータは、いちばん目の項目札の分類）
function primaryNewsCat(n) {
  if (n.cat && G.cats.some(c => c.id === n.cat)) return n.cat;
  return (n.tags || []).map(t => G.byId[t.node]?.cat).find(id => G.cats.some(c => c.id === id)) || "other";
}
function newsCats(n) { return new Set([primaryNewsCat(n)]); }
function newsOrder(a, b) {
  return (b.level || 1) - (a.level || 1) || (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0);
}
function newsSection(title, items, featured = false) {
  return `<section class="news-section${featured ? " news-featured" : ""}">
    <div class="news-section-head"><h2>${esc(title)}</h2><span>${items.length}本</span></div>
    <div class="list">${items.map(n => newsRow(n, featured)).join("")}</div>
  </section>`;
}
function allNewsSections(all) {
  const ordered = [...all].sort(newsOrder);
  const candidates = ordered.filter(n => n.level >= 2);
  const picked = [], cats = new Set();
  // 先頭は同じ分野に寄せず、いくつかの分野の動きをつかめるようにする。
  for (const n of candidates) {
    const cat = primaryNewsCat(n);
    if (cats.has(cat)) continue;
    picked.push(n);
    cats.add(cat);
    if (picked.length === 5) break;
  }
  // 分野が少ない日も、重要度2以上の中から3本までは入口に置く。
  for (const n of candidates) {
    if (picked.length >= 3) break;
    if (!picked.includes(n)) picked.push(n);
  }
  const pickedIds = new Set(picked.map(n => n.id));
  const groups = new Map();
  for (const n of ordered) {
    if (pickedIds.has(n.id)) continue;
    const cat = primaryNewsCat(n);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(n);
  }
  const sections = G.cats.map(c => groups.has(c.id) ? newsSection(c.name, groups.get(c.id)) : "").join("");
  return (picked.length ? newsSection("まず押さえたいニュース", picked, true) : "") + sections
    + (groups.has("other") ? newsSection("その他の経済ニュース", groups.get("other")) : "");
}
function renderNews() {
  const all = D.news || [];
  const filtersScroll = $("#v-news .news-filters")?.scrollLeft || 0;
  const modes = `<div class="seg news-modes" role="group" aria-label="表示の切り替え"><button class="${state.newsMode === "list" ? "on" : ""}" data-newsmode="list" aria-pressed="${state.newsMode === "list"}">一覧</button><button class="${state.newsMode === "flow" ? "on" : ""}" data-newsmode="flow" aria-pressed="${state.newsMode === "flow"}">流れ</button></div>`;
  if (state.newsMode === "flow") {
    $("#v-news").innerHTML = `
      <h1 class="page-title">ニュース</h1>
      ${modes}
      <div style="margin-top:14px">${X.threads.map(threadCard).join("")}</div>
      ${X.weeks.length ? `<div class="sec"><h2>週のまとめ</h2></div><div class="rel">${X.weeks.map(w => `<button data-weekly="${esc(w.id)}">${esc(w.title)}<span class="src">${esc(md(w.from))}〜${esc(md(w.to))}</span></button>`).join("")}</div>` : ""}
      ${foot()}`;
    return;
  }
  const present = new Set(all.flatMap(n => [...newsCats(n)]));
  const filters = [["all", "すべて"], ["top", "重要"], ...G.cats.filter(c => present.has(c.id)).map(c => [c.id, c.name])];
  const list = all.filter(n => state.newsCat === "all" ? true : state.newsCat === "top" ? n.level >= 3 : newsCats(n).has(state.newsCat)).sort(newsOrder);
  const selectedName = filters.find(([id]) => id === state.newsCat)?.[1] || "すべて";
  const body = state.newsCat === "all" ? allNewsSections(all) : list.length ? newsSection(`${selectedName}のニュース`, list) : "";
  $("#v-news").innerHTML = `
    <h1 class="page-title">ニュース</h1>
    ${modes}
    <p class="page-sub" style="margin-top:12px">${state.newsCat === "all" ? all.length : list.length}本${(D.sources || []).length ? `・<button class="src-link" data-sources>${D.sources.filter(x => x.collected).length}の媒体 ›</button>` : ""}</p>
    <div class="chips scroll news-filters" role="group" aria-label="分野で絞り込む">${filters.map(([id, name]) => `<button class="filter ${state.newsCat === id ? "on" : ""}" data-newscat="${esc(id)}" aria-pressed="${state.newsCat === id}">${esc(name)}</button>`).join("")}</div>
    ${body || `<p class="empty">この分野のニュースは、いまはありません。</p>`}
    ${foot()}`;
  $("#v-news .news-filters").scrollLeft = filtersScroll;
}
function threadCard(t) {
  const last = t.entries[t.entries.length - 1];
  const first = t.entries[0];
  return `<button class="card thread" data-thread="${esc(t.name)}">
    <div class="no">${t.entries.length > 1 ? `${t.entries.length}日分・${esc(md(first.date))}〜${esc(md(last.date))}` : esc(md(last.date))}</div>
    <h3>${esc(t.name)}</h3>
    <p class="what">${esc(last.title)}</p>
  </button>`;
}
function openThread(name, context = detailContext()) {
  const t = context.threads[name];
  if (!t) return;
  const S = new Set();
  openSheet(`<p class="cat">流れ・${t.entries.length}日分</p><h2>${esc(t.name)}</h2>
    <div class="timeline">${[...t.entries].reverse().map(e => `<div class="tl">
      <div class="tl-date">${esc(md(e.date))}</div>
      <div class="tl-body"><h3>${esc(e.title)}</h3><p>${gl(e.what, S, context)}</p>
        <div class="chain" style="margin-top:8px">${chainHtml(e.chain)}</div></div></div>`).join("")}</div>
    ${HINT}`, context);
}
// 英語の記事は、AI が付けた日本語の見出しを出す（元の見出しは詳細に）
const newsTitle = n => n.title_ja || n.title;
// 集めている媒体（分け方ごとに、集めた本数と、AI が選んで載せた本数）
function openSources(context = detailContext()) {
  const groups = new Map();
  for (const x of context.data.sources || []) { if (!groups.has(x.group)) groups.set(x.group, []); groups.get(x.group).push(x); }
  openSheet(`<p class="cat">ニュース</p><h2>集めている媒体</h2>
    ${[...groups].map(([g, list]) => `<div class="q-sec"><div class="q-h">${esc(g || "そのほか")}</div><div class="src-list">${list.map(x => `<div class="src-row"><span>${esc(x.name)}${x.lang === "en" ? `<small>英語</small>` : ""}</span><span class="muted small">収集${x.collected}・代表${x.shown}・関連${x.related || 0}</span></div>`).join("")}</div></div>`).join("")}`, context);
}
function newsRow(n, featured = false) {
  const category = G.cats.find(c => c.id === primaryNewsCat(n));
  return `<button class="item news-item" data-news="${esc(n.id)}">
    <span class="news-item-main"><span class="t">${esc(newsTitle(n))}</span>
    <span class="m">${featured && category ? `<span class="news-category">${esc(category.name)}</span>` : ""}${n.level >= 3 ? `<span class="news-importance">重要</span>` : ""}${n.lang === "en" ? `<span class="news-more">英語</span>` : ""}<span>${esc(n.source)}</span><span>${esc(ago(n.time))}</span>${(n.related || []).length ? `<span class="news-more">ほか${n.related.length}本</span>` : ""}</span></span>
    <span class="news-chevron" aria-hidden="true">›</span>
  </button>`;
}
function openNews(id, context = detailContext()) {
  const n = context.news[id];
  if (!n) return;
  const S = new Set();
  const tags = (n.tags || []).filter(t => G.byId[t.node]);
  const first = tags[0];
  const section = (title, text) => text ? `<div class="q-sec"><div class="q-h">${esc(title)}</div><p>${gl(text, S, context)}</p></div>` : "";
  const sources = [{ title: n.title, link: n.link, source: n.source, time: n.time }, ...(n.related || [])].filter(x => safeUrl(x.link));
  openSheet(`
    <p class="cat">${esc(n.source)}・${esc(fmtTime(n.time))}</p>
    <h2>${gl(newsTitle(n), S, context)}</h2>
    ${section("何が起きた？", n.plain || newsTitle(n))}
    ${section("背景・仕組み", n.context)}
    ${section("この先の影響", n.impact || n.next)}
    ${section("次に見ること", n.watch)}
    ${tags.length ? `<div class="q-sec"><div class="q-h">経済のつながり</div><div class="chips">${tags.map(t => chip(t.node, t.dir, { full: true })).join("")}</div>
      <div class="row-btns"><button class="btn ghost" data-connection-to="${esc(first.node)}:${esc(first.dir || "up")}">つながりを見る</button></div></div>` : ""}
    ${sources.length ? `<details class="fold news-sources"><summary>出典・関連記事</summary><div class="rel">${sources.map(r => `<a href="${esc(safeUrl(r.link))}" target="_blank" rel="noopener noreferrer">${esc(r.source)}<span class="src">${esc(r.title)}</span></a>`).join("")}</div></details>` : ""}
    ${HINT}`, context);
}

// ---------- 項目の詳細 ----------
function openNode(id, context = detailContext()) {
  const n = G.byId[id];
  if (!n) return;
  const S = new Set();
  const m = n.market && context.data.markets?.[n.market];
  let market = "";
  if (m?.series?.length) {
    const { last, diff } = marketChange(m);
    const cls = diff > 0 ? "up" : diff < 0 ? "down" : "";
    market = `<div class="q-sec"><div class="q-h">いまの値</div>
      <p style="font-size:24px;font-weight:700;font-variant-numeric:tabular-nums">${esc(m.unit === "%" ? last.v.toFixed(3) : last.v.toFixed(2))}<small class="muted" style="font-size:12px;margin-left:3px">${esc(m.unit)}</small>
      <span class="${cls}-t" style="font-size:13px;margin-left:8px">1か月で ${diff >= 0 ? "+" : "−"}${esc(Math.abs(diff).toFixed(2))}${m.unit === "%" ? "pt" : "円"}（${esc(diff ? dirWord(n, diff > 0 ? 1 : -1) : "横ばい")}）</span></p>
      ${spark(m.series, cls + "-t", true)}
      <p class="muted small">${esc(last.d)} 時点（前の営業日の値）・${esc(m.source)}</p></div>`;
  }
  const mv = (context.data.moving || []).find(x => x.node === id);
  const outs = G.out[id].map(e => `<button class="link-row" data-relation="${esc(id)}:${esc(e.to)}:up"><div class="hd"><span class="small muted">${esc(n.up)}すると</span>${chip(e.to, e.sign, { span: true })}</div><p class="why">${esc(relationshipReason(G, e))}</p></button>`).join("");
  const ins = G.inn[id].map(e => `<button class="link-row" data-relation="${esc(e.from)}:${esc(id)}:up"><div class="hd">${chip(e.from, 1, { span: true })}<span class="small muted">→ ${esc(n.short)}は${esc(dirWord(n, e.sign))}</span></div><p class="why">${esc(relationshipReason(G, e))}</p></button>`).join("");
  const news = (context.data.news || []).filter(x => (x.tags || []).some(t => t.node === id)).slice(0, 4);
  openSheet(`
    <p class="cat">${esc(G.catName[n.cat])}</p>
    <h2>${esc(n.name)}</h2>
    <div class="q-sec"><div class="q-h">これは何？</div><p>${gl(n.desc, S, context)}</p></div>
    <div class="q-sec"><div class="q-h">暮らしでは</div><p>${gl(n.life, S, context)}</p></div>
    ${mv ? `<div class="q-sec"><div class="q-h">今日の動き</div><div class="hd" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${chip(id, mv.dir, { full: true })}<span class="small">${gl(mv.why, S, context)}</span></div></div>` : ""}
    ${market}
    <div class="row-btns"><button class="btn" data-connection-to="${esc(id)}">この項目のつながり</button></div>
    ${outs ? `<details class="fold"><summary>影響を与える先（${G.out[id].length}）</summary><div class="links">${outs}</div></details>` : ""}
    ${ins ? `<details class="fold"><summary>影響を受ける元（${G.inn[id].length}）</summary><div class="links">${ins}</div></details>` : ""}
    ${news.length ? `<div class="q-sec"><div class="q-h">関係する今日のニュース</div><div class="rel">${news.map(x => `<button data-news="${esc(x.id)}">${esc(newsTitle(x))}<span class="src">${esc(x.source)}・${esc(ago(x.time))}</span></button>`).join("")}</div></div>` : ""}
    ${HINT}`, context);
}

// ---------- つながりの一覧 ----------
function renderMap() {
  const filtersScroll = $("#v-map .relationship-filters")?.scrollLeft || 0;
  $("#v-map").innerHTML = `<h1 class="page-title">つながり</h1>${renderRelationships({
    graph: G, data: D, category: state.connectionCat, directions: state.connectionDirections, esc, gl,
  })}${foot()}`;
  const filters = $("#v-map .relationship-filters");
  if (filters) filters.scrollLeft = filtersScroll;
}
function openRelationship(value, context = detailContext()) {
  const [from, to, direction] = value.split(":");
  const html = relationshipDetail({ graph: G, data: context.data, from, to, direction, esc,
    gl: (text, seen) => gl(text, seen, context) });
  if (html) openSheet(html, context);
}
function goConnection(value) {
  const [id, direction] = value.split(":");
  if (!G.byId[id]) return;
  state.connectionCat = "all";
  if (direction === "up" || direction === "down") state.connectionDirections[id] = direction;
  state.connectionTarget = id;
  focusMapAfterSheet = true;
  leaveSheetForMap();
  if (state.view !== "map") location.hash = "#map";
  else { renderMap(); requestAnimationFrame(focusMapDestination); }
}

// ---------- 有識者 ----------
function renderExperts() {
  const all = D.experts || [];
  const names = [...new Map(all.map(e => [e.expert, e.name])).entries()];
  const list = all.filter(e => state.expert === "all" || e.expert === state.expert);
  const debates = (D.debates || []).map(debateCard).join("");
  $("#v-experts").innerHTML = `
    <h1 class="page-title">有識者の見方</h1>
    ${debates ? `<div class="sec" style="margin-top:8px"><h2>見方が分かれている点</h2></div>${debates}<div class="sec"><h2>それぞれの発信</h2></div>` : ""}
    <div class="chips scroll" role="group" aria-label="人で絞り込む">${[["all", "すべて"], ...names].map(([id, nm]) => `<button class="filter ${state.expert === id ? "on" : ""}" data-expert="${esc(id)}">${esc(nm)}</button>`).join("")}</div>
    <div style="margin-top:14px">${list.map(expertCard).join("") || `<p class="empty">いまは表示できる発信がありません。</p>`}</div>
    ${foot()}`;
}
function debateCard(d) {
  const S = new Set();
  const side = s => {
    const who = s.experts.map(id => expertById[id]).filter(Boolean);
    return `<div class="side ${s.stance === "強気" ? "bull" : "bear"}"><div class="side-h">${esc(s.stance)}</div><p>${gl(s.view, S)}</p><div class="side-who">${[...new Set(who.map(e => e.name))].map(esc).join("・")}</div></div>`;
  };
  return `<article class="card debate"><h3>${esc(d.topic)}</h3><p class="crux"><b>分かれ目</b>${gl(d.crux, S)}</p><div class="sides">${d.sides.map(side).join("")}</div></article>`;
}
function expertCard(e) {
  const url = safeUrl(e.link);
  return `<article class="card">
    <div class="ex-head"><div><div class="n">${esc(e.name)}</div><div class="r">${esc(e.role)}</div></div><span class="stance s-${esc(e.stance)}">${esc(e.stance)}</span></div>
    <p class="ex-view">${gl(e.view, new Set())}</p>
    ${url ? `<a class="ex-src" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(e.kind)}・${esc(e.source)}・${esc(ago(e.time))}<br><b>${esc(e.title)}</b></a>` : ""}
  </article>`;
}

// ---------- 見通しの答え合わせ ----------
function reviewCard(rv, limit = 99, context = null) {
  const S = new Set();
  return `<article class="card review"><div class="no">${esc(md(rv.target))}の見通し → ${esc(md(rv.reviewed))}に確認</div>
    <p class="rv-sum">${gl(rv.summary, S, context)}</p>
    ${rv.items.slice(0, limit).map(i => `<div class="rv-item"><div class="rv-h"><span class="verdict v-${VERDICT[i.verdict] || "wait"}">${esc(i.verdict)}</span><span class="muted small">${esc(i.theme)}</span></div>
      <p class="rv-o">「${gl(i.outlook, S, context)}」</p><p class="rv-a"><b>実際</b>${gl(i.actual, S, context)}</p><p class="rv-l"><b>学び</b>${gl(i.lesson, S, context)}</p></div>`).join("")}
  </article>`;
}

// ---------- 週のまとめ ----------
async function openWeekly(id, context = detailContext()) {
  const origin = { view: state.view, session: sheetOpen ? sheetSession : null, depth: sheetOpen ? sheetDepth : 0 };
  let w = context.weeks.get(id) || null;
  if (!w) w = await fetch(`data/weekly/${encodeURIComponent(id)}.json`, { cache: "no-cache" }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!w) return;
  if (state.view !== origin.view || (sheetOpen ? sheetSession : null) !== origin.session || (sheetOpen ? sheetDepth : 0) !== origin.depth) return;
  context.weeks.set(id, w);
  const S = new Set();
  openSheet(`<p class="cat">週のまとめ・${esc(md(w.from))}〜${esc(md(w.to))}</p><h2>${esc(w.title)}</h2>
    <div class="q-sec"><div class="q-h">この1週間</div><p>${gl(w.summary, S, context)}</p></div>
    <div class="q-sec"><div class="q-h">大きな動き</div>
    ${(w.moves || []).map(m => `<div class="wk-move"><h3>${esc(m.title)}</h3><div class="chain">${chainHtml(m.chain)}</div><p>${gl(m.text, S, context)}</p></div>`).join("")}</div>
    ${w.markets ? `<div class="q-sec"><div class="q-h">相場の1週間</div><p>${gl(w.markets, S, context)}</p></div>` : ""}
    ${(w.lessons || []).length ? `<div class="q-sec"><div class="q-h">今週わかったつながり</div><ul class="outlook">${w.lessons.map(l => `<li>${gl(l, S, context)}</li>`).join("")}</ul></div>` : ""}
    ${(w.next_week || []).length ? `<div class="q-sec"><div class="q-h">来週の注目</div><div class="links">${w.next_week.map(n => `<div class="link-row"><div class="hd"><b>${n.date ? esc(md(n.date)) : "日付未定"}</b><span>${esc(n.event)}</span></div><p class="why">${gl(n.why, S, context)}</p></div>`).join("")}</div></div>` : ""}
    ${HINT}`, context);
}

// ---------- 下から出る詳細 ----------
let sheetOpen = false;
let sheetSession = null;
let sheetDepth = 0;
let sheetSequence = 0;
let pendingViewRefresh = false;
let activationTarget = null;
let focusMapAfterSheet = false;
const sheetSessions = new Map();
const sheetContexts = new Map();
const sheetReturnFocus = new Map();
const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])';
function usableFocus(el) {
  if (!(el?.isConnected && el.getClientRects().length && !el.closest('[hidden],[inert]') && !el.disabled)) return false;
  // 閉じたdetailsの中は、ブラウザによって矩形だけが残るため別に除く。
  for (let details = el.closest('details:not([open])'); details; details = details.parentElement?.closest('details:not([open])')) {
    if (![...details.children].find(child => child.tagName === 'SUMMARY')?.contains(el)) return false;
  }
  return getComputedStyle(el).visibility !== 'hidden';
}
// 本文を描き直した場合も、同じ操作対象を探す。別記事へ入れ替わった要素には戻さない。
function focusIdentity(el) {
  const headline = el.matches('[data-news]') ? el.querySelector('.t,.hd b') : el.matches('[data-theme]') ? el.querySelector('h3') : null;
  return (headline || el).textContent.trim();
}
function captureFocus(root) {
  const el = root?.contains(activationTarget) ? activationTarget : document.activeElement;
  if (!root?.contains(el) || el === root || !el.matches(FOCUSABLE)) return null;
  const path = [];
  for (let at = el; at !== root; at = at.parentElement) path.unshift([...at.parentElement.children].indexOf(at));
  const key = el.id ? ['id', el.id] : [...el.attributes].find(a => a.name.startsWith('data-'));
  return { root, el, path, key: key ? [key[0] || key.name, key[1] ?? key.value] : null, tag: el.tagName, text: focusIdentity(el) };
}
function restoreFocusRef(ref) {
  if (!ref) return false;
  let el = ref.el;
  if (!usableFocus(el)) {
    el = ref.key ? $$(`[${CSS.escape(ref.key[0])}="${CSS.escape(ref.key[1])}"]`, ref.root).find(e => e.tagName === ref.tag && focusIdentity(e) === ref.text) : null;
    if (!el && ref.key?.[0] === 'data-news') el = $$('[data-news]', ref.root).find(e => e.tagName === ref.tag && focusIdentity(e) === ref.text);
    if (!el) {
      let candidate = ref.root;
      for (const index of ref.path) candidate = candidate?.children[index];
      if (candidate?.tagName === ref.tag && focusIdentity(candidate) === ref.text) el = candidate;
    }
  }
  if (!usableFocus(el)) return false;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}
function focusHeading(root) {
  const el = root?.querySelector('h1,h2') || root;
  if (!el) return;
  if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
  el.focus({ preventScroll: true });
}
function activeModal() { return !$("#termcard").hidden ? $("#termcard") : sheetOpen ? $("#sheet") : null; }
function syncModalState() {
  const termOpen = !$("#termcard").hidden;
  $$('.top,main,.nav,#update').forEach(el => { el.inert = sheetOpen || termOpen; });
  const sheet = $("#sheet");
  sheet.inert = !sheetOpen || termOpen;
  sheet.setAttribute('aria-hidden', String(!sheetOpen || termOpen));
  sheet.setAttribute('aria-modal', String(sheetOpen && !termOpen));
}
function trapModalTab(ev) {
  const modal = activeModal();
  if (!modal) return;
  const items = $$(FOCUSABLE, modal).filter(usableFocus);
  const active = document.activeElement;
  if (!items.length) { ev.preventDefault(); focusHeading(modal); }
  else if (!modal.contains(active) || active === modal || (ev.shiftKey && active === items[0]) || (!ev.shiftKey && active === items.at(-1))) {
    ev.preventDefault();
    (ev.shiftKey ? items.at(-1) : items[0]).focus({ preventScroll: true });
  }
}
function focusMapDestination() {
  if (!focusMapAfterSheet || state.view !== "map") return;
  focusMapAfterSheet = false;
  const id = state.connectionTarget;
  state.connectionTarget = null;
  const card = id ? $(`[data-connection-card="${CSS.escape(id)}"]`) : null;
  if (card) {
    card.scrollIntoView({ block: "start" });
    (card.querySelector('[data-connection-node]') || card).focus({ preventScroll: true });
  } else focusHeading($("#v-map"));
}
function captureDetailContext() {
  return {
    data: D,
    extras: { ...X },
    news: { ...newsById },
    experts: { ...expertById },
    threads: { ...threadByName },
    agenda: state.view === "today" ? [...AGENDA] : agendaItems(),
    terms: TERMS, aliases: ALIAS, termRe: TERM_RE,
    weeks: new Map(X.weekly ? [[X.weekly.id, X.weekly]] : []),
  };
}
function detailContext() {
  return sheetOpen ? sheetContexts.get(sheetSession) : captureDetailContext();
}
// 戻ったときには、本文だけでなく開閉した欄と読んでいた高さも戻す。
function rememberSheet() {
  if (!sheetOpen) return;
  const frames = sheetSessions.get(sheetSession);
  if (!frames?.[sheetDepth - 1]) return;
  frames[sheetDepth - 1] = { html: $("#sheet-body").innerHTML, scroll: $("#sheet").scrollTop, focus: captureFocus($("#sheet")) || frames[sheetDepth - 1].focus };
}
function showSheetFrame(session, depth) {
  const frame = sheetSessions.get(session)?.[depth - 1];
  if (!frame) return false;
  sheetSession = session;
  sheetDepth = depth;
  sheetOpen = true;
  $("#sheet-body").innerHTML = frame.html;
  $("#sheet-back").hidden = depth <= 1;
  $("#sheet").classList.add("on");
  $("#scrim").classList.add("on");
  document.body.style.overflow = "hidden";
  syncModalState();
  if (!restoreFocusRef(frame.focus)) focusHeading($("#sheet-body"));
  $("#sheet").scrollTop = frame.scroll;
  requestAnimationFrame(() => {
    if (sheetOpen && sheetSession === session && sheetDepth === depth) $("#sheet").scrollTop = frame.scroll;
  });
  return true;
}
function openSheet(html, context = detailContext()) {
  hideTerm();
  rememberSheet();
  if (!sheetOpen) {
    sheetSession = `${Date.now()}-${++sheetSequence}`;
    sheetDepth = 0;
    sheetSessions.set(sheetSession, []);
    sheetContexts.set(sheetSession, context);
    sheetReturnFocus.set(sheetSession, { view: state.view, focus: captureFocus($("#v-" + state.view)) });
  }
  const frames = sheetSessions.get(sheetSession).slice(0, sheetDepth);
  frames.push({ html, scroll: 0 });
  sheetSessions.set(sheetSession, frames);
  sheetDepth = frames.length;
  history.pushState({ ...history.state, kzSheet: sheetSession, kzDepth: sheetDepth }, "");
  showSheetFrame(sheetSession, sheetDepth);
}
function hideSheet(restoreFocus = true) {
  rememberSheet();
  hideTerm(false);
  sheetOpen = false;
  $("#sheet").classList.remove("on");
  $("#scrim").classList.remove("on");
  document.body.style.overflow = "";
  syncModalState();
  if (pendingViewRefresh) {
    const y = window.scrollY;
    pendingViewRefresh = false;
    RENDER[state.view]();
    requestAnimationFrame(() => window.scrollTo(0, y));
  }
  if (restoreFocus) {
    const origin = sheetReturnFocus.get(sheetSession);
    if (origin?.view === state.view && !restoreFocusRef(origin.focus)) focusHeading($("#v-" + state.view));
  }
}
function closeSheet() {
  if (!sheetOpen) return;
  const depth = history.state?.kzSheet === sheetSession ? sheetDepth : 0;
  hideSheet();
  if (depth) history.go(-depth);
}
function backSheet() {
  if (sheetOpen && sheetDepth > 1) history.back();
}
function leaveSheetForMap() {
  if (!sheetOpen) return;
  focusMapAfterSheet = true;
  hideSheet(false);
  // 同じ画面の項目選択ではhashが変わらない。閉じた詳細を現在の履歴に残さない。
  if (state.view === "map") {
    const { kzSheet, kzDepth, ...base } = history.state || {};
    history.replaceState(base, "");
  }
}
function syncSheetHistory() {
  const hs = history.state;
  if (hs?.kzSheet && sheetSessions.get(hs.kzSheet)?.[hs.kzDepth - 1]) {
    if (sheetOpen && sheetSession === hs.kzSheet && sheetDepth === hs.kzDepth) return;
    rememberSheet();
    hideTerm();
    showSheetFrame(hs.kzSheet, hs.kzDepth);
  } else if (sheetOpen) hideSheet();
}

// ---------- 画面の切り替え ----------
const RENDER = { today: renderToday, news: renderNews, map: renderMap, experts: renderExperts };
const navigation = initNavigation({
  nav: $(".nav"), main: $("main"), getView: () => state.view,
  canNavigate: () => loadStatus === "ready" && !activeModal(),
  navigate: view => {
    if (!RENDER[view] || view === state.view || activeModal()) return;
    history.pushState({}, "", `#${view}`);
    syncNavigation();
  },
});
function viewFromHash() {
  const view = (location.hash || "#today").slice(1);
  if (view === "learn") {
    const { kzSheet, kzDepth, ...base } = history.state || {};
    history.replaceState(base, "", "#today");
    return "today";
  }
  return RENDER[view] ? view : "today";
}
function route() {
  const next = viewFromHash();
  const focusInOldView = next !== state.view && $("#v-" + state.view)?.contains(document.activeElement);
  if (next !== state.view) state.viewScroll[state.view] = window.scrollY;
  state.view = next;
  $$(".view").forEach(el => el.classList.toggle("on", el.id === "v-" + state.view));
  $$(".nav a").forEach(a => { if (a.dataset.v === state.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (loadStatus === "ready") RENDER[state.view]();
  else $("#v-" + state.view).innerHTML = loadStatus === "loading"
    ? '<div class="load-state" data-load-status="loading" role="status">読み込み中…</div>'
    : '<div class="load-state" data-load-status="error" role="status"><p>読み込めませんでした</p><button class="btn" data-load-retry>再読み込み</button></div>';
  navigation.sync(state.view);
  requestAnimationFrame(() => {
    if (state.view !== next) return;
    if (!(next === "map" && state.connectionTarget)) window.scrollTo(0, state.viewScroll[next] || 0);
    focusMapDestination();
    if (focusInOldView) focusHeading($("#v-" + state.view));
  });
}
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
function syncNavigation() {
  const next = viewFromHash();
  if (next !== state.view) {
    hideTerm(false);
    if (sheetOpen) hideSheet(false);
    route();
  }
  syncSheetHistory();
}

document.addEventListener("click", ev => {
  if (ev.target.closest("[data-load-retry]")) {
    ev.preventDefault();
    if (loadStatus !== "loading") load();
    return;
  }
  activationTarget = ev.target.closest('button,a[href],[tabindex]');
  queueMicrotask(() => { activationTarget = null; });
  // 用語の説明が出ているときは、外をタップしたら閉じるだけにする
  const card = $("#termcard");
  if (!card.hidden) {
    const inCard = ev.target.closest("#termcard");
    if (!inCard) { hideTerm(); if (!ev.target.closest("[data-term]")) { ev.preventDefault(); ev.stopPropagation(); return; } }
    else {
      if (ev.target.closest("#tc-node")) { const to = $("#tc-node").dataset.to; const context = termContext; hideTerm(); openNode(to, context); }
      else if (ev.target.closest("#tc-close")) hideTerm();
      return;
    }
  }
  const term = ev.target.closest("[data-term]");
  if (term) { ev.preventDefault(); ev.stopPropagation(); showTerm(term.dataset.term); return; }
  const t = ev.target.closest("[data-node],[data-news],[data-newscat],[data-newsmode],[data-expert],[data-connection-cat],[data-connection-dir],[data-connection-node],[data-connection-to],[data-relation],[data-thread],[data-weekly],[data-agenda],[data-agi],[data-reviews],[data-reviewfull],[data-theme],[data-sources]");
  if (!t) return;
  const ds = t.dataset;
  if (ds.connectionTo) goConnection(ds.connectionTo);
  else if (ds.connectionCat) {
    state.connectionCat = ds.connectionCat; renderMap();
    $(`#v-map [data-connection-cat="${CSS.escape(ds.connectionCat)}"]`)?.focus({ preventScroll: true });
  } else if (ds.connectionDir) {
    const [id, direction] = ds.connectionDir.split(":");
    if (!G.byId[id] || !["up", "down"].includes(direction)) return;
    const y = window.scrollY; state.connectionDirections[id] = direction; renderMap();
    $(`#v-map [data-connection-dir="${CSS.escape(ds.connectionDir)}"]`)?.focus({ preventScroll: true });
    window.scrollTo(0, y);
  } else if (ds.connectionNode) openNode(ds.connectionNode);
  else if (ds.relation) openRelationship(ds.relation);
  else if (ds.newsmode) { state.newsMode = ds.newsmode; renderNews(); $(`#v-news [data-newsmode="${state.newsMode}"]`)?.focus({ preventScroll: true }); }
  else if (ds.sources !== undefined) openSources();
  else if (ds.newscat) { state.newsCat = ds.newscat; renderNews(); $(`#v-news [data-newscat="${state.newsCat}"]`)?.focus({ preventScroll: true }); }
  else if (ds.expert) { state.expert = ds.expert; renderExperts(); }
  else if (ds.theme !== undefined) openTheme(+ds.theme);
  else if (ds.thread) openThread(ds.thread);
  else if (ds.weekly) openWeekly(ds.weekly);
  else if (ds.agenda !== undefined) openAgenda();
  else if (ds.agi !== undefined) openAgendaItem(+ds.agi);
  else if (ds.reviewfull !== undefined) { const context = detailContext(); if (context.extras.reviews[0]) openSheet(`<p class="cat">答え合わせ</p><h2>見通しの答え合わせ</h2>${reviewCard(context.extras.reviews[0], 99, context)}${HINT}`, context); }
  else if (ds.reviews !== undefined) { const context = detailContext(); openSheet(`<p class="cat">答え合わせ</p><h2>これまでの答え合わせ</h2>${context.extras.reviews.map(r => reviewCard(r, 99, context)).join("")}`, context); }
  else if (ds.news) openNews(ds.news);
  else if (ds.node) openNode(ds.node);
}, true);
document.addEventListener("keydown", ev => {
  if (ev.key === "Tab") trapModalTab(ev);
  if (ev.key === "Escape") { if (activeModal()) ev.preventDefault(); if (!$("#termcard").hidden) hideTerm(); else closeSheet(); }
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.("[data-node],[data-term]")) { ev.preventDefault(); ev.target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
});
document.addEventListener('focusin', ev => {
  const modal = activeModal();
  if (modal && !modal.contains(ev.target)) ($$(FOCUSABLE, modal).find(usableFocus) || modal).focus({ preventScroll: true });
});
$("#scrim").addEventListener("click", closeSheet);
$("#sheet-close").addEventListener("click", closeSheet);
$("#sheet-back").addEventListener("click", backSheet);
window.addEventListener("popstate", syncNavigation);
window.addEventListener("hashchange", syncNavigation);

// ---------- データの読み込みと、新しい内容・新しい版の確認 ----------
const getJson = u => fetch(u, { cache: "no-cache" }).then(r => (r.ok ? r.json() : null)).catch(() => null);
function setData(d) {
  if (D && sheetOpen) pendingViewRefresh = true;
  D = d || { brief: { themes: [] }, news: [], experts: [], moving: [], markets: {} };
  for (const k of Object.keys(newsById)) delete newsById[k];
  for (const k of Object.keys(expertById)) delete expertById[k];
  for (const n of D.news || []) newsById[n.id] = n;
  for (const e of D.experts || []) expertById[e.id] = e;
  setTerms(GLOSSARY, D.terms);
  $("#stamp").textContent = D.updated ? `${fmtTime(D.updated)} 更新` : "";
}
async function loadExtras() {
  const [th, rv, wk] = await Promise.all([getJson("data/threads.json"), getJson("data/reviews.json"), getJson("data/weekly/index.json")]);
  X.threads = th?.threads || [];
  X.reviews = rv?.reviews || [];
  X.weeks = wk?.weeks || [];
  X.weekly = X.weeks[0] ? await getJson(`data/weekly/${encodeURIComponent(X.weeks[0].id)}.json`) : null;
  for (const k of Object.keys(threadByName)) delete threadByName[k];
  for (const t of X.threads) threadByName[t.name] = t;
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("on"), 3200);
}
let lastCheck = 0;
async function checkFresh() {
  if (Date.now() - lastCheck < 3 * 60000) return;
  lastCheck = Date.now();
  // ホーム画面のアプリは開きっぱなしで戻ってくるので、戻るたびに新しい内容があるかを見る
  const d = await getJson("data/latest.json");
  if (d?.updated && D && (d.updated !== D.updated || d.revision !== D.revision)) {
    await loadExtras();
    setData(d);
    if (!sheetOpen) RENDER[state.view]();
    toast(`${fmtTime(d.updated)} の内容に更新しました`);
  }
  const vt = await fetch("js/versions.js", { cache: "no-cache" }).then(r => (r.ok ? r.text() : "")).catch(() => "");
  const v = (vt.match(/v:\s*"(v[\d.]+)"/) || [])[1];
  if (v && v !== VERSION) {
    $("#update-v").textContent = v;
    $("#update").hidden = false;
  }
}
$("#update-btn").addEventListener("click", async () => {
  try { const r = await navigator.serviceWorker?.getRegistration(); await r?.update(); } catch { /* 更新の確認ができなくても読み直す */ }
  location.reload();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkFresh(); });

async function load() {
  loadStatus = "loading";
  route();
  try {
    const [g, d, gloss] = await Promise.all([getJson("data/graph.json"), getJson("data/latest.json"), getJson("data/glossary.json"), loadExtras()]);
    if (!g?.nodes?.length || !Array.isArray(g.edges) || !Array.isArray(d?.news)) throw new Error("missing data");
    G = makeGraph(g);
    GLOSSARY = gloss;
    setData(d);
    loadStatus = "ready";
    lastCheck = Date.now();
    route();
    setTimeout(() => { lastCheck = 0; checkFresh(); }, 4000);
  } catch {
    loadStatus = "error";
    route();
  }
}
load();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
