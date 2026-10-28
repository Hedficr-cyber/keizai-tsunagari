import { makeGraph, simulate, dirWord, dirNum, dirClass, STRENGTH, edgePath, makeGraphQuiz, MAP_W, MAP_H, NODE_W, NODE_H } from "./graph.js";
import { VERSION } from "./versions.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => (/^https:\/\//.test(u || "") ? u : "");
const store = {
  get(k, d) { try { const v = localStorage.getItem("kz." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("kz." + k, JSON.stringify(v)); } catch { /* 保存できない環境では覚えない */ } },
};

let G = null;
let D = null;
let GLOSSARY = null;
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
  mapMode: "try",
  walk: [], // たどった項目（最後が真ん中）
  sim: null, // { start, dir }
  simPick: "boj",
  simDir: 1,
  gq: null,
  gqAnswered: null,
  todayAnswers: {},
  glCat: null,
};

// ---------- 用語をタップで説明 ----------
let TERMS = {}; // 用語 → { t, e, n, c, ai }
let ALIAS = {}; // 文中の言い方 → 用語
let TERM_RE = null;
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
function gl(text, seen) {
  const s = String(text ?? "");
  if (!TERM_RE || !s) return esc(s);
  let out = "", last = 0, m;
  TERM_RE.lastIndex = 0;
  while ((m = TERM_RE.exec(s))) {
    const key = ALIAS[m[0]];
    out += esc(s.slice(last, m.index));
    if (seen?.has(key)) out += esc(m[0]);
    else { seen?.add(key); out += `<span class="term" data-term="${esc(key)}" role="button" tabindex="0">${esc(m[0])}</span>`; }
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}
function showTerm(key) {
  const t = TERMS[key];
  if (!t) return;
  $("#tc-term").textContent = t.t;
  $("#tc-tag").textContent = t.ai ? "AI の説明" : t.c || "";
  $("#tc-exp").textContent = t.e;
  const nb = $("#tc-node");
  if (t.n && G.byId[t.n]) { nb.hidden = false; nb.dataset.to = t.n; nb.textContent = `「${G.byId[t.n].short}」のつながりを見る`; } else nb.hidden = true;
  const card = $("#termcard");
  card.hidden = false;
  requestAnimationFrame(() => card.classList.add("on"));
}
function hideTerm() { const c = $("#termcard"); c.classList.remove("on"); c.hidden = true; }

// ---------- 小さな部品 ----------
const ARROW = { up: "↑", down: "↓", mix: "⇅" };
function chip(nodeId, dir, opts = {}) {
  const n = G.byId[nodeId];
  if (!n) return "";
  const d = dir === undefined || dir === null ? null : dirNum(dir);
  const cls = d === null ? "" : dirClass(d);
  const word = d === null ? "" : `<span>${esc(dirWord(n, d))}</span><span class="ar">${ARROW[cls]}</span>`;
  const label = opts.full ? n.name : n.short;
  // ボタンの中に置くときは span にする（ボタンの入れ子はブラウザが崩す）
  const tagName = opts.span ? "span" : "button";
  // span のときはタップを外側のボタンに任せる（テーマ・ニュース・波及の行を開く）
  const target = opts.span ? "" : ` data-node="${esc(n.id)}"`;
  return `<${tagName} class="tag ${cls} ${opts.conf ? "conf" : ""}"${target}><span class="nm">${esc(label)}</span>${word}</${tagName}>`;
}
const chainHtml = (chain, span = false) => (chain || []).map((c, k) => (k ? `<span class="arrow ${c.known === false ? "new" : ""}">→</span>` : "") + chip(c.node, c.dir, { span, conf: !!c.conflict })).join("");
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
const foot = () => `<p class="foot">ニュースの見出しと識者の発信をもとに、AI（Claude）が要点・つながり・見通しをまとめています。記事の全文は読んでいません。見通しは可能性の話で、投資の判断は元の記事や一次情報で確かめてください。<br>経済のつながり ${esc(VERSION)}</p>`;
const VERDICT = { 当たり: "hit", 一部当たり: "part", 外れ: "miss", まだわからない: "wait" };
const HINT = `<p class="hint"><span class="term-demo">点線の言葉</span>はタップすると意味が出ます</p>`;
const relList = ids => ids.map(id => newsById[id]).filter(Boolean).slice(0, 4)
  .map(n => `<button data-news="${esc(n.id)}">${esc(newsTitle(n))}<span class="src">${esc(n.source)}・${esc(ago(n.time))}</span></button>`).join("");

// ---------- 今日 ----------
// 一覧では要点だけを見せ、くわしい中身はタップで開く
function renderToday() {
  const b = D.brief || { themes: [] };
  const upd = D.updated ? new Date(D.updated) : null;
  const moving = (D.moving || []).slice(0, 8).map(m => chip(m.node, m.dir)).join("");
  const wk = X.weekly;
  const showWeek = wk && (Date.now() - new Date(wk.made)) < 4 * 86400000;
  const rv = X.reviews[0];
  const guide = store.get("guideDone", false) ? "" : `<div class="card guide">
      <h3>このアプリの読み方</h3>
      <ol><li><b>今日のテーマ</b>で、何が起きたかをつかむ</li><li>タップして、<b>なぜ・この先どうなるか</b>を読む</li><li><span class="term-demo">点線の言葉</span>はタップすると意味が出る</li></ol>
      <button class="btn ghost" data-guide>わかった</button></div>`;
  $("#v-today").innerHTML = `
    <p class="date-line">${upd ? `${upd.getMonth() + 1}月${upd.getDate()}日（${WD[upd.getDay()]}）の世の中` : ""}</p>
    <h1 class="headline">${esc(b.headline || "今日のニュースを集めています")}</h1>
    ${guide}
    <div class="markets">${["usdjpy", "jgb10", "ust10"].map(marketCard).join("")}</div>
    ${showWeek ? `<button class="card week-card" data-weekly="${esc(wk.id)}"><div class="no">今週のまとめ・${esc(md(wk.from))}〜${esc(md(wk.to))}</div><h3>${esc(wk.title)}</h3><p class="more">読む →</p></button>` : ""}
    <div class="sec"><h2>今日のテーマ</h2><span class="aside">タップでくわしく</span></div>
    <div class="trows">${(b.themes || []).map(themeRow).join("") || `<div class="card"><p class="muted small">AI の読み解きは次の更新で表示されます。ニュースの一覧は「ニュース」から見られます。</p></div>`}</div>
    ${agendaRows(3)}
    ${moving ? `<div class="sec"><h2>いま動いているもの</h2><span class="aside">タップで仕組み</span></div><div class="chips">${moving}</div>` : ""}
    ${rv && rv.reviewed === todayStr() ? `<div class="sec"><h2>答え合わせ</h2></div><a class="card link-card" href="#learn"><div class="no">${esc(md(rv.target))}の「この先どうなるかも」</div><p>${esc(rv.summary)}</p><span class="more">学ぶで見る →</span></a>` : ""}
    ${(D.quiz || []).length ? `<div class="sec"><h2>考えてみる</h2></div><a class="card link-card" href="#learn"><p>${esc(D.quiz[0].q)}</p><span class="more">学ぶで答える →</span></a>` : ""}
    ${foot()}`;
}
function themeRow(t, i) {
  const th = threadByName[t.thread];
  return `<button class="card trow" data-theme="${i}">
    <div class="tr-top"><span class="tr-no">${i + 1}</span><h3>${esc(t.title)}</h3></div>
    <p class="tr-pt">${esc(t.point || firstSentence(t.what))}</p>
    <div class="chain">${chainHtml(t.chain, true)}</div>
    <div class="tr-foot">${th && th.entries.length > 1 ? `<span>流れ：${th.entries.length}日目</span>` : "<span></span>"}<span class="more">くわしく →</span></div>
  </button>`;
}
function openTheme(i) {
  const t = D.brief?.themes?.[i];
  if (!t) return;
  const S = new Set();
  const th = threadByName[t.thread];
  // 点線は画面の上から最初の1回だけ付けるので、表示の順に組み立てる（識者の見方は下で作る）
  const voices = () => (t.experts || []).map(id => expertById[id]).filter(Boolean).slice(0, 2)
    .map(e => `<div class="voice"><div class="who">${esc(e.name)}<span class="muted" style="font-weight:500">｜${esc(e.role)}</span></div>${gl(e.view, S)}</div>`).join("");
  const hasVoices = (t.experts || []).some(id => expertById[id]);
  const rel = relList(t.news || []);
  const conf = (t.chain || []).filter(c => c.conflict).map(c => `<p class="conf-note">※ ${esc(c.conflict)}。ここでは仕組みとしての向きです。</p>`).join("")
    + ((t.chain || []).some(c => c.known === false) ? `<p class="conf-note">※ 色の付いた矢印（→）は、つながり図の基本の関係にない、今回 AI が考えたつながりです。</p>` : "");
  const first = (t.chain || [])[0];
  openSheet(`
    <p class="cat">テーマ ${i + 1}${th ? `・流れ「${esc(th.name)}」${th.entries.length}日目` : ""}</p>
    <h2>${esc(t.title)}</h2>
    <div class="q-sec"><div class="q-h">何が起きた？</div><p>${gl(t.what, S)}</p></div>
    <div class="q-sec"><div class="q-h">どうつながる？</div><div class="chain">${chainHtml(t.chain)}</div><p>${gl(t.chain_text, S)}</p>${conf}</div>
    <div class="q-sec"><div class="q-h">この先どうなるかも</div><ul class="outlook">${(t.outlook || []).map(o => `<li>${gl(o, S)}</li>`).join("")}</ul></div>
    ${t.watch ? `<div class="q-sec"><div class="q-h">次に見るもの</div><p>${gl(t.watch, S)}</p></div>` : ""}
    ${hasVoices ? `<div class="q-sec"><div class="q-h">識者はどう見ている？</div>${voices()}</div>` : ""}
    ${rel ? `<div class="q-sec"><div class="q-h">元のニュース</div><div class="rel">${rel}</div></div>` : ""}
    <div class="row-btns">${first ? `<button class="btn" data-sim="${esc(first.node)}:${esc(first.dir)}">広がる影響を図で見る</button>` : ""}${th && th.entries.length > 1 ? `<button class="btn ghost" data-thread="${esc(th.name)}">これまでの流れ</button>` : ""}</div>
    ${HINT}`);
}

// ---------- 予定とシナリオ ----------
let AGENDA = [];
function agendaItems() {
  const today = todayStr();
  // 結果が出たあとも、次の日までは残す（シナリオと照らせるように）
  const y = new Date(); y.setDate(y.getDate() - 1);
  const since = y.toLocaleDateString("sv");
  const cal = (D.calendar || []).filter(e => e.date >= since);
  const sc = [...(D.scenarios || [])];
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
    <div class="ag-main"><b>${esc(e.name)}</b><span>${e.date && e.date < todayStr() ? (e.scenario ? "結果が出ました。シナリオと照らす" : "結果が出ました") : e.scenario ? "結果しだいの2通りを見る" : esc(e.note || "")}</span></div>
    <span class="chev" aria-hidden="true">›</span></button>`;
}
function agendaRows(limit) {
  AGENDA = agendaItems();
  if (!AGENDA.length) return "";
  return `<div class="sec"><h2>これからの予定</h2><span class="aside">結果しだいでどうなる？</span></div>
    <div class="card ag-list">${AGENDA.slice(0, limit).map(agendaRow).join("")}
    ${AGENDA.length > limit ? `<button class="ag-all" data-agenda>予定をすべて見る（${AGENDA.length}）</button>` : ""}</div>`;
}
function openAgendaItem(i) {
  const e = AGENDA[i];
  if (!e) return;
  const s = e.scenario;
  const S = new Set();
  openSheet(`<p class="cat">これからの予定${e.date ? `・${esc(md(e.date))}（${esc(dayLabel(e.date))}）` : ""}</p>
    <h2>${esc(e.name)}</h2>
    ${e.note ? `<p class="muted small">${esc(e.note)}</p>` : ""}
    ${(e.nodes || []).length ? `<div class="q-sec"><div class="q-h">動きそうなもの</div><div class="chips">${e.nodes.map(n => chip(n)).join("")}</div></div>` : ""}
    ${e.date && e.date < todayStr() ? `<p class="note">結果が出ました。下の2通りのどちらに近かったか、「ニュース」で確かめてみましょう。</p>` : ""}
    ${s ? `<div class="q-sec"><div class="q-h">焦点</div><p>${gl(s.focus, S)}</p></div>
      <div class="q-sec"><div class="q-h">結果しだいで、こう広がるかも</div>
      <div class="cases">${s.cases.map((c, k) => `<div class="case c${k}"><div class="case-l">${esc(c.label)}</div><div class="chain">${chainHtml(c.chain)}</div><p>${gl(c.text, S)}</p></div>`).join("")}</div></div>` : `<p class="note">2週間以内になると、結果しだいのシナリオが付きます。</p>`}
    ${HINT}`);
}
function openAgenda() {
  openSheet(`<p class="cat">これからの予定</p><h2>予定と、結果しだいの広がり</h2>
    <p class="muted small" style="margin-top:6px">FRB・日銀・内閣府の公式の日程と、ニュースに出てきた予定。</p>
    <div class="card ag-list" style="margin-top:14px">${AGENDA.map(agendaRow).join("")}</div>`);
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
    ${featured ? `<p class="news-section-note">重要度と分野の広がりから、全体をつかむ入口に。</p>` : ""}
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
      <p class="page-sub" style="margin-top:12px">同じ話題が日をまたいでどう続いているか。</p>
      ${X.threads.length ? X.threads.map(threadCard).join("") : `<p class="empty">流れは、更新のたびにたまっていきます。</p>`}
      <div class="sec"><h2>週のまとめ</h2><span class="aside">土曜の朝に1本</span></div>
      ${X.weeks.length ? `<div class="rel">${X.weeks.map(w => `<button data-weekly="${esc(w.id)}">${esc(w.title)}<span class="src">${esc(md(w.from))}〜${esc(md(w.to))}</span></button>`).join("")}</div>` : `<p class="note">最初の週のまとめは、土曜の朝の更新で作られます。</p>`}
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
    <p class="page-sub" style="margin-top:12px">${state.newsCat === "all" ? `全${all.length}本を表示。` : `${esc(selectedName)}の${list.length}本を表示。`}見出しをタップすると、要点とこの先が読めます。${(D.sources || []).length ? `<button class="src-link" data-sources>${D.sources.filter(x => x.collected).length}の媒体から集めています ›</button>` : ""}</p>
    <div class="chips scroll news-filters" role="group" aria-label="分野で絞り込む">${filters.map(([id, name]) => `<button class="filter ${state.newsCat === id ? "on" : ""}" data-newscat="${esc(id)}" aria-pressed="${state.newsCat === id}">${esc(name)}</button>`).join("")}</div>
    ${body || `<p class="empty">この分野のニュースは、いまはありません。</p>`}
    ${foot()}`;
  $("#v-news .news-filters").scrollLeft = filtersScroll;
}
function threadCard(t) {
  const last = t.entries[t.entries.length - 1];
  const first = t.entries[0];
  return `<button class="card thread" data-thread="${esc(t.name)}">
    <div class="no">${t.entries.length}日分・${esc(md(first.date))}〜${esc(md(last.date))}</div>
    <h3>${esc(t.name)}</h3>
    <p class="what">${esc(last.title)}</p>
    <div class="dots" aria-hidden="true">${t.entries.slice(-14).map(() => "<i></i>").join("")}</div>
  </button>`;
}
function openThread(name) {
  const t = threadByName[name];
  if (!t) return;
  const S = new Set();
  openSheet(`<p class="cat">流れ・${t.entries.length}日分</p><h2>${esc(t.name)}</h2>
    <div class="timeline">${[...t.entries].reverse().map(e => `<div class="tl">
      <div class="tl-date">${esc(md(e.date))}</div>
      <div class="tl-body"><h3>${esc(e.title)}</h3><p>${gl(e.what, S)}</p>
        <div class="chain" style="margin-top:8px">${chainHtml(e.chain)}</div></div></div>`).join("")}</div>
    ${HINT}`);
}
// 英語の記事は、AI が付けた日本語の見出しを出す（元の見出しは詳細に）
const newsTitle = n => n.title_ja || n.title;
// 集めている媒体（分け方ごとに、集めた本数と、AI が選んで載せた本数）
function openSources() {
  const groups = new Map();
  for (const x of D.sources || []) { if (!groups.has(x.group)) groups.set(x.group, []); groups.get(x.group).push(x); }
  const total = (D.sources || []).reduce((a, x) => a + x.collected, 0);
  openSheet(`<p class="cat">ニュース</p><h2>集めている媒体</h2>
    <p class="muted small" style="margin-top:6px">直近1日半の見出し ${total}本から、AI が経済の流れに大事なものを選んで載せています。1つの媒体に偏りすぎないよう、媒体ごとに取り込む本数に上限があります。</p>
    ${[...groups].map(([g, list]) => `<div class="q-sec"><div class="q-h">${esc(g || "そのほか")}</div><div class="src-list">${list.map(x => `<div class="src-row"><span>${esc(x.name)}${x.lang === "en" ? `<small>英語</small>` : ""}</span><span class="muted small">集めた${x.collected}・載せた${x.shown}</span></div>`).join("")}</div></div>`).join("")}
    <p class="note">識者の発信（note・記事・研究所のレポート）は「識者」の画面に出ます。</p>`);
}
function newsRow(n, featured = false) {
  const category = G.cats.find(c => c.id === primaryNewsCat(n));
  return `<button class="item news-item" data-news="${esc(n.id)}">
    <span class="news-item-main"><span class="t">${esc(newsTitle(n))}</span>
    <span class="m">${featured && category ? `<span class="news-category">${esc(category.name)}</span>` : ""}${n.level >= 3 ? `<span class="news-importance">重要</span>` : ""}${n.lang === "en" ? `<span class="news-more">英語</span>` : ""}<span>${esc(n.source)}</span><span>${esc(ago(n.time))}</span>${(n.related || []).length ? `<span class="news-more">ほか${n.related.length}本</span>` : ""}</span></span>
    <span class="news-chevron" aria-hidden="true">›</span>
  </button>`;
}
function openNews(id) {
  const n = newsById[id];
  if (!n) return;
  const S = new Set();
  const t0 = (n.tags || []).find(t => G.byId[t.node] && [1, -1].includes(dirNum(t.dir)));
  let ripple = "";
  if (t0) {
    const { res, waves } = simulate(G, t0.node, dirNum(t0.dir), 2);
    ripple = `<div class="q-sec"><div class="q-h">ここから広がる影響</div>
      <div class="links">${waves.flat().slice(0, 4).map(v => hopRow(v, res[v])).join("")}</div>
      <div class="row-btns"><button class="btn ghost" data-sim="${esc(t0.node)}:${dirNum(t0.dir) > 0 ? "up" : "down"}">広がる影響を図で見る</button></div></div>`;
  }
  const url = safeUrl(n.link);
  openSheet(`
    <p class="cat">${esc(n.source)}・${esc(fmtTime(n.time))}</p>
    <h2>${gl(newsTitle(n), S)}</h2>
    ${n.title_ja ? `<p class="muted small" lang="en">元の見出し（英語）：${esc(n.title)}</p>` : ""}
    ${n.plain ? `<div class="q-sec"><div class="q-h">ひとことで</div><p>${gl(n.plain, S)}</p></div>` : ""}
    ${n.next ? `<div class="q-sec"><div class="q-h">この先</div><p>${gl(n.next, S)}</p></div>` : ""}
    ${url ? `<a class="outbtn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">元の記事を読む</a>` : ""}
    ${(n.related || []).length ? `<details class="fold"><summary>同じ出来事の別の記事（${n.related.length}）</summary><div class="rel">${n.related.map(r => safeUrl(r.link) ? `<a href="${esc(safeUrl(r.link))}" target="_blank" rel="noopener noreferrer">${esc(r.title)}<span class="src">${esc(r.source)}・${esc(ago(r.time))}</span></a>` : "").join("")}</div></details>` : ""}
    ${(n.tags || []).length || ripple ? `<details class="fold news-connections"><summary>このニュースは何につながる？</summary>
      ${(n.tags || []).length ? `<div class="q-sec"><div class="q-h">関係するもの</div><div class="chips">${n.tags.map(t => chip(t.node, t.dir, { full: true })).join("")}</div></div>` : ""}
      ${ripple}</details>` : ""}
    ${HINT}`);
}
function hopRow(v, r) {
  const n = G.byId[v];
  const from = [...new Set(r.via.map(a => G.byId[a.from].short))].join("・");
  return `<button class="link-row" data-node="${esc(v)}"><div class="hd">${chip(v, r.dir, { span: true })}<span class="from muted small">← ${esc(from)}</span></div><p class="why">${esc(r.dir === 0 ? "逆向きの力がぶつかる（綱引き）" : r.via[0].edge.why)}</p></button>`;
}

// ---------- 項目の詳細 ----------
function openNode(id) {
  const n = G.byId[id];
  if (!n) return;
  const S = new Set();
  const m = n.market && D.markets?.[n.market];
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
  const mv = (D.moving || []).find(x => x.node === id);
  const outs = G.out[id].map(e => `<button class="link-row" data-node="${esc(e.to)}"><div class="hd"><span class="small muted">${esc(n.up)}すると</span>${chip(e.to, e.sign, { span: true })}</div><p class="why">${esc(e.why)}</p></button>`).join("");
  const ins = G.inn[id].map(e => `<button class="link-row" data-node="${esc(e.from)}"><div class="hd">${chip(e.from, 1, { span: true })}<span class="small muted">→ ${esc(n.short)}は${esc(dirWord(n, e.sign))}</span></div><p class="why">${esc(e.why)}</p></button>`).join("");
  const news = (D.news || []).filter(x => (x.tags || []).some(t => t.node === id)).slice(0, 4);
  openSheet(`
    <p class="cat">${esc(G.catName[n.cat])}</p>
    <h2>${esc(n.name)}</h2>
    <div class="q-sec"><div class="q-h">これは何？</div><p>${gl(n.desc, S)}</p></div>
    <div class="q-sec"><div class="q-h">暮らしでは</div><p>${gl(n.life, S)}</p></div>
    ${mv ? `<div class="q-sec"><div class="q-h">今日の動き</div><div class="hd" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${chip(id, mv.dir, { full: true })}<span class="small">${gl(mv.why, S)}</span></div></div>` : ""}
    ${market}
    <div class="row-btns"><button class="btn" data-walkto="${esc(id)}">つながりを図でたどる</button><button class="btn up" data-sim="${esc(id)}:up">${esc(n.up)}したら？</button><button class="btn down" data-sim="${esc(id)}:down">${esc(n.down)}したら？</button></div>
    ${outs ? `<details class="fold"><summary>影響を与える先（${G.out[id].length}）</summary><div class="links">${outs}</div></details>` : ""}
    ${ins ? `<details class="fold"><summary>影響を受ける元（${G.inn[id].length}）</summary><div class="links">${ins}</div></details>` : ""}
    ${news.length ? `<div class="q-sec"><div class="q-h">関係する今日のニュース</div><div class="rel">${news.map(x => `<button data-news="${esc(x.id)}">${esc(newsTitle(x))}<span class="src">${esc(x.source)}・${esc(ago(x.time))}</span></button>`).join("")}</div></div>` : ""}
    ${HINT}`);
}

// ---------- つながり図 ----------
function mapSvg() {
  const edges = G.edges.map(e => `<path class="edge" data-e="${e.from}>${e.to}" d="${edgePath(G, e)}" marker-end="url(#ar)"/>`).join("");
  const nodes = G.nodes.map(n => {
    const p = G.pos[n.id];
    return `<g class="node" data-walk="${n.id}" role="button" tabindex="0" aria-label="${esc(n.name)}"><rect x="${p.x - NODE_W / 2}" y="${p.y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="9"/><text x="${p.x}" y="${p.y}">${esc(n.short)}</text></g>`;
  }).join("");
  return `<svg class="map" id="map" viewBox="0 0 ${MAP_W} ${MAP_H}" role="img" aria-label="経済のつながり図">
    <defs>${markers()}</defs><g>${edges}</g><g>${nodes}</g></svg>`;
}
const markers = () => [["ar", "--line"], ["ar-up", "--up"], ["ar-down", "--down"], ["ar-mix", "--mix"], ["ar-ink", "--ink-3"]]
  .map(([id, v]) => `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" style="fill:var(${v})"/></marker>`).join("");

// 1つの項目を真ん中に、原因（上）と影響（下）だけを大きく描く
function egoSvg(id) {
  const c = G.byId[id];
  const W = 360, BW = 106, BH = 46, GX = 10, GY = 12, PER = 3, CW = 236, CH = 58;
  const ins = G.inn[id], outs = G.out[id];
  const rows = n => Math.ceil(n / PER);
  const place = (list, y0) => list.map((e, i) => {
    const r = Math.floor(i / PER), cnt = Math.min(PER, list.length - r * PER), k = i % PER;
    const x0 = (W - (cnt * BW + (cnt - 1) * GX)) / 2;
    return { e, x: x0 + k * (BW + GX), y: y0 + r * (BH + GY) };
  });
  const inY = ins.length ? 24 : 0;
  const inP = place(ins, inY);
  const cy = ins.length ? inY + rows(ins.length) * (BH + GY) + 34 : 8;
  const outY = cy + CH + (outs.length ? 52 : 0);
  const outP = place(outs, outY);
  const H = outs.length ? outY + rows(outs.length) * (BH + GY) : cy + CH + 8;
  const cx = W / 2;
  const sw = s => (s === 3 ? 2.2 : s === 2 ? 1.5 : 1);
  const curve = (x1, y1, x2, y2) => `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
  const box = (p, nodeId, sub, subCls) => {
    const n = G.byId[nodeId];
    return `<g class="enode" data-walk="${n.id}" role="button" tabindex="0" aria-label="${esc(n.name)}"><rect x="${p.x}" y="${p.y}" width="${BW}" height="${BH}" rx="11"/><text class="en" x="${p.x + BW / 2}" y="${p.y + 17}">${esc(n.short)}</text><text class="es ${subCls}" x="${p.x + BW / 2}" y="${p.y + 34}">${esc(sub)}</text></g>`;
  };
  const inEdges = inP.map(p => {
    const spread = (p.x + BW / 2 - cx) * 0.35;
    return `<path class="eedge ${p.e.strength === 1 ? "weak" : ""}" d="${curve(p.x + BW / 2, p.y + BH, cx + spread, cy - 2)}" style="stroke-width:${sw(p.e.strength)}" marker-end="url(#ar-ink)"/>`;
  }).join("");
  const outEdges = outP.map(p => {
    const spread = (p.x + BW / 2 - cx) * 0.35;
    return `<path class="eedge ${p.e.strength === 1 ? "weak" : ""}" d="${curve(cx + spread, cy + CH + 2, p.x + BW / 2, p.y - 2)}" style="stroke-width:${sw(p.e.strength)}" marker-end="url(#ar-ink)"/>`;
  }).join("");
  const inBoxes = inP.map(p => box(p, p.e.from, `${G.byId[p.e.from].up}→${dirWord(c, p.e.sign)}`, p.e.sign > 0 ? "up-f" : "down-f")).join("");
  const outBoxes = outP.map(p => box(p, p.e.to, `${c.up}→${dirWord(G.byId[p.e.to], p.e.sign)}`, p.e.sign > 0 ? "up-f" : "down-f")).join("");
  return `<svg class="ego" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.name)}のつながり"><defs>${markers()}</defs>
    ${ins.length ? `<text class="elabel" x="${cx}" y="12">原因になるもの（タップでさかのぼる）</text>` : ""}
    ${outs.length ? `<text class="elabel" x="${cx}" y="${outY - 16}">影響が出る先（タップで先へ）</text>` : ""}
    ${inEdges}${outEdges}${inBoxes}${outBoxes}
    <g class="ecenter" data-node="${c.id}" role="button" tabindex="0" aria-label="${esc(c.name)}の仕組み"><rect x="${cx - CW / 2}" y="${cy}" width="${CW}" height="${CH}" rx="14"/><text class="ec" x="${cx}" y="${cy + 24}">${esc(c.name)}</text><text class="ecs" x="${cx}" y="${cy + 43}">タップで仕組みを読む</text></g>
  </svg>`;
}
function walkHtml() {
  const id = state.walk[state.walk.length - 1] || "boj";
  const n = G.byId[id];
  const trail = state.walk.length > 1 ? `<div class="trail"><span class="muted small">たどった道</span>${state.walk.map((w, i) => `${i ? `<span class="arrow">→</span>` : ""}<button class="tag ${i === state.walk.length - 1 ? "here" : ""}" data-trail="${i}"><span class="nm">${esc(G.byId[w].short)}</span></button>`).join("")}<button class="filter" data-trail="reset">最初から</button></div>` : "";
  return `${trail}
    <div class="map-box ego-box">${egoSvg(id)}</div>
    <p class="hint" style="margin-top:8px">小さな字は向きの関係（例：${esc(n.up)}→…）。線が太いほど強い関係、点線は条件しだい。</p>`;
}
function renderMap() {
  const p = G.byId[state.simPick];
  const walking = state.mapMode === "walk";
  const trying = state.mapMode === "try";
  const examples = [
    ["boj", "up", "日銀が利上げしたら？", "住宅ローンや円相場に、どう広がる？"],
    ["usdjpy", "down", "円高になると？", "輸入品と輸出企業で、影響はどう違う？"],
    ["oil", "up", "原油が値上がりしたら？", "ガソリン代から、ほかの物価にも広がる？"],
  ];
  $("#v-map").innerHTML = `
    <h1 class="page-title">つながり</h1>
    <p class="page-sub connect-intro">ニュースの「それで、どうなる？」を考える。暮らしや企業への影響を、原因からたどれます。</p>
    <div class="seg connect-tabs" role="group" aria-label="つながりの使い方">
      ${[["try", "影響を考える"], ["walk", "原因をたどる"], ["all", "全体図"]].map(([id, label]) => `<button class="${state.mapMode === id ? "on" : ""}" data-mapmode="${id}" aria-pressed="${state.mapMode === id}">${label}</button>`).join("")}
    </div>
    ${trying ? `<section class="connect-start" aria-labelledby="connect-start-title">
      <h2 id="connect-start-title">${state.sim ? "別の条件でも考えてみる" : "まずは、身近な疑問から"}</h2>
      <div class="scenario-list ${state.sim ? "compact" : ""}">${examples.map(([id, dir, title, desc]) => `<button class="scenario" data-sim="${id}:${dir}"><span><b>${title}</b>${state.sim ? "" : `<span class="scenario-desc">${desc}</span>`}</span><span class="scenario-go" aria-hidden="true">→</span></button>`).join("")}</div>
    </section>
    <section class="sim-workspace" aria-labelledby="sim-title">
      <div class="sec" id="sim-sec"><h2 id="sim-title">${state.sim ? "考える条件" : "自分で条件を選ぶ"}</h2></div>
      <button class="pick-btn" data-picker><span class="muted small">起点</span><b>${esc(p.name)}</b><span class="chg">変える</span></button>
      <div class="dir-toggle">
        <button class="up ${state.sim && state.simDir > 0 ? "on" : ""}" data-simdir="1" aria-pressed="${!!state.sim && state.simDir > 0}">↑ ${esc(p.up)}</button>
        <button class="down ${state.sim && state.simDir < 0 ? "on" : ""}" data-simdir="-1" aria-pressed="${!!state.sim && state.simDir < 0}">↓ ${esc(p.down)}</button>
      </div>
      <div id="sim-result" aria-live="polite"></div>
    </section>` : walking ? `
      <div class="connect-explain"><h2>なぜ動く？ 次はどこへ？</h2><p>上は原因、下は影響。項目をタップして進むと、ニュースの背景や次に注目する先が分かります。</p><button class="btn ghost" data-picker>別の項目からたどる</button></div>
      ${walkHtml()}
      <button class="btn connect-next" data-sim="${esc(state.walk[state.walk.length - 1] || state.simPick)}:up">この項目が変わったら？ 影響を試す →</button>` : `
    <div class="connect-explain"><h2>経済の中での位置をつかむ</h2><p>31項目をまとめた地図です。項目をタップすると、関係のある原因と影響だけを大きく見られます。</p></div>
    <div class="chips" style="margin-bottom:10px" id="map-mode"></div>
    <div class="map-box">${mapSvg()}</div>
    <div class="legend"><span><i style="background:var(--up)"></i>上がる方向</span><span><i style="background:var(--down)"></i>下がる方向</span><span><i style="background:var(--mix)"></i>逆向きの力</span></div>
    <button class="btn connect-next" data-mapmode="try">条件を選んで、影響を考える →</button>`}
    ${foot()}`;
  if (state.mapMode === "all") paintMap();
  if (trying) renderSimResult();
}
function openPicker() {
  const selected = state.mapMode === "walk" ? state.walk[state.walk.length - 1] || state.simPick : state.simPick;
  const groups = G.cats.map(c => {
    const ns = G.nodes.filter(n => n.cat === c.id);
    return `<div class="q-sec"><div class="q-h">${esc(c.name)}</div><div class="chips">${ns.map(n => `<button class="filter ${selected === n.id ? "on" : ""}" data-pick="${n.id}" aria-pressed="${selected === n.id}">${esc(n.short)}</button>`).join("")}</div></div>`;
  }).join("");
  openSheet(`<p class="cat">${state.mapMode === "walk" ? "原因をたどる" : "影響を考える"}</p><h2>気になる項目を選ぶ</h2><div class="connect-picker">${groups}</div>`);
}
function walkTo(id, fresh = false) {
  if (fresh || !state.walk.length) state.walk = [id];
  else if (state.walk[state.walk.length - 1] !== id) state.walk = [...state.walk, id].slice(-8);
  state.mapMode = "walk";
  if (state.view !== "map") { location.hash = "#map"; return; }
  const y = window.scrollY;
  renderMap();
  window.scrollTo(0, Math.max(0, Math.min(y, $("#v-map .seg")?.getBoundingClientRect().top + window.scrollY - 70)));
}
function paintMap() {
  const svg = $("#map");
  if (!svg) return;
  const mode = $("#map-mode");
  $$(".node", svg).forEach(el => { el.className.baseVal = "node"; });
  $$(".edge", svg).forEach(el => { el.setAttribute("class", "edge"); el.setAttribute("marker-end", "url(#ar)"); });
  if (state.sim) {
    const { res } = simulate(G, state.sim.start, state.sim.dir);
    svg.classList.add("active");
    for (const [v, r] of Object.entries(res)) {
      const el = $(`.node[data-walk="${v}"]`, svg);
      el.className.baseVal = `node lit ${dirClass(r.dir)} ${r.wave === 0 ? "origin" : ""}`;
      setTimeout(() => el.classList.add("pulse"), r.wave * 380);
      for (const a of r.via) {
        const pe = $(`.edge[data-e="${a.from}>${v}"]`, svg);
        if (pe) { pe.setAttribute("class", `edge hot ${dirClass(r.dir)}`); pe.setAttribute("marker-end", `url(#ar-${dirClass(r.dir)})`); }
      }
    }
    const s = G.byId[state.sim.start];
    mode.innerHTML = `<span class="tag ${dirClass(state.sim.dir)}"><span class="nm">${esc(s.short)}</span>${esc(dirWord(s, state.sim.dir))}した場合</span>${(D.moving || []).length ? `<button class="filter" data-today-map>ニュースの注目項目に戻す</button>` : ""}`;
  } else {
    const mv = D.moving || [];
    if (mv.length) {
      svg.classList.add("active");
      const set = new Map(mv.map(m => [m.node, dirNum(m.dir)]));
      for (const [v, d] of set) $(`.node[data-walk="${v}"]`, svg).className.baseVal = `node lit ${dirClass(d)}`;
      for (const e of G.edges) {
        if (set.has(e.from) && set.has(e.to) && set.get(e.from) * e.sign === set.get(e.to)) {
          const pe = $(`.edge[data-e="${e.from}>${e.to}"]`, svg);
          const c = dirClass(set.get(e.to));
          pe.setAttribute("class", `edge hot ${c}`); pe.setAttribute("marker-end", `url(#ar-${c})`);
        }
      }
      mode.innerHTML = `<span class="tag"><span class="nm">ニュースで注目の項目</span></span>`;
    } else {
      svg.classList.remove("active");
      mode.innerHTML = "";
    }
  }
}
// 上下どちらにも使う文なので、上昇だけを前提にした元の説明は中立にする。
function impactLife(n) {
  return ({
    import_prices: "ガソリン・電気・食品など、身近な値段に関わる。",
    labor_shortage: "賃金、サービスの値段や営業時間に関わる。",
    banks: "預金金利や、銀行株の値動きにつながる。",
    risk_off: "株価、金や国債の値動きとして表れる。",
  })[n.id] || n.life;
}
function renderSimResult() {
  const box = $("#sim-result");
  if (!box) return;
  if (!state.sim) { box.innerHTML = `<p class="sim-prompt">上の疑問か、起点と向きを選ぶと、<b>何に影響するか・暮らしとどう関わるか</b>が出ます。</p>`; return; }
  const { res, waves } = simulate(G, state.sim.start, state.sim.dir);
  const s = G.byId[state.sim.start];
  // 身近な影響を先に3つ。経路そのものは下で必要なときに開く。
  const priority = ["mortgage", "import_prices", "exporters", "jp_cpi", "household", "wages", "consumption", "jp_economy", "usdjpy", "banks"];
  const affected = waves.flat();
  const focus = [...affected].sort((a, b) => {
    const score = id => { const i = priority.indexOf(id); return i < 0 ? 100 + res[id].wave : i; };
    return score(a) - score(b);
  }).slice(0, 3);
  const related = (D.news || []).filter(n => (n.tags || []).some(t => t.node === s.id)).slice(0, 2);
  box.innerHTML = `
    <section class="sim-takeaway" aria-labelledby="takeaway-title">
      <p class="eyebrow">${esc(s.name)}が「${esc(dirWord(s, state.sim.dir))}」なら</p>
      <h2 id="takeaway-title">${focus.length ? "たとえば、ここに影響する" : "この図でたどれる先はありません"}</h2>
      ${focus.length ? `<p class="takeaway-hint">暮らしや仕事と結び付けると？ タップで理由へ。</p><div class="impact-list">${focus.map(id => {
        const n = G.byId[id], r = res[id];
        return `<button class="impact-row" data-hop="${esc(id)}"><span class="impact-head"><b>${esc(n.name)}</b><span class="impact-dir ${dirClass(r.dir)}-t">${esc(dirWord(n, r.dir))}${r.dir ? "方向" : ""}</span></span><span class="impact-life">${esc(impactLife(n))}</span><span class="impact-more">${r.dir ? "どうつながる？" : "なぜ力がぶつかる？"} →</span></button>`;
      }).join("")}</div>` : `<p>ほかの起点を選ぶか、「原因をたどる」でこの項目につながる元を探せます。</p>`}
      <p class="sim-limit">ほかの条件が同じ場合の傾向です。実際には逆向きの力も働きます。</p>
    </section>
    ${affected.length ? `<details class="fold sim-paths"><summary>影響の道すじを順に見る（${affected.length}項目）</summary>
      ${waves.map((list, i) => `<div class="wave"><div class="wave-h">${i + 1}段目${i === 0 ? " · 直接の影響" : " · その先の影響"}</div><div class="hops">${list.map(v => simHop(v, res[v])).join("")}</div></div>`).join("")}
      <p class="hint">段数はつながりの数で、影響が出るまでの時間ではありません。</p></details>` : ""}
    <div class="row-btns"><button class="btn ghost" data-mapmode="all">この条件を全体図で見る</button></div>
    <section class="sim-reality"><h2>ニュースを読むときに使う</h2><p>「どこへ影響が広がるか」を考えたら、実際のニュースで同じ動きがあるか確かめてみましょう。</p>
      ${related.length ? `<div class="rel">${relList(related.map(n => n.id))}</div>` : ""}
      <a class="btn ghost connect-next" href="#news">ニュースで確かめる →</a></section>`;
}
// 段ごとの一覧は名前と向きだけにして、理由はタップで読む
function simHop(v, r) {
  const from = [...new Set(r.via.map(a => G.byId[a.from].short))].join("・");
  return `<button class="hop2" data-hop="${esc(v)}">${chip(v, r.dir, { span: true })}<span class="from">← ${esc(from)}</span></button>`;
}
function openHop(v) {
  if (!state.sim) return openNode(v);
  const { res } = simulate(G, state.sim.start, state.sim.dir);
  const r = res[v], n = G.byId[v];
  if (!r) return openNode(v);
  const lines = r.via.slice(0, 3).map(a => {
    const f = G.byId[a.from], fd = res0(a);
    // 説明文は「上がる場合」で書いてあるので、下がる向きのときはそう添える
    return `<div class="q-sec"><div class="q-h">${esc(f.short)}が${esc(dirWord(f, fd))} → ${esc(n.short)}は${esc(dirWord(n, a.dir))}</div><p>${gl(a.edge.why)}</p>${fd < 0 ? `<p class="muted small">（説明は${esc(f.up)}の場合。${esc(f.down)}のときは逆に働く）</p>` : ""}<p class="meta-line">時間の目安：${esc(a.edge.lag)}・関係の強さ：${esc(STRENGTH[a.edge.strength])}</p></div>`;
  }).join("");
  const path = [];
  let at = v;
  const visited = new Set();
  while (res[at] && !visited.has(at)) {
    visited.add(at); path.unshift({ node: at, dir: res[at].dir });
    const prev = res[at].via[0];
    if (!prev) break;
    at = prev.from;
  }
  openSheet(`<p class="cat">なぜ、ここに影響する？</p><h2>${esc(n.name)}は${esc(dirWord(n, r.dir))}${r.dir === 0 ? "（逆向きの力がぶつかる）" : "方向"}</h2>
    <div class="q-sec"><div class="q-h">起点からの道すじ${r.dir === 0 ? "の一例" : ""}</div><div class="chain">${chainHtml(path)}</div></div>
    <div class="q-sec"><div class="q-h">暮らしや仕事との関わり</div><p>${gl(impactLife(n))}</p></div>${lines}
    <div class="row-btns"><button class="btn ghost" data-node="${esc(v)}">${esc(n.short)}の仕組みを読む</button></div>${HINT}`);
}
// 経由した項目の向き（a.dir は到着先の向き、edge.sign で割り戻す）
function res0(a) { return a.dir * a.edge.sign; }
function runSim(node, dir) {
  if (!G.byId[node] || ![1, -1].includes(dir)) return;
  state.sim = { start: node, dir };
  state.simPick = node;
  state.simDir = dir;
  state.mapMode = "try";
  if (state.view !== "map") { location.hash = "#map"; return; }
  renderMap();
  requestAnimationFrame(() => $("#sim-sec")?.scrollIntoView({ block: "start" }));
}

// ---------- 識者 ----------
function renderExperts() {
  const all = D.experts || [];
  const names = [...new Map(all.map(e => [e.expert, e.name])).entries()];
  const list = all.filter(e => state.expert === "all" || e.expert === state.expert);
  const debates = (D.debates || []).map(debateCard).join("");
  $("#v-experts").innerHTML = `
    <h1 class="page-title">識者の見方</h1>
    <p class="page-sub">エコノミストや経済ジャーナリストの、この1週間の発信を短くまとめています。</p>
    ${debates ? `<div class="sec" style="margin-top:8px"><h2>見方が分かれている点</h2></div>${debates}<div class="sec"><h2>それぞれの発信</h2></div>` : ""}
    <div class="chips scroll" role="group" aria-label="人で絞り込む">${[["all", "すべて"], ...names].map(([id, nm]) => `<button class="filter ${state.expert === id ? "on" : ""}" data-expert="${esc(id)}">${esc(nm)}</button>`).join("")}</div>
    <div style="margin-top:14px">${list.map(expertCard).join("") || `<p class="empty">いまは表示できる発信がありません。</p>`}</div>
    <p class="note">X（旧Twitter）と YouTube は、いまは取り込んでいません。note・記事・研究所のレポートを集めています。</p>
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
    <div class="ex-head"><div class="avatar">${esc(e.name.slice(0, 1))}</div><div><div class="n">${esc(e.name)}</div><div class="r">${esc(e.role)}</div></div><span class="stance s-${esc(e.stance)}">${esc(e.stance)}</span></div>
    <p class="ex-view">${gl(e.view, new Set())}</p>
    ${url ? `<a class="ex-src" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(e.kind)}・${esc(e.source)}・${esc(ago(e.time))}<br><b>${esc(e.title)}</b></a>` : ""}
  </article>`;
}

// ---------- 学ぶ ----------
function reviewHtml() {
  const rv = X.reviews[0];
  if (!rv) {
    return `<div class="sec"><h2>答え合わせ</h2></div><p class="note">3日前に書いた「この先どうなるかも」が実際どうなったかを、毎日ここで確かめます。記録が3日分たまると始まります。</p>`;
  }
  const tally = {};
  for (const r of X.reviews) for (const i of r.items) tally[i.verdict] = (tally[i.verdict] || 0) + 1;
  return `<div class="sec"><h2>答え合わせ</h2><span class="aside">${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join("・")}</span></div>
    ${reviewCard(rv, 3)}
    <div class="row-btns" style="margin-top:-2px">${rv.items.length > 3 ? `<button class="btn ghost" data-reviewfull>残り${rv.items.length - 3}件も見る</button>` : ""}${X.reviews.length > 1 ? `<button class="btn ghost" data-reviews>これまでの答え合わせ</button>` : ""}</div>`;
}
function reviewCard(rv, limit = 99) {
  const S = new Set();
  return `<article class="card review"><div class="no">${esc(md(rv.target))}の見通し → ${esc(md(rv.reviewed))}に確認</div>
    <p class="rv-sum">${gl(rv.summary, S)}</p>
    ${rv.items.slice(0, limit).map(i => `<div class="rv-item"><div class="rv-h"><span class="verdict v-${VERDICT[i.verdict] || "wait"}">${esc(i.verdict)}</span><span class="muted small">${esc(i.theme)}</span></div>
      <p class="rv-o">「${gl(i.outlook, S)}」</p><p class="rv-a"><b>実際</b>${gl(i.actual, S)}</p><p class="rv-l"><b>学び</b>${gl(i.lesson, S)}</p></div>`).join("")}
  </article>`;
}
function glossaryHtml() {
  const cats = [...(GLOSSARY?.cats || [])];
  if ((D.terms || []).length) cats.unshift("今日の用語");
  if (!cats.length) return "";
  const cur = state.glCat && cats.includes(state.glCat) ? state.glCat : cats[0];
  const list = Object.values(TERMS).filter(t => t.c === cur);
  return `<div class="sec"><h2>用語集</h2><span class="aside">${Object.keys(TERMS).length}語・タップで意味</span></div>
    <div class="chips scroll" role="group" aria-label="用語の分類">${cats.map(c => `<button class="filter ${c === cur ? "on" : ""}" data-glcat="${esc(c)}">${esc(c)}</button>`).join("")}</div>
    <div class="term-grid">${list.map(t => `<button class="term-btn" data-term="${esc(t.t)}">${esc(t.t)}</button>`).join("")}</div>`;
}
function renderLearn() {
  const sc = store.get("score", { right: 0, total: 0 });
  if (!state.gq) { state.gq = makeGraphQuiz(G); state.gqAnswered = null; }
  const today = (D.quiz || []).map((q, i) => quizCard(q, `t${i}`, state.todayAnswers[i], "今日のニュースから")).join("");
  $("#v-learn").innerHTML = `
    <h1 class="page-title">学ぶ</h1>
    <p class="page-sub">答え合わせ・クイズ・用語集。</p>
    ${reviewHtml()}
    <div class="sec"><h2>つながりクイズ</h2><span class="score">${sc.right} / ${sc.total} 問正解</span></div>
    ${quizCard(state.gq, "g", state.gqAnswered, state.gq.kind)}
    ${state.gqAnswered !== null ? `<div class="row-btns" style="margin-top:-2px;margin-bottom:8px"><button class="btn" data-next-quiz>次の問題</button></div>` : ""}
    ${today ? `<div class="sec"><h2>今日のニュースで考える</h2></div>${today}` : ""}
    ${glossaryHtml()}
    <div class="sec"><h2>つながり図の項目</h2><span class="aside">${G.nodes.length}項目</span></div>
    <div class="glossary">${G.nodes.map(n => `<button class="gl" data-node="${n.id}"><div class="n">${esc(n.name)}</div><div class="d">${esc(n.desc)}</div></button>`).join("")}</div>
    ${foot()}`;
}
function quizCard(q, key, answered, kind) {
  const done = answered !== null && answered !== undefined;
  const choices = q.choices.map((c, i) => {
    const cls = done ? (i === q.answer ? "right" : i === answered ? "wrong" : "") : "";
    return `<button class="choice ${cls}" data-q="${esc(key)}" data-c="${i}" ${done ? "disabled" : ""}>${esc(c)}</button>`;
  }).join("");
  const nodes = (q.nodes || []).map(id => chip(id)).join("");
  return `<article class="card quiz">
    <div class="kind">${esc(kind)}</div>
    <p class="q">${esc(q.q)}</p>
    <div class="choices">${choices}</div>
    ${done ? `<p class="explain"><b>${answered === q.answer ? "正解。" : `答えは「${esc(q.choices[q.answer])}」。`}</b>${gl(q.explain, new Set()).replace(/\n/g, "<br>")}</p>${nodes ? `<div class="chips" style="margin-top:10px">${nodes}</div>` : ""}` : ""}
  </article>`;
}
function answer(key, c) {
  const sc = store.get("score", { right: 0, total: 0 });
  let q;
  if (key === "g") { if (state.gqAnswered !== null) return; state.gqAnswered = c; q = state.gq; }
  else { const i = +key.slice(1); if (state.todayAnswers[i] !== undefined) return; state.todayAnswers[i] = c; q = D.quiz[i]; }
  sc.total += 1; if (c === q.answer) sc.right += 1;
  store.set("score", sc);
  const y = window.scrollY;
  renderLearn();
  window.scrollTo(0, y);
}

// ---------- 週のまとめ ----------
async function openWeekly(id) {
  let w = X.weekly && X.weekly.id === id ? X.weekly : null;
  if (!w) w = await fetch(`data/weekly/${encodeURIComponent(id)}.json`, { cache: "no-cache" }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!w) return;
  const S = new Set();
  openSheet(`<p class="cat">週のまとめ・${esc(md(w.from))}〜${esc(md(w.to))}</p><h2>${esc(w.title)}</h2>
    <div class="q-sec"><div class="q-h">この1週間</div><p>${gl(w.summary, S)}</p></div>
    <div class="q-sec"><div class="q-h">大きな動き</div>
    ${(w.moves || []).map(m => `<div class="wk-move"><h3>${esc(m.title)}</h3><div class="chain">${chainHtml(m.chain)}</div><p>${gl(m.text, S)}</p></div>`).join("")}</div>
    ${w.markets ? `<div class="q-sec"><div class="q-h">相場の1週間</div><p>${gl(w.markets, S)}</p></div>` : ""}
    ${(w.lessons || []).length ? `<div class="q-sec"><div class="q-h">今週わかったつながり</div><ul class="outlook">${w.lessons.map(l => `<li>${gl(l, S)}</li>`).join("")}</ul></div>` : ""}
    ${(w.next_week || []).length ? `<div class="q-sec"><div class="q-h">来週の注目</div><div class="links">${w.next_week.map(n => `<div class="link-row"><div class="hd"><b>${n.date ? esc(md(n.date)) : "日付未定"}</b><span>${esc(n.event)}</span></div><p class="why">${gl(n.why, S)}</p></div>`).join("")}</div></div>` : ""}
    ${HINT}`);
}

// ---------- 下から出る詳細 ----------
let sheetOpen = false;
function openSheet(html) {
  hideTerm();
  $("#sheet-body").innerHTML = html;
  $("#sheet").scrollTop = 0;
  if (!sheetOpen) {
    sheetOpen = true;
    $("#sheet").classList.add("on");
    $("#scrim").classList.add("on");
    document.body.style.overflow = "hidden";
    history.pushState({ sheet: 1 }, "");
  }
}
function hideSheet() {
  sheetOpen = false;
  $("#sheet").classList.remove("on");
  $("#scrim").classList.remove("on");
  document.body.style.overflow = "";
}
function closeSheet() { if (sheetOpen) { if (history.state?.sheet) history.back(); else hideSheet(); } }

// ---------- 画面の切り替え ----------
const RENDER = { today: renderToday, news: renderNews, map: renderMap, experts: renderExperts, learn: renderLearn };
function route() {
  const v = (location.hash || "#today").slice(1);
  state.view = RENDER[v] ? v : "today";
  $$(".view").forEach(el => el.classList.toggle("on", el.id === "v-" + state.view));
  $$(".nav a").forEach(a => { if (a.dataset.v === state.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  RENDER[state.view]();
  if (state.view === "map" && state.sim && state.mapMode === "try") requestAnimationFrame(() => $("#sim-sec")?.scrollIntoView({ block: "start" }));
  else window.scrollTo(0, 0);
}

document.addEventListener("click", ev => {
  // 用語の説明が出ているときは、外をタップしたら閉じるだけにする
  const card = $("#termcard");
  if (!card.hidden) {
    const inCard = ev.target.closest("#termcard");
    if (!inCard) { hideTerm(); if (!ev.target.closest("[data-term]")) { ev.preventDefault(); ev.stopPropagation(); return; } }
    else {
      if (ev.target.closest("#tc-node")) { const to = $("#tc-node").dataset.to; hideTerm(); openNode(to); }
      else if (ev.target.closest("#tc-close")) hideTerm();
      return;
    }
  }
  const term = ev.target.closest("[data-term]");
  if (term) { ev.preventDefault(); ev.stopPropagation(); showTerm(term.dataset.term); return; }
  const t = ev.target.closest("[data-node],[data-news],[data-sim],[data-newscat],[data-newsmode],[data-expert],[data-pick],[data-simdir],[data-q],[data-next-quiz],[data-today-map],[data-walk],[data-walkto],[data-trail],[data-mapmode],[data-thread],[data-weekly],[data-agenda],[data-agi],[data-reviews],[data-reviewfull],[data-theme],[data-guide],[data-picker],[data-hop],[data-glcat],[data-sources]");
  if (!t) return;
  const ds = t.dataset;
  // history.back() は遅れて効くので、詳細から画面を移るときは閉じるだけにする
  if (ds.sim) {
    const [node, d] = ds.sim.split(":");
    if (sheetOpen) hideSheet();
    runSim(node, d === "up" || d === "1" ? 1 : d === "down" || d === "-1" ? -1 : 0);
  } else if (ds.walkto) { if (sheetOpen) hideSheet(); walkTo(ds.walkto, true); }
  else if (ds.walk) walkTo(ds.walk, state.mapMode !== "walk");
  else if (ds.trail) { state.walk = ds.trail === "reset" ? state.walk.slice(0, 1) : state.walk.slice(0, +ds.trail + 1); renderMap(); }
  else if (ds.mapmode) { state.mapMode = ds.mapmode; if (ds.mapmode === "walk" && !state.walk.length) state.walk = [state.simPick]; renderMap(); $(`#v-map .connect-tabs [data-mapmode="${state.mapMode}"]`)?.focus({ preventScroll: true }); }
  else if (ds.picker !== undefined) openPicker();
  else if (ds.pick) { if (sheetOpen) hideSheet(); state.simPick = ds.pick; if (state.mapMode === "walk") walkTo(ds.pick, true); else runSim(ds.pick, state.simDir); }
  else if (ds.simdir) { state.simDir = +ds.simdir; runSim(state.simPick, state.simDir); }
  else if (ds.hop) openHop(ds.hop);
  else if (ds.q !== undefined && ds.c !== undefined) answer(ds.q, +ds.c);
  else if (ds.nextQuiz !== undefined) { state.gq = makeGraphQuiz(G); state.gqAnswered = null; const y = window.scrollY; renderLearn(); window.scrollTo(0, y); }
  else if (ds.newsmode) { state.newsMode = ds.newsmode; renderNews(); $(`#v-news [data-newsmode="${state.newsMode}"]`)?.focus({ preventScroll: true }); }
  else if (ds.sources !== undefined) openSources();
  else if (ds.newscat) { state.newsCat = ds.newscat; renderNews(); $(`#v-news [data-newscat="${state.newsCat}"]`)?.focus({ preventScroll: true }); }
  else if (ds.expert) { state.expert = ds.expert; renderExperts(); }
  else if (ds.glcat) { state.glCat = ds.glcat; const y = window.scrollY; renderLearn(); window.scrollTo(0, y); }
  else if (ds.todayMap !== undefined) { state.sim = null; paintMap(); renderSimResult(); }
  else if (ds.guide !== undefined) { store.set("guideDone", true); renderToday(); }
  else if (ds.theme !== undefined) openTheme(+ds.theme);
  else if (ds.thread) openThread(ds.thread);
  else if (ds.weekly) openWeekly(ds.weekly);
  else if (ds.agenda !== undefined) openAgenda();
  else if (ds.agi !== undefined) openAgendaItem(+ds.agi);
  else if (ds.reviewfull !== undefined) openSheet(`<p class="cat">答え合わせ</p><h2>見通しの答え合わせ</h2>${reviewCard(X.reviews[0])}${HINT}`);
  else if (ds.reviews !== undefined) openSheet(`<p class="cat">答え合わせ</p><h2>これまでの答え合わせ</h2>${X.reviews.map(r => reviewCard(r)).join("")}`);
  else if (ds.news) openNews(ds.news);
  else if (ds.node) openNode(ds.node);
}, true);
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape") { if (!$("#termcard").hidden) hideTerm(); else closeSheet(); }
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.("[data-walk],[data-node],[data-term]")) { ev.preventDefault(); ev.target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
});
$("#scrim").addEventListener("click", closeSheet);
$("#sheet-close").addEventListener("click", closeSheet);
window.addEventListener("popstate", () => { if (sheetOpen) hideSheet(); });
window.addEventListener("hashchange", () => { hideTerm(); if (sheetOpen) hideSheet(); route(); });

// ---------- データの読み込みと、新しい内容・新しい版の確認 ----------
const getJson = u => fetch(u, { cache: "no-cache" }).then(r => (r.ok ? r.json() : null)).catch(() => null);
function setData(d) {
  D = d || { brief: { themes: [] }, news: [], experts: [], moving: [], markets: {}, quiz: [] };
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
  if (d?.updated && D && d.updated !== D.updated) {
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
  const [g, d, gloss] = await Promise.all([fetch("data/graph.json").then(r => r.json()), getJson("data/latest.json"), getJson("data/glossary.json"), loadExtras()]);
  G = makeGraph(g);
  GLOSSARY = gloss;
  setData(d);
  lastCheck = Date.now();
  route();
  setTimeout(() => { lastCheck = 0; checkFresh(); }, 4000);
}
load();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
