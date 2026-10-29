// 経済の関係を、起点ごとの一覧で読む。図の符号をそのまま使い、因果を逆向きにしない。
const STRENGTH = { 3: "強い", 2: "ふつう", 1: "条件しだい" };
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DOWN_REASON = {
  "boj>usdjpy": "日本の金利が下がると、円で運用する魅力が弱まり、円が売られやすい。日米の金利差が広がる向きに働く。",
  "boj>jgb10": "短い金利の引き下げは、長い金利にも下げの圧力をかける。",
  "boj>mortgage": "日銀の金利が下がると、短期プライムレートを通じて変動型の住宅ローン金利も下がりやすい。",
  "boj>banks": "貸出金利が下がると、預金金利との差である利ざやが縮まり、銀行の収益の重しになりやすい。",
  "fed>usdjpy": "アメリカの金利が下がると、ドルで運用する魅力が弱まり、ドル安・円高に傾きやすい。",
  "fed>ust10": "政策金利の引き下げや低金利の見通しが、長い期間の金利にも反映される。",
  "fed>us_economy": "借入コストが下がると、住宅購入や企業の投資を支え、景気の回復につながりやすい。",
  "ust10>jgb10": "米国の長期金利が下がると、世界の債券市場を通じて日本の長期金利にも下げの圧力がかかる。",
  "ust10>usdjpy": "長い期間の日米金利差が縮むと、ドルで運用する魅力が弱まり、円高に傾きやすい。",
  "ust10>us_stocks": "金利が下がると、将来の利益の価値が高く評価されやすく、特にハイテク株の支えになる。",
  "jgb10>mortgage": "長期金利が下がると、それを目安に決まる固定型の住宅ローン金利も下がりやすい。",
  "jgb10>realestate": "借りて不動産を買う負担が軽くなり、家賃収入の利回りの魅力も相対的に高まりやすい。",
  "jgb10>nikkei": "企業の借入コストや株の割高感が和らぎ、株価を支えやすい。ただし銀行の利ざやには逆風になりうる。",
  "jgb10>fiscal": "国債の利払い負担が軽くなると、国がほかの支出に使える余地が生まれやすい。",
  "mortgage>realestate": "返済負担が軽くなると借りられる金額が増え、住宅の購入需要を支えやすい。",
  "usdjpy>exporters": "円高になると、海外で稼いだドルを円に直した利益が小さくなりやすい。",
  "usdjpy>import_prices": "円の価値が上がると、同じ1ドルの品物をより少ない円で買えるようになる。",
  "usdjpy>inbound": "円高になると、海外の人から見た日本旅行の割安さが薄れ、訪日需要の重しになりやすい。",
  "usdjpy>construction": "輸入する木材・鉄鋼・設備などを円で安く買えると、建築費の上昇圧力が和らぐ。",
  "usdjpy>realestate": "円高になると、海外の投資家から見た日本の不動産の割安さが薄れ、購入需要の重しになりうる。",
  "usdjpy>boj": "円高で輸入物価への上昇圧力が和らぐと、為替を理由に金利を引き上げる必要性も弱まる。",
  "oil>import_prices": "日本が輸入する原油の代金が下がると、円建ての輸入物価にも下げの圧力がかかる。",
  "oil>trade_balance": "同じ量の原油をより安く輸入できると、輸入代金が減り、貿易収支が改善しやすい。",
  "oil>us_cpi": "ガソリン代などの負担が下がると、アメリカの物価上昇も和らぎやすい。",
  "trade_balance>usdjpy": "貿易赤字が広がると、輸入代金のために円を売ってドルを買う動きが増え、円安の圧力になる。",
  "import_prices>jp_cpi": "仕入れ価格の上昇が和らぐと、ガソリン・電気代・食品を値上げする圧力も弱まる。",
  "import_prices>construction": "輸入する資材やエネルギーが安くなると、建てる費用への上昇圧力が和らぐ。",
  "jp_cpi>household": "モノやサービスの値段が下がると、同じ暮らしに必要なお金が少なくなる。",
  "jp_cpi>boj": "物価上昇が弱まると、利上げを急ぐ必要性が薄れる。賃金や景気も政策判断に関わる。",
  "household>consumption": "生活費の負担が軽くなると、ほかの買い物やサービスにお金を回しやすくなる。",
  "wages>consumption": "給料が下がると使えるお金が減り、個人消費の重しになる。物価との比較も大事になる。",
  "wages>jp_cpi": "人件費の上昇が和らぐと、外食や宿泊などサービス価格を引き上げる圧力も弱まる。",
  "wages>boj": "賃金の伸びが弱まると、賃金と物価の好循環を確かめにくくなり、利上げを急ぐ理由も弱まる。",
  "labor_shortage>wages": "人手不足が和らぐと、人を集めるために給料を引き上げる圧力も弱まる。",
  "labor_shortage>construction": "職人の不足が和らぐと、人件費の上昇や工期の遅れを抑えやすくなる。",
  "consumption>jp_economy": "GDPの半分以上を占める個人消費が縮小すると、国内の景気の重しになる。",
  "jp_economy>nikkei": "国内景気が悪化すると、内需企業の利益への期待が弱まり、日本株の重しになりうる。",
  "construction>realestate": "建てる費用が下がると、新築マンションなどの販売価格への上昇圧力が和らぐ。",
  "inbound>jp_economy": "訪日客の消費が減ると、宿泊・飲食・小売などの売上やGDPを支える力が弱まる。",
  "exporters>nikkei": "輸出・グローバル企業の利益が減ると、それらの比重が大きい日経平均の重しになる。",
  "exporters>wages": "輸出企業の利益が減ると、翌年の春闘などで給料を引き上げる余力が小さくなりうる。",
  "us_economy>us_stocks": "米国景気が減速すると、企業の売上や利益への期待が弱まり、株価の重しになりやすい。",
  "us_economy>exporters": "大きな輸出先であるアメリカの需要が弱まると、日本企業の輸出や利益の重しになる。",
  "us_economy>us_cpi": "アメリカの需要が落ち着くと、モノやサービスの値上がり圧力も和らぎやすい。",
  "us_economy>fed": "米国景気が弱まると、借入負担を軽くして支えるための利下げを考えやすくなる。",
  "us_cpi>fed": "インフレが鈍化すると、物価を抑えるために高い金利を維持する必要性が弱まり、利下げの余地が生まれる。",
  "us_stocks>nikkei": "アメリカ株が下がると、投資家の心理や世界の資金の流れを通じて日本株にも下げの圧力がかかる。",
  "ai_semis>us_stocks": "AI・半導体への投資が縮むと、関連企業の受注や利益への期待が弱まり、米国の主力株の重しになりやすい。",
  "ai_semis>nikkei": "AI・半導体への投資が縮むと、日本の装置・素材メーカーへの需要期待が弱まり、日本株の重しになりやすい。",
  "tariffs>exporters": "関税や貿易摩擦が和らぐと、輸出品の追加費用や値上げの負担が減り、企業の利益を支えやすい。",
  "tariffs>us_cpi": "輸入品に上乗せされる関税が減ると、アメリカの物価を押し上げる力も弱まる。",
  "tariffs>china": "アメリカ向け輸出への制約が和らぐと、中国企業の売上や景気を支えやすい。",
  "tariffs>risk_off": "貿易の先行きが読みやすくなると、投資家が慎重になる理由の一つが和らぐ。",
  "china>exporters": "中国の景気が減速すると、機械・部品・素材などの需要が弱まり、日本企業の売上の重しになる。",
  "china>oil": "大きな資源輸入国である中国の需要が弱まると、原油価格への上昇圧力も弱まる。",
  "fiscal>jgb10": "財政支出や国債発行が抑えられると、国債の買い手を集めるための金利上昇圧力が和らぎやすい。",
  "fiscal>jp_economy": "公共事業や給付などが縮むと、目先の需要を支える力が弱まる。",
  "fiscal>usdjpy": "財政への不安が和らぐと、それを理由に円を売る圧力も弱まる局面がある。",
  "geopolitics>oil": "産油地域の緊張が和らぐと、原油が届かなくなる不安が薄れ、価格の上昇圧力が和らぐ。",
  "geopolitics>risk_off": "戦争や緊張への不安が薄れると、投資家がリスクを避ける動きも和らぎやすい。",
  "risk_off>gold": "投資家の不安が和らぐと、安全な逃避先として金を買う動きが弱まりやすい。",
  "risk_off>nikkei": "投資家の不安が和らぐと、値動きの大きい日本株にも資金が戻りやすい。",
  "risk_off>us_stocks": "投資家の不安が和らぐと、値動きの大きい米国株にも資金が戻りやすい。",
  "risk_off>ust10": "安全な逃避先として米国債を買う動きが弱まると、債券価格が下がり、利回りが上がりやすい。",
  "risk_off>usdjpy": "不安を理由に円を買う動きが和らぐと、円安の向きに働くことがある。この関係は条件に左右されやすい。",
  "nikkei>consumption": "株や投資信託の値下がりで資産が減ると、お金を使う余裕や気持ちが弱まりやすい。",
};

function nodesOf(graph) { return graph.byId || Object.fromEntries(graph.nodes.map(node => [node.id, node])); }
function num(direction) { return direction === "down" || direction === -1 ? -1 : 1; }
function word(node, direction) { return num(direction) > 0 ? node.up : node.down; }
function condition(node, direction) {
  const value = word(node, direction);
  if (node.id === "jp_cpi") return num(direction) > 0 ? "物価が上がると" : "物価が下がると";
  if (node.id === "us_cpi") return num(direction) > 0 ? "インフレが強まると" : "インフレが鈍化すると";
  if (node.id === "exporters" || node.id === "banks") return num(direction) > 0 ? "利益が増えると" : "利益が減ると";
  if (/賃上げ|賃下げ/.test(value)) return `${value}が進むと`;
  if (value === "インフレ") return "インフレが強まると";
  if (/なる$|まる$|らぐ$/.test(value)) return `${value}と`;
  if (/円安|円高|株高|株安|物価高|物価安|原油高|原油安|好調|増益|減益/.test(value)) return `${value}になると`;
  return `${value}すると`;
}
function conditionSentence(node, direction) {
  const positive = num(direction) > 0;
  if (node.id === "boj" || node.id === "fed") return `${node.short}が${condition(node, direction)}`;
  if (node.id === "wages") return positive ? "賃上げが進むと" : "賃下げが進むと";
  if (node.id === "jp_cpi") return `日本の物価が${positive ? "上がる" : "下がる"}と`;
  if (node.id === "us_cpi") return `米国のインフレが${positive ? "強まる" : "鈍化する"}と`;
  if (node.id === "exporters" || node.id === "banks") return `${node.name}が${positive ? "増える" : "減る"}と`;
  return `${node.name}が${condition(node, direction)}`;
}

export function relationshipReason(graph, edge, direction = "up") {
  if (!edge) return "";
  const key = `${edge.from}>${edge.to}`;
  if (num(direction) > 0) return edge.why || "";
  if (DOWN_REASON[key]) return DOWN_REASON[key];
  // 未知の辺に、上昇時の文章を下降時の理由としてそのまま出さない。
  const byId = nodesOf(graph), a = byId[edge.from], b = byId[edge.to];
  return a && b ? `${a.name}の${a.down}は、${b.name}の${word(b, -edge.sign)}につながる向きで働く。` : "";
}

function relationRow(graph, edge, direction, { esc, gl, seen, incoming = false }) {
  const byId = nodesOf(graph), a = byId[edge.from], b = byId[edge.to];
  const dir = num(direction), result = dir * edge.sign;
  const id = `${a.id}:${b.id}:${dir > 0 ? "up" : "down"}`;
  const why = relationshipReason(graph, edge, dir);
  return `<li class="relationship-line"><button class="relationship-link" data-relation="${esc(id)}"><span class="relationship-target">${incoming ? `${esc(a.short)}が${esc(condition(a, dir))}` : esc(b.name)}</span><span class="relationship-result ${result > 0 ? "up-t" : "down-t"}">${incoming ? `${esc(b.short)}は` : ""}${esc(word(b, result))}<span class="relationship-tendency">方向</span></span><span class="relationship-chevron" aria-hidden="true">›</span></button><p class="relationship-why">${gl(why, seen)}</p>${edge.strength === 1 ? '<span class="relationship-conditional">条件しだい</span>' : ""}</li>`;
}

export function renderRelationships({ graph, data, category = "all", directions = {}, esc = escapeHtml, gl = escapeHtml }) {
  if (!graph?.nodes?.length) return "";
  const out = graph.out || Object.fromEntries(graph.nodes.map(node => [node.id, graph.edges.filter(edge => edge.from === node.id)]));
  const inn = graph.inn || Object.fromEntries(graph.nodes.map(node => [node.id, graph.edges.filter(edge => edge.to === node.id)]));
  const present = new Set(graph.nodes.map(node => node.cat));
  const cats = graph.cats.filter(cat => present.has(cat.id));
  const filters = [{ id: "all", name: "すべて" }, ...cats].map(cat => `<button class="filter${category === cat.id ? " on" : ""}" data-connection-cat="${esc(cat.id)}" aria-pressed="${category === cat.id}">${esc(cat.name)}</button>`).join("");
  const groups = cats.filter(cat => category === "all" || category === cat.id).map(cat => {
    const cards = graph.nodes.filter(node => node.cat === cat.id).map(node => {
      const edges = [...(out[node.id] || [])].sort((a, b) => b.strength - a.strength);
      const dir = num(directions[node.id]);
      const seen = new Set();
      const toggles = edges.length ? `<div class="relationship-condition" role="group" aria-label="${esc(node.name)}の変化">${[1, -1].map(d => `<button class="${d === dir ? "on" : ""}" data-connection-dir="${esc(node.id)}:${d > 0 ? "up" : "down"}" aria-pressed="${d === dir}">${esc(condition(node, d))}</button>`).join("")}</div>` : "";
      const rows = edges.length ? edges.map(edge => relationRow(graph, edge, dir, { esc, gl, seen })).join("") : (inn[node.id] || []).map(edge => relationRow(graph, edge, directions[edge.from] || "up", { esc, gl, seen, incoming: true })).join("");
      return `<article class="relationship-card" id="connection-${esc(node.id)}" data-connection-card="${esc(node.id)}"><div class="relationship-head"><h3><button data-connection-node="${esc(node.id)}">${esc(node.name)}<span aria-hidden="true">›</span></button></h3>${toggles}</div>${!edges.length && rows ? '<div class="relationship-incoming-label">影響を受けるつながり</div>' : ""}<ul class="relationship-lines">${rows}</ul></article>`;
    }).join("");
    return `<section class="relationship-group" aria-label="${esc(cat.name)}"><h2>${esc(cat.name)}</h2>${cards}</section>`;
  }).join("");
  return `<div class="relationship-filters chips scroll" role="group" aria-label="つながりの分類">${filters}</div><div class="relationships">${groups}</div>`;
}

export function relationshipDetail({ graph, data, from, to, direction = "up", esc = escapeHtml, gl = escapeHtml }) {
  const byId = nodesOf(graph), a = byId[from], b = byId[to];
  const edge = graph.edges.find(item => item.from === from && item.to === to);
  if (!a || !b || !edge) return "";
  const dir = num(direction), result = dir * edge.sign;
  const seen = new Set();
  const related = (data?.news || []).filter(news => (news.tags || []).some(tag => tag.node === from || tag.node === to)).slice(0, 4);
  return `<div class="relationship-detail"><h2>${esc(conditionSentence(a, dir))}</h2><div class="relationship-detail-result ${result > 0 ? "up-t" : "down-t"}"><span aria-hidden="true">→</span> ${esc(b.name)}は${esc(word(b, result))}方向</div><p class="relationship-detail-why">${gl(relationshipReason(graph, edge, dir), seen)}</p><div class="relationship-facts"><span>関係：${esc(STRENGTH[edge.strength] || "条件しだい")}</span>${edge.lag ? `<span>反映の目安：${esc(edge.lag)}</span>` : ""}</div>${b.life ? `<h3>暮らし・仕事への関わり</h3><p>${gl(b.life, seen)}</p>` : ""}<div class="relationship-detail-nodes">${[a, b].map(node => `<button data-connection-node="${esc(node.id)}">${esc(node.name)}<span aria-hidden="true">›</span></button>`).join("")}</div>${related.length ? `<h3>関連ニュース</h3><div class="relationship-related">${related.map(news => `<button data-news="${esc(news.id)}"><span>${esc(news.title_ja || news.title)}</span><small>${esc(news.source)}</small></button>`).join("")}</div>` : ""}</div>`;
}
