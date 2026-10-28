// つながり図の計算（波及のシミュレーション・クイズ・図の配置）

// 図の配置（4列×8段。上ほど原因側、下ほど暮らし側）
const COLS = [46, 136, 226, 316];
const ROWS = [38, 104, 170, 236, 302, 368, 434, 500];
const PLACE = {
  geopolitics: [0, 0], oil: [1, 0], china: [2, 0], tariffs: [3, 0],
  risk_off: [0, 1], us_cpi: [1, 1], us_economy: [2, 1], fed: [3, 1],
  gold: [0, 2], us_stocks: [1, 2], ai_semis: [2, 2], ust10: [3, 2],
  trade_balance: [0, 3], usdjpy: [1, 3], boj: [2, 3], jgb10: [3, 3],
  import_prices: [0, 4], exporters: [1, 4], nikkei: [2, 4], fiscal: [3, 4],
  jp_cpi: [0, 5], inbound: [1, 5], banks: [2, 5], mortgage: [3, 5],
  household: [0, 6], wages: [1, 6], labor_shortage: [2, 6], construction: [3, 6],
  consumption: [0, 7], jp_economy: [1, 7], realestate: [3, 7],
};
export const MAP_W = 362;
export const MAP_H = 530;
export const NODE_W = 78;
export const NODE_H = 30;

export function makeGraph(raw) {
  const byId = Object.fromEntries(raw.nodes.map(n => [n.id, n]));
  const out = {}, inn = {};
  for (const n of raw.nodes) { out[n.id] = []; inn[n.id] = []; }
  for (const e of raw.edges) { out[e.from].push(e); inn[e.to].push(e); }
  for (const k in out) out[k].sort((a, b) => b.strength - a.strength);
  for (const k in inn) inn[k].sort((a, b) => b.strength - a.strength);
  const catName = Object.fromEntries(raw.cats.map(c => [c.id, c.name]));
  const pos = {};
  for (const n of raw.nodes) {
    const p = PLACE[n.id] || [0, 0];
    pos[n.id] = { x: COLS[p[0]], y: ROWS[p[1]] };
  }
  return { ...raw, byId, out, inn, catName, pos };
}

// 向きの言葉（例：日銀＋up → 利上げ）
export function dirWord(node, dir) {
  if (dir === 0) return "綱引き";
  return dir > 0 || dir === "up" ? node.up : node.down;
}
export function dirNum(d) { return d === "up" ? 1 : d === "down" ? -1 : d; }
export function dirClass(d) { const n = dirNum(d); return n > 0 ? "up" : n < 0 ? "down" : n === 0 ? "mix" : ""; }
export const STRENGTH = { 3: "強い", 2: "ふつう", 1: "条件しだい" };

// start が dir（1 / -1）に動いたとき、どこへどう波及するかを波ごとに求める
export function simulate(g, start, dir, maxWave = 3) {
  const res = { [start]: { wave: 0, dir, via: [] } };
  let frontier = [start];
  const waves = [];
  for (let w = 1; w <= maxWave && frontier.length; w++) {
    const arrivals = {};
    for (const u of frontier) {
      const du = res[u].dir;
      if (!du) continue;
      for (const e of g.out[u]) {
        if (res[e.to]) continue;
        // 「条件しだい」の弱い関係は1段目だけ見せる。先まで追うと、強い経路より先に弱い経路で向きが決まってしまう
        if (w >= 2 && e.strength < 2) continue;
        (arrivals[e.to] ||= []).push({ from: u, dir: du * e.sign, edge: e });
      }
    }
    const list = [];
    for (const [v, arr] of Object.entries(arrivals)) {
      arr.sort((a, b) => b.edge.strength - a.edge.strength);
      const dirs = new Set(arr.map(a => a.dir));
      const d = dirs.size > 1 ? 0 : arr[0].dir;
      res[v] = { wave: w, dir: d, via: arr };
      list.push(v);
    }
    list.sort((a, b) => Math.max(...res[b].via.map(x => x.edge.strength)) - Math.max(...res[a].via.map(x => x.edge.strength)));
    if (list.length) waves.push(list);
    frontier = list;
  }
  return { res, waves };
}

// 2点を結ぶ線の端を、四角い項目の縁で止める
function edgePoint(c, toward) {
  const dx = toward.x - c.x, dy = toward.y - c.y;
  const hw = NODE_W / 2 + 2, hh = NODE_H / 2 + 2;
  const s = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
  return { x: c.x + dx * s, y: c.y + dy * s };
}

export function edgePath(g, e) {
  const a = g.pos[e.from], b = g.pos[e.to];
  // 少し曲げて、往復の矢印が重ならないようにする
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(26, len * 0.14);
  const cx = mx - (dy / len) * bend, cy = my + (dx / len) * bend;
  const p1 = edgePoint(a, { x: cx, y: cy }), p2 = edgePoint(b, { x: cx, y: cy });
  return `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
}

// 説明文は「上がる場合」で書いてあるので、下がる向きの問題ではそう添える
const revNote = (n, d) => (d < 0 ? `（説明は${n.up}の場合。${n.down}のときは逆に働く）` : "");

// つながり図から2択の問題を作る（強い・ふつうの関係から）
export function makeGraphQuiz(g, rnd = Math.random) {
  const pool = g.edges.filter(e => e.strength >= 2);
  const twoStep = rnd() < 0.3;
  if (twoStep) {
    for (let t = 0; t < 30; t++) {
      const e1 = pool[Math.floor(rnd() * pool.length)];
      const nexts = g.out[e1.to].filter(e => e.strength >= 2 && e.to !== e1.from);
      if (!nexts.length) continue;
      const e2 = nexts[Math.floor(rnd() * nexts.length)];
      const d0 = rnd() < 0.5 ? 1 : -1, d1 = d0 * e1.sign, d2 = d1 * e2.sign;
      const A = g.byId[e1.from], B = g.byId[e1.to], C = g.byId[e2.to];
      return {
        kind: "2段のつながり",
        q: `${A.short}が「${dirWord(A, d0)}」になると、${B.short}をへて、${C.name}はどうなりやすい？`,
        choices: [C.up, C.down], answer: d2 > 0 ? 0 : 1,
        explain: `${A.short}が${dirWord(A, d0)} → ${B.short}は${dirWord(B, d1)}：${e1.why}${revNote(A, d0)}\n${B.short}が${dirWord(B, d1)} → ${C.short}は${dirWord(C, d2)}：${e2.why}${revNote(B, d1)}`,
        nodes: [A.id, B.id, C.id],
      };
    }
  }
  const e = pool[Math.floor(rnd() * pool.length)];
  const d0 = rnd() < 0.5 ? 1 : -1, d1 = d0 * e.sign;
  const A = g.byId[e.from], B = g.byId[e.to];
  return {
    kind: "つながり",
    q: `${A.short}が「${dirWord(A, d0)}」になると、${B.name}はどうなりやすい？`,
    choices: [B.up, B.down], answer: d1 > 0 ? 0 : 1,
    explain: `${A.short}が${dirWord(A, d0)} → ${B.short}は${dirWord(B, d1)}：${e.why}${revNote(A, d0)}`,
    nodes: [A.id, B.id],
  };
}
