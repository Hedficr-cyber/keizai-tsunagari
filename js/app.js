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
  mapMode: "all",
  walk: [], // たどった項目（最後が真ん中）
  sim: null, // { start, dir }
  simPick: "boj",
  simDir: 1,
  gq: null,
  gqAnswered: null,
  todayAnswers: {},
};

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
  return `<${tagName} class="tag ${cls} ${opts.conf ? "conf" : ""}" data-node="${esc(n.id)}"><span class="nm">${esc(label)}</span>${word}</${tagName}>`;
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
  return n === 0 ? "今日" : n === 1 ? "あす" : n > 0 ? `あと${n}日` : `${-n}日前`;
}
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

// ---------- 今日 ----------
function renderToday() {
  const b = D.brief || { themes: [] };
  const upd = D.updated ? new Date(D.updated) : null;
  const moving = (D.moving || []).map(m => chip(m.node, m.dir)).join("");
  const themes = (b.themes || []).map((t, i) => themeCard(t, i)).join("");
  const wk = X.weekly;
  const showWeek = wk && (Date.now() - new Date(wk.made)) < 4 * 86400000;
  const rv = X.reviews[0];
  $("#v-today").innerHTML = `
    <p class="date-line">${upd ? `${upd.getMonth() + 1}月${upd.getDate()}日（${WD[upd.getDay()]}）の世の中` : ""}</p>
    <h1 class="headline">${esc(b.headline || "今日のニュースを集めています")}</h1>
    <div class="markets">${["usdjpy", "jgb10", "ust10"].map(marketCard).join("")}</div>
    ${showWeek ? `<button class="card week-card" data-weekly="${esc(wk.id)}"><div class="no">今週のまとめ・${esc(md(wk.from))}〜${esc(md(wk.to))}</div><h3>${esc(wk.title)}</h3><p class="what">${esc(wk.summary.slice(0, 90))}…</p><p class="more">続きを読む →</p></button>` : ""}
    ${moving ? `<div class="sec"><h2>いま動いているもの</h2><span class="aside">タップで仕組み</span></div><div class="chips">${moving}</div>` : ""}
    ${agendaHtml(3)}
    <div class="sec"><h2>今日のつながり</h2><span class="aside">${(b.themes || []).length}つのテーマ</span></div>
    ${themes || `<div class="card"><p class="muted small">AI の読み解きは次の更新で表示されます。ニュースの一覧は「ニュース」から見られます。</p></div>`}
    ${rv && rv.reviewed === todayStr() ? `<div class="sec"><h2>答え合わせ</h2></div><a class="card" href="#learn" style="display:block;text-decoration:none"><div class="no">${esc(md(rv.target))}の「今後こうなるかも」</div><p style="font-weight:700;margin-top:4px">${esc(rv.summary)}</p><p class="muted small" style="margin-top:6px">「学ぶ」で1つずつ見る →</p></a>` : ""}
    ${(D.quiz || []).length ? `<div class="sec"><h2>今日のニュースで考える</h2></div><a class="card" href="#learn" style="display:block;text-decoration:none"><p style="font-weight:700">${esc(D.quiz[0].q)}</p><p class="muted small" style="margin-top:6px">「学ぶ」で答える →</p></a>` : ""}
    ${foot()}`;
}
function themeCard(t, i) {
  const voices = (t.experts || []).map(id => expertById[id]).filter(Boolean).slice(0, 2)
    .map(e => `<div class="voice"><div class="who">${esc(e.name)}<span class="muted" style="font-weight:500">｜${esc(e.role)}</span></div>${esc(e.view)}</div>`).join("");
  const rel = (t.news || []).map(id => newsById[id]).filter(Boolean).slice(0, 4)
    .map(n => `<button data-news="${esc(n.id)}">${esc(n.title)}<span class="src">${esc(n.source)}・${esc(ago(n.time))}</span></button>`).join("");
  const first = (t.chain || [])[0];
  const conf = (t.chain || []).filter(c => c.conflict).map(c => `<p class="conf-note">※ ${esc(c.conflict)}。ここでは仕組みとしての向きです。</p>`).join("");
  const th = threadByName[t.thread];
  return `<article class="card theme">
    <div class="no">テーマ ${i + 1}${th ? `<button class="thread-link" data-thread="${esc(th.name)}">流れ：${esc(th.name)}・${th.entries.length}日目</button>` : ""}</div>
    <h3>${esc(t.title)}</h3>
    <p class="what">${esc(t.what)}</p>
    <div class="label">つながり</div>
    <div class="chain">${chainHtml(t.chain)}</div>
    <p class="chain-text">${esc(t.chain_text)}</p>
    ${conf}
    <div class="label">今後こうなるかも</div>
    <ul class="outlook">${(t.outlook || []).map(o => `<li>${esc(o)}</li>`).join("")}</ul>
    ${t.watch ? `<div class="watch"><b>次の注目</b>${esc(t.watch)}</div>` : ""}
    ${voices ? `<div class="label">識者の見方</div>${voices}` : ""}
    ${rel ? `<div class="label">関連ニュース</div><div class="rel">${rel}</div>` : ""}
    ${first ? `<div class="row-btns"><button class="btn ghost" data-sim="${esc(first.node)}:${esc(first.dir)}">${esc(G.byId[first.node]?.short)}の${esc(dirWord(G.byId[first.node], dirNum(first.dir)))}から広がる影響を見る</button></div>` : ""}
  </article>`;
}

// ---------- 予定とシナリオ ----------
function agendaItems() {
  const today = todayStr();
  const cal = (D.calendar || []).filter(e => e.date >= today);
  const sc = [...(D.scenarios || [])];
  const items = cal.map(e => {
    // 同じ日の予定にシナリオを合わせる（名前の一部が重なるものを優先）
    const i = sc.findIndex(s => s.date === e.date && (s.event.includes(e.name.slice(0, 3)) || e.name.includes(s.event.slice(0, 3))));
    const j = i >= 0 ? i : sc.findIndex(s => s.date === e.date);
    return { ...e, scenario: j >= 0 ? sc.splice(j, 1)[0] : null };
  });
  // 公式の日程にない予定（ニュースから AI が拾ったもの）
  for (const s of sc) if (!s.date || s.date >= today) items.push({ date: s.date, name: s.event, note: s.date ? "" : "日付はニュースから未確定", nodes: [], scenario: s });
  return items.sort((a, b) => (a.date || "9999") < (b.date || "9999") ? -1 : 1);
}
function agendaHtml(limit) {
  const items = agendaItems().slice(0, limit);
  if (!items.length) return "";
  const more = agendaItems().length > limit;
  return `<div class="sec"><h2>これからの予定</h2><span class="aside">結果しだいでどうなるか</span></div>
    <div class="agenda">${items.map(agendaItem).join("")}</div>
    ${more ? `<div class="row-btns" style="margin-top:4px"><button class="btn ghost" data-agenda>予定をすべて見る</button></div>` : ""}`;
}
function agendaItem(e) {
  const s = e.scenario;
  return `<article class="card ag">
    <div class="ag-head"><div class="ag-date">${e.date ? `${esc(md(e.date))}<span>${esc(dayLabel(e.date))}</span>` : `<span>日付未定</span>`}</div>
      <div><h3>${esc(e.name)}</h3>${e.note ? `<p class="muted small">${esc(e.note)}</p>` : ""}</div></div>
    ${(e.nodes || []).length ? `<div class="chips" style="margin-top:8px">${e.nodes.map(n => chip(n)).join("")}</div>` : ""}
    ${s ? `<p class="ag-focus"><b>焦点</b>${esc(s.focus)}</p>
      <div class="cases">${s.cases.map((c, i) => `<div class="case c${i}"><div class="case-l">${esc(c.label)}</div><div class="chain">${chainHtml(c.chain)}</div><p>${esc(c.text)}</p></div>`).join("")}</div>` : ""}
  </article>`;
}
function openAgenda() {
  openSheet(`<p class="cat">これからの予定</p><h2>予定と、結果しだいの広がり</h2>
    <p class="lead muted small">FRB・日銀・内閣府の公式の日程と、ニュースに出てきた予定。2週間以内のものには、結果が2通りに分かれた場合のつながりを付けています。</p>
    <div class="agenda" style="margin-top:14px">${agendaItems().map(agendaItem).join("")}</div>`);
}

// ---------- ニュース ----------
function newsCats(n) { return new Set((n.tags || []).map(t => G.byId[t.node]?.cat).filter(Boolean)); }
function renderNews() {
  const all = D.news || [];
  const modes = `<div class="seg" role="group" aria-label="表示の切り替え"><button class="${state.newsMode === "list" ? "on" : ""}" data-newsmode="list">一覧</button><button class="${state.newsMode === "flow" ? "on" : ""}" data-newsmode="flow">流れ</button></div>`;
  if (state.newsMode === "flow") {
    $("#v-news").innerHTML = `
      <h1 class="page-title">ニュース</h1>
      ${modes}
      <p class="page-sub" style="margin-top:12px">同じ話題が日をまたいでどう続いているか。テーマを毎日つないで記録しています。</p>
      ${X.threads.length ? X.threads.map(threadCard).join("") : `<p class="empty">流れは、更新のたびにたまっていきます。</p>`}
      <div class="sec"><h2>週のまとめ</h2><span class="aside">土曜の朝に1本</span></div>
      ${X.weeks.length ? `<div class="rel">${X.weeks.map(w => `<button data-weekly="${esc(w.id)}">${esc(w.title)}<span class="src">${esc(md(w.from))}〜${esc(md(w.to))}</span></button>`).join("")}</div>` : `<p class="note">最初の週のまとめは、土曜の朝の更新で作られます。</p>`}
      ${foot()}`;
    return;
  }
  const present = new Set(all.flatMap(n => [...newsCats(n)]));
  const filters = [["all", "すべて"], ["top", "重要"], ...G.cats.filter(c => present.has(c.id)).map(c => [c.id, c.name])];
  const list = all.filter(n => state.newsCat === "all" ? true : state.newsCat === "top" ? n.level >= 3 : newsCats(n).has(state.newsCat));
  $("#v-news").innerHTML = `
    <h1 class="page-title">ニュース</h1>
    ${modes}
    <p class="page-sub" style="margin-top:12px">${esc(new Set(all.map(n => n.source)).size)}の媒体から、経済に関わる${all.length}本。タップで要点とこの先の影響。</p>
    <div class="chips scroll" role="group" aria-label="分野で絞り込む">${filters.map(([id, name]) => `<button class="filter ${state.newsCat === id ? "on" : ""}" data-newscat="${esc(id)}">${esc(name)}</button>`).join("")}</div>
    <div class="list" style="margin-top:8px">${list.map(newsRow).join("") || `<p class="empty">この分野のニュースは、いまはありません。</p>`}</div>
    ${foot()}`;
}
function threadCard(t) {
  const last = t.entries[t.entries.length - 1];
  const first = t.entries[0];
  return `<button class="card thread" data-thread="${esc(t.name)}">
    <div class="no">${t.entries.length}日分・${esc(md(first.date))}〜${esc(md(last.date))}</div>
    <h3>${esc(t.name)}</h3>
    <p class="what">${esc(last.title)}：${esc(last.what.slice(0, 70))}${last.what.length > 70 ? "…" : ""}</p>
    <div class="dots" aria-hidden="true">${t.entries.slice(-14).map(() => "<i></i>").join("")}</div>
  </button>`;
}
function openThread(name) {
  const t = threadByName[name];
  if (!t) return;
  openSheet(`<p class="cat">流れ・${t.entries.length}日分</p><h2>${esc(t.name)}</h2>
    <div class="timeline">${[...t.entries].reverse().map(e => `<div class="tl">
      <div class="tl-date">${esc(md(e.date))}</div>
      <div class="tl-body"><h3>${esc(e.title)}</h3><p>${esc(e.what)}</p>
        <div class="chain" style="margin-top:8px">${chainHtml(e.chain)}</div>
        ${(e.outlook || []).length ? `<ul class="outlook small-ol">${e.outlook.map(o => `<li>${esc(o)}</li>`).join("")}</ul>` : ""}</div></div>`).join("")}</div>`);
}
function newsRow(n) {
  return `<button class="item" data-news="${esc(n.id)}">
    <div class="t">${esc(n.title)}</div>
    <div class="m">${lv(n.level || 1)}<span>${esc(n.source)}</span><span>${esc(ago(n.time))}</span></div>
    ${n.plain ? `<p class="p">${esc(n.plain)}</p>` : ""}
    ${(n.tags || []).length ? `<div class="chips">${n.tags.map(t => chip(t.node, t.dir, { span: true })).join("")}</div>` : ""}
  </button>`;
}
function openNews(id) {
  const n = newsById[id];
  if (!n) return;
  const t0 = (n.tags || []).find(t => t.dir);
  let ripple = "";
  if (t0) {
    const { res, waves } = simulate(G, t0.node, dirNum(t0.dir), 2);
    ripple = `<div class="label">ここから広がる影響（つながり図より）</div>
      <div class="links">${waves.flat().slice(0, 6).map(v => hopRow(v, res[v])).join("")}</div>
      <div class="row-btns"><button class="btn ghost" data-sim="${esc(t0.node)}:${esc(t0.dir)}">図で全部見る</button></div>`;
  }
  const url = safeUrl(n.link);
  openSheet(`
    <p class="cat">${esc(n.source)}・${esc(fmtTime(n.time))}</p>
    <h2>${esc(n.title)}</h2>
    ${n.plain ? `<p class="lead">${esc(n.plain)}</p>` : ""}
    ${n.next ? `<div class="label">この先</div><p class="lead" style="margin-top:0">${esc(n.next)}</p>` : ""}
    ${(n.tags || []).length ? `<div class="label">動かすもの</div><div class="chips">${n.tags.map(t => chip(t.node, t.dir, { full: true })).join("")}</div>` : ""}
    ${ripple}
    ${url ? `<a class="outbtn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">元の記事を読む</a>` : ""}
    <p class="foot" style="margin-top:14px">要点と見通しは、見出しから AI がまとめたものです。</p>`);
}
function hopRow(v, r) {
  const n = G.byId[v];
  const via = r.via.slice(0, 2);
  const from = [...new Set(r.via.map(a => G.byId[a.from].short))].join("・");
  const why = r.dir === 0
    ? via.map(a => `<p class="why">${esc(G.byId[a.from].short)}が${esc(dirWord(G.byId[a.from], res0(a)))} → ${esc(dirWord(n, a.dir))}：${esc(a.edge.why)}</p>`).join("")
    : `<p class="why">${esc(via[0].edge.why)}</p>`;
  return `<button class="link-row" data-node="${esc(v)}"><div class="hd">${chip(v, r.dir, { span: true })}<span class="from muted small">← ${esc(from)}</span></div>${why}</button>`;
}

// ---------- 項目の詳細 ----------
function openNode(id) {
  const n = G.byId[id];
  if (!n) return;
  const m = n.market && D.markets?.[n.market];
  let market = "";
  if (m?.series?.length) {
    const { last, diff } = marketChange(m);
    const cls = diff > 0 ? "up" : diff < 0 ? "down" : "";
    market = `<div class="label">いまの値</div>
      <p style="font-size:24px;font-weight:700;font-variant-numeric:tabular-nums">${esc(m.unit === "%" ? last.v.toFixed(3) : last.v.toFixed(2))}<small class="muted" style="font-size:12px;margin-left:3px">${esc(m.unit)}</small>
      <span class="${cls}-t" style="font-size:13px;margin-left:8px">1か月で ${diff >= 0 ? "+" : "−"}${esc(Math.abs(diff).toFixed(2))}${m.unit === "%" ? "pt" : "円"}（${esc(diff ? dirWord(n, diff > 0 ? 1 : -1) : "横ばい")}）</span></p>
      ${spark(m.series, cls + "-t", true)}
      <p class="muted small">${esc(last.d)} 時点（前の営業日の値）・${esc(m.source)}</p>`;
  }
  const mv = (D.moving || []).find(x => x.node === id);
  const outs = G.out[id].map(e => {
    const to = G.byId[e.to];
    return `<button class="link-row" data-node="${esc(to.id)}"><div class="hd"><span class="small muted">${esc(n.up)}すると</span>${chip(to.id, e.sign, { span: true })}</div><p class="why">${esc(e.why)}</p><p class="meta">時間の目安：${esc(e.lag)}・関係の強さ：${esc(STRENGTH[e.strength])}</p></button>`;
  }).join("");
  const ins = G.inn[id].map(e => {
    const fr = G.byId[e.from];
    return `<button class="link-row" data-node="${esc(fr.id)}"><div class="hd">${chip(fr.id, 1, { span: true })}<span class="small muted">→ ${esc(n.short)}は${esc(dirWord(n, e.sign))}</span></div><p class="why">${esc(e.why)}</p></button>`;
  }).join("");
  const news = (D.news || []).filter(x => (x.tags || []).some(t => t.node === id)).slice(0, 5);
  const exps = (D.experts || []).filter(x => (x.tags || []).some(t => t.node === id)).slice(0, 3);
  openSheet(`
    <p class="cat">${esc(G.catName[n.cat])}</p>
    <h2>${esc(n.name)}</h2>
    <p class="lead">${esc(n.desc)}</p>
    <div class="watch" style="margin-top:12px"><b>暮らしでは</b>${esc(n.life)}</div>
    ${mv ? `<div class="label">今日の動き</div><div class="hd" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${chip(id, mv.dir, { full: true })}<span class="small">${esc(mv.why)}</span></div>` : ""}
    ${market}
    <div class="label">もしも動いたら</div>
    <div class="row-btns" style="margin-top:0"><button class="btn up" data-sim="${esc(id)}:up">${esc(n.up)}したら？</button><button class="btn down" data-sim="${esc(id)}:down">${esc(n.down)}したら？</button><button class="btn ghost" data-walkto="${esc(id)}">図でたどる</button></div>
    ${outs ? `<div class="label">影響を与える先（${G.out[id].length}）</div><div class="links">${outs}</div>` : ""}
    ${ins ? `<div class="label">影響を受ける元（${G.inn[id].length}）</div><div class="links">${ins}</div>` : ""}
    ${news.length ? `<div class="label">関係する今日のニュース</div><div class="rel">${news.map(x => `<button data-news="${esc(x.id)}">${esc(x.title)}<span class="src">${esc(x.source)}・${esc(ago(x.time))}</span></button>`).join("")}</div>` : ""}
    ${exps.length ? `<div class="label">識者の見方</div>${exps.map(e => `<div class="voice"><div class="who">${esc(e.name)}</div>${esc(e.view)}</div>`).join("")}` : ""}`);
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
    ${ins.length ? `<text class="elabel" x="${cx}" y="12">影響を受ける元（タップでさかのぼる）</text>` : ""}
    ${outs.length ? `<text class="elabel" x="${cx}" y="${outY - 16}">影響を与える先（タップで先へ）</text>` : ""}
    ${inEdges}${outEdges}${inBoxes}${outBoxes}
    <g class="ecenter" data-node="${c.id}" role="button" tabindex="0" aria-label="${esc(c.name)}の仕組み"><rect x="${cx - CW / 2}" y="${cy}" width="${CW}" height="${CH}" rx="14"/><text class="ec" x="${cx}" y="${cy + 24}">${esc(c.name)}</text><text class="ecs" x="${cx}" y="${cy + 43}">上がる＝${esc(c.up)}／下がる＝${esc(c.down)}</text></g>
  </svg>`;
}
function walkHtml() {
  const id = state.walk[state.walk.length - 1] || "boj";
  const n = G.byId[id];
  const trail = state.walk.length > 1 ? `<div class="trail"><span class="muted small">たどった道</span>${state.walk.map((w, i) => `${i ? `<span class="arrow">→</span>` : ""}<button class="tag ${i === state.walk.length - 1 ? "here" : ""}" data-trail="${i}"><span class="nm">${esc(G.byId[w].short)}</span></button>`).join("")}<button class="filter" data-trail="reset">最初から</button></div>` : "";
  return `${trail}
    <div class="map-box ego-box">${egoSvg(id)}</div>
    <p class="note" style="margin-top:10px">上の項目は「${esc(n.short)}を動かす原因」、下は「${esc(n.short)}が動かす先」。小さな字は向きの関係（例：${esc(n.up)}→…）です。線が太いほど強い関係、点線は条件しだい。</p>
    <div class="row-btns"><button class="btn" data-node="${esc(id)}">${esc(n.short)}の仕組みを読む</button><button class="btn up" data-sim="${esc(id)}:up">${esc(n.up)}したら？</button><button class="btn down" data-sim="${esc(id)}:down">${esc(n.down)}したら？</button></div>`;
}
function renderMap() {
  const groups = G.cats.map(c => {
    const ns = G.nodes.filter(n => n.cat === c.id);
    return `<div><div class="grp-name">${esc(c.name)}</div><div class="chips">${ns.map(n => `<button class="filter ${state.simPick === n.id ? "on" : ""}" data-pick="${n.id}">${esc(n.short)}</button>`).join("")}</div></div>`;
  }).join("");
  const p = G.byId[state.simPick];
  const walking = state.mapMode === "walk";
  $("#v-map").innerHTML = `
    <h1 class="page-title">つながり</h1>
    <div class="seg" role="group" aria-label="図の切り替え"><button class="${walking ? "" : "on"}" data-mapmode="all">全体図</button><button class="${walking ? "on" : ""}" data-mapmode="walk">たどる</button></div>
    <p class="page-sub" style="margin-top:12px">${walking ? "1つの項目を真ん中に、原因と影響だけを大きく。タップした項目へ進んで、つながりをたどれます。" : `経済の${G.nodes.length}項目と、${G.edges.length}本の「AならB」。項目をタップすると、その項目を真ん中にした図でたどれます。`}</p>
    ${walking ? walkHtml() : `<div class="chips" style="margin-bottom:10px" id="map-mode"></div>
    <div class="map-box">${mapSvg()}</div>
    <div class="legend"><span><i style="background:var(--up)"></i>上がる</span><span><i style="background:var(--down)"></i>下がる</span><span><i style="background:var(--mix)"></i>綱引き（逆向きの力がぶつかる）</span></div>`}
    <div class="sec" id="sim-sec"><h2>もしも〜なら</h2><span class="aside">起点を選ぶ</span></div>
    <div class="picker">${groups}</div>
    <div class="dir-toggle">
      <button class="up ${state.simDir > 0 ? "on" : ""}" data-simdir="1">↑ ${esc(p.up)}</button>
      <button class="down ${state.simDir < 0 ? "on" : ""}" data-simdir="-1">↓ ${esc(p.down)}</button>
    </div>
    <div id="sim-result"></div>
    ${foot()}`;
  if (!walking) paintMap();
  renderSimResult();
}
function walkTo(id, fresh = false) {
  if (fresh || !state.walk.length) state.walk = [id];
  else if (state.walk[state.walk.length - 1] !== id) state.walk = [...state.walk, id].slice(-8);
  state.mapMode = "walk";
  if (state.view !== "map") { location.hash = "#map"; return; }
  const y = window.scrollY;
  renderMap();
  window.scrollTo(0, Math.min(y, $(".seg")?.getBoundingClientRect().top + window.scrollY - 70));
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
    mode.innerHTML = `<span class="tag ${dirClass(state.sim.dir)}"><span class="nm">${esc(s.short)}</span>${esc(dirWord(s, state.sim.dir))}から広がる影響</span>${(D.moving || []).length ? `<button class="filter" data-today-map>今日の動きに戻す</button>` : ""}`;
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
      mode.innerHTML = `<span class="tag"><span class="nm">今日動いた項目</span>（ニュースから）</span>`;
    } else {
      svg.classList.remove("active");
      mode.innerHTML = "";
    }
  }
}
function renderSimResult() {
  const box = $("#sim-result");
  if (!box) return;
  if (!state.sim) { box.innerHTML = `<p class="note">起点と向きを選ぶと、影響が1段目・2段目・3段目へと広がる様子が図とリストで見られます。</p>`; return; }
  const { res, waves } = simulate(G, state.sim.start, state.sim.dir);
  const s = G.byId[state.sim.start];
  const mixed = Object.values(res).filter(r => r.dir === 0).length;
  box.innerHTML = `
    <div class="wave"><div class="wave-h">起点</div>${chip(s.id, state.sim.dir, { full: true })}</div>
    ${waves.map((list, i) => `<div class="wave"><div class="wave-h">${i + 1}段目の影響（${list.length}）</div>${list.map(v => simHop(v, res[v])).join("")}</div>`).join("")}
    <p class="note">これは「ほかの条件が同じなら」の基本の傾向です。現実には複数の力が同時に働き、${mixed ? "綱引きになる項目のように、" : ""}打ち消し合うこともあります。段が進むほど、時間がかかり不確かになります。</p>`;
}
function simHop(v, r) {
  const n = G.byId[v];
  const lines = r.via.slice(0, 3).map(a => {
    const f = G.byId[a.from];
    const fd = res0(a);
    // 説明文は「上がる場合」で書いてあるので、下がる向きのときはそう添える
    return `<p class="why"><b style="color:var(--ink);font-weight:600">${esc(f.short)}が${esc(dirWord(f, fd))}</b> → ${esc(n.short)}は${esc(dirWord(n, a.dir))}<br>${esc(a.edge.why)}${fd < 0 ? `<span class="rev">（説明は${esc(f.short)}が${esc(f.up)}の場合。${esc(f.down)}のときは逆に働く）</span>` : ""}</p>`;
  }).join("");
  const e = r.via[0].edge;
  return `<button class="hop" data-node="${esc(v)}"><div class="hd">${chip(v, r.dir, { full: true, span: true })}${r.dir === 0 ? `<span class="small mix-t">逆向きの力がぶつかる</span>` : ""}</div>${lines}<p class="meta">時間の目安：${esc(e.lag)}・関係の強さ：${esc(STRENGTH[e.strength])}</p></button>`;
}
// 経由した項目の向き（a.dir は到着先の向き、edge.sign で割り戻す）
function res0(a) { return a.dir * a.edge.sign; }
function runSim(node, dir) {
  state.sim = { start: node, dir };
  state.simPick = node;
  state.simDir = dir;
  state.mapMode = "all";
  if (state.view !== "map") { location.hash = "#map"; return; }
  renderMap();
  requestAnimationFrame(() => $(".map-box")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

// ---------- 識者 ----------
function renderExperts() {
  const all = D.experts || [];
  const names = [...new Map(all.map(e => [e.expert, e.name])).entries()];
  const list = all.filter(e => state.expert === "all" || e.expert === state.expert);
  const debates = (D.debates || []).map(debateCard).join("");
  $("#v-experts").innerHTML = `
    <h1 class="page-title">識者の見方</h1>
    <p class="page-sub">経済ジャーナリストやエコノミスト、研究所の、この1週間の発信。AI が見方を短くまとめています。</p>
    ${debates ? `<div class="sec" style="margin-top:8px"><h2>見方が分かれている点</h2><span class="aside">${(D.debates || []).length}つ</span></div>${debates}<div class="sec"><h2>それぞれの発信</h2></div>` : ""}
    <div class="chips scroll" role="group" aria-label="人で絞り込む">${[["all", "すべて"], ...names].map(([id, nm]) => `<button class="filter ${state.expert === id ? "on" : ""}" data-expert="${esc(id)}">${esc(nm)}</button>`).join("")}</div>
    <div style="margin-top:14px">${list.map(expertCard).join("") || `<p class="empty">いまは表示できる発信がありません。</p>`}</div>
    <p class="note">X（旧Twitter）は取り込みに有料の API が必要なため、YouTube は公式の配信が止まっているため、いまは取り込んでいません（YouTube は無料の API キーを入れると取り込めます）。note・記事・研究所のレポートを集めています。</p>
    ${foot()}`;
}
function debateCard(d) {
  const side = s => {
    const who = s.experts.map(id => expertById[id]).filter(Boolean);
    return `<div class="side ${s.stance === "強気" ? "bull" : "bear"}"><div class="side-h">${esc(s.stance)}</div><p>${esc(s.view)}</p><div class="side-who">${[...new Set(who.map(e => e.name))].map(esc).join("・")}</div></div>`;
  };
  return `<article class="card debate"><h3>${esc(d.topic)}</h3><p class="crux"><b>分かれ目</b>${esc(d.crux)}</p><div class="sides">${d.sides.map(side).join("")}</div></article>`;
}
function expertCard(e) {
  const url = safeUrl(e.link);
  return `<article class="card">
    <div class="ex-head"><div class="avatar">${esc(e.name.slice(0, 1))}</div><div><div class="n">${esc(e.name)}</div><div class="r">${esc(e.role)}</div></div><span class="stance s-${esc(e.stance)}">${esc(e.stance)}</span></div>
    <p class="ex-view">${esc(e.view)}</p>
    ${(e.tags || []).length ? `<div class="chips" style="margin-bottom:12px">${e.tags.map(t => chip(t.node, t.dir)).join("")}</div>` : ""}
    ${url ? `<a class="ex-src" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(e.kind)}・${esc(e.source)}・${esc(ago(e.time))}<br><b>${esc(e.title)}</b></a>` : ""}
  </article>`;
}

// ---------- 学ぶ ----------
function reviewHtml() {
  const rv = X.reviews[0];
  if (!rv) {
    return `<div class="sec"><h2>答え合わせ</h2></div><p class="note">3日前に書いた「今後こうなるかも」が実際どうなったかを、毎日1回ここで答え合わせします。記録が3日分たまると始まります。</p>`;
  }
  const tally = {};
  for (const r of X.reviews) for (const i of r.items) tally[i.verdict] = (tally[i.verdict] || 0) + 1;
  return `<div class="sec"><h2>答え合わせ</h2><span class="aside">${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join("・")}</span></div>
    ${reviewCard(rv)}
    ${X.reviews.length > 1 ? `<div class="row-btns" style="margin-top:-2px"><button class="btn ghost" data-reviews>これまでの答え合わせ（${X.reviews.length}回）</button></div>` : ""}`;
}
function reviewCard(rv) {
  return `<article class="card review"><div class="no">${esc(md(rv.target))}の見通し → ${esc(md(rv.reviewed))}に確認</div>
    <p class="rv-sum">${esc(rv.summary)}</p>
    ${rv.items.map(i => `<div class="rv-item"><div class="rv-h"><span class="verdict v-${VERDICT[i.verdict] || "wait"}">${esc(i.verdict)}</span><span class="muted small">${esc(i.theme)}</span></div>
      <p class="rv-o">「${esc(i.outlook)}」</p><p class="rv-a"><b>実際</b>${esc(i.actual)}</p><p class="rv-l"><b>学び</b>${esc(i.lesson)}</p></div>`).join("")}
  </article>`;
}
function renderLearn() {
  const sc = store.get("score", { right: 0, total: 0 });
  if (!state.gq) { state.gq = makeGraphQuiz(G); state.gqAnswered = null; }
  const today = (D.quiz || []).map((q, i) => quizCard(q, `t${i}`, state.todayAnswers[i], "今日のニュースから")).join("");
  const gl = G.cats.map(c => {
    const ns = G.nodes.filter(n => n.cat === c.id);
    return `<div class="grp-name" style="margin:18px 0 8px;font-size:11px;font-weight:700;color:var(--ink-2);letter-spacing:.08em">${esc(c.name)}</div><div class="glossary">${ns.map(n => `<button class="gl" data-node="${n.id}"><div class="n">${esc(n.name)}</div><div class="d">${esc(n.desc)}</div></button>`).join("")}</div>`;
  }).join("");
  $("#v-learn").innerHTML = `
    <h1 class="page-title">学ぶ</h1>
    <p class="page-sub">見通しの答え合わせと、「AならB」を確かめる問題。答えると理由が出ます。</p>
    ${reviewHtml()}
    <div class="sec"><h2>つながりクイズ</h2><span class="score">これまで ${sc.right} / ${sc.total} 問正解</span></div>
    ${quizCard(state.gq, "g", state.gqAnswered, state.gq.kind)}
    ${state.gqAnswered !== null ? `<div class="row-btns" style="margin-top:-2px;margin-bottom:8px"><button class="btn" data-next-quiz>次の問題</button></div>` : ""}
    ${today ? `<div class="sec"><h2>今日のニュースで考える</h2></div>${today}` : ""}
    <div class="sec"><h2>用語と仕組み</h2><span class="aside">${G.nodes.length}項目</span></div>
    ${gl}
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
    ${done ? `<p class="explain"><b>${answered === q.answer ? "正解。" : `答えは「${esc(q.choices[q.answer])}」。`}</b>${esc(q.explain).replace(/\n/g, "<br>")}</p>${nodes ? `<div class="chips" style="margin-top:10px">${nodes}</div>` : ""}` : ""}
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
  openSheet(`<p class="cat">週のまとめ・${esc(md(w.from))}〜${esc(md(w.to))}</p><h2>${esc(w.title)}</h2>
    <p class="lead">${esc(w.summary)}</p>
    <div class="label">今週の大きな動き</div>
    ${(w.moves || []).map(m => `<div class="wk-move"><h3>${esc(m.title)}</h3><div class="chain">${chainHtml(m.chain)}</div><p>${esc(m.text)}</p></div>`).join("")}
    ${w.markets ? `<div class="label">相場の1週間</div><p class="lead" style="margin-top:0">${esc(w.markets)}</p>` : ""}
    ${(w.lessons || []).length ? `<div class="label">今週わかったつながり</div><ul class="outlook">${w.lessons.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
    ${(w.next_week || []).length ? `<div class="label">来週の注目</div><div class="links">${w.next_week.map(n => `<div class="link-row"><div class="hd"><b>${n.date ? esc(md(n.date)) : "日付未定"}</b><span>${esc(n.event)}</span></div><p class="why">${esc(n.why)}</p></div>`).join("")}</div>` : ""}`);
}

// ---------- 下から出る詳細 ----------
let sheetOpen = false;
function openSheet(html) {
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
  if (state.view === "map" && state.sim && state.mapMode === "all") requestAnimationFrame(() => $(".map-box")?.scrollIntoView({ block: "start" }));
  else window.scrollTo(0, 0);
}

document.addEventListener("click", ev => {
  const t = ev.target.closest("[data-node],[data-news],[data-sim],[data-newscat],[data-newsmode],[data-expert],[data-pick],[data-simdir],[data-q],[data-next-quiz],[data-today-map],[data-walk],[data-walkto],[data-trail],[data-mapmode],[data-thread],[data-weekly],[data-agenda],[data-reviews]");
  if (!t) return;
  const ds = t.dataset;
  // history.back() は遅れて効くので、詳細から画面を移るときは閉じるだけにする
  if (ds.sim) {
    const [node, d] = ds.sim.split(":");
    if (sheetOpen) hideSheet();
    runSim(node, d === "up" ? 1 : -1);
  } else if (ds.walkto) { if (sheetOpen) hideSheet(); walkTo(ds.walkto, true); }
  else if (ds.walk) walkTo(ds.walk, state.mapMode !== "walk");
  else if (ds.trail) { state.walk = ds.trail === "reset" ? state.walk.slice(0, 1) : state.walk.slice(0, +ds.trail + 1); renderMap(); }
  else if (ds.mapmode) { state.mapMode = ds.mapmode; if (ds.mapmode === "walk" && !state.walk.length) state.walk = [state.simPick]; renderMap(); }
  else if (ds.q !== undefined && ds.c !== undefined) answer(ds.q, +ds.c);
  else if (ds.nextQuiz !== undefined) { state.gq = makeGraphQuiz(G); state.gqAnswered = null; const y = window.scrollY; renderLearn(); window.scrollTo(0, y); }
  else if (ds.newsmode) { state.newsMode = ds.newsmode; renderNews(); }
  else if (ds.newscat) { state.newsCat = ds.newscat; renderNews(); }
  else if (ds.expert) { state.expert = ds.expert; renderExperts(); }
  else if (ds.pick) { state.simPick = ds.pick; runSim(ds.pick, state.simDir); }
  else if (ds.simdir) { state.simDir = +ds.simdir; runSim(state.simPick, state.simDir); }
  else if (ds.todayMap !== undefined) { state.sim = null; paintMap(); renderSimResult(); }
  else if (ds.thread) openThread(ds.thread);
  else if (ds.weekly) openWeekly(ds.weekly);
  else if (ds.agenda !== undefined) openAgenda();
  else if (ds.reviews !== undefined) openSheet(`<p class="cat">答え合わせ</p><h2>これまでの答え合わせ</h2>${X.reviews.map(reviewCard).join("")}`);
  else if (ds.news) openNews(ds.news);
  else if (ds.node) openNode(ds.node);
});
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape") closeSheet();
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.("[data-walk],[data-node]")) { ev.preventDefault(); ev.target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
});
$("#scrim").addEventListener("click", closeSheet);
$("#sheet-close").addEventListener("click", closeSheet);
window.addEventListener("popstate", () => { if (sheetOpen) hideSheet(); });
window.addEventListener("hashchange", () => { if (sheetOpen) hideSheet(); route(); });

// ---------- データの読み込みと、新しい内容・新しい版の確認 ----------
const getJson = u => fetch(u, { cache: "no-cache" }).then(r => (r.ok ? r.json() : null)).catch(() => null);
function setData(d) {
  D = d || { brief: { themes: [] }, news: [], experts: [], moving: [], markets: {}, quiz: [] };
  for (const k of Object.keys(newsById)) delete newsById[k];
  for (const k of Object.keys(expertById)) delete expertById[k];
  for (const n of D.news || []) newsById[n.id] = n;
  for (const e of D.experts || []) expertById[e.id] = e;
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
  const [g, d] = await Promise.all([fetch("data/graph.json").then(r => r.json()), getJson("data/latest.json"), loadExtras()]);
  G = makeGraph(g);
  setData(d);
  lastCheck = Date.now();
  route();
  setTimeout(() => { lastCheck = 0; checkFresh(); }, 4000);
}
load();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
