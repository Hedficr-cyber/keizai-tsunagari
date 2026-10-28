"""集めたニュースを Claude で読み解き、アプリが読むデータを作る。

使い方: /opt/homebrew/bin/python3 -X utf8 tools/analyze.py [--no-ai] [--reuse] [--review] [--weekly] [--force] [--dry-run]
- ふだん（引数なし）: 今日の読み解き → data/latest.json、data/archive/日付.json、data/threads.json（流れ）
- --review: 3日ほど前の「今後こうなるかも」の答え合わせ → data/reviews.json（1日1回）
- --weekly: 週末に1週間のまとめ → data/weekly/年-W週.json（週に1回。--force で曜日を問わず作る）
- --reuse: AI を呼ばず、前回の AI の結果（_work/raw/ai_*.json）から作り直す（開発用）
- --dry-run: data/ ではなく _work/dry/ に書く（試し用）
- Claude Code（デスクトップアプリに入っている claude コマンド）を裏で呼ぶ。呼べないときは何も書き換えない（前の版が残る）。
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "_work" / "raw" / "collected.json"
JST = timezone(timedelta(hours=9))
MODEL = os.environ.get("KEIZAI_MODEL", "sonnet")
MAX_NEWS = 420  # 媒体ごとの上限は collect.py（sources.json の max）でかけている
MAX_EXPERTS = 45
ARGS = set(sys.argv[1:])
DATA = ROOT / "_work" / "dry" if "--dry-run" in ARGS else ROOT / "data"
OUT = DATA / "latest.json"
ARCHIVE = DATA / "archive"
THREADS = DATA / "threads.json"
REVIEWS = DATA / "reviews.json"
WEEKLY = DATA / "weekly"
# 相場の数字と照らすときの「動いた」とみなす幅（1週間）
MOVE_MIN = {"usdjpy": 0.3, "jgb10": 0.03, "ust10": 0.03}

SYSTEM = """あなたは経済・金融ニュースの解説者です。経済を学び始めた大学生に向けて、ニュースどうしのつながりと、この先の影響をやさしく説明します。
守ること:
- 見出しと要約に書かれていない事実を作らない。数字は与えられたものだけを使う。
- 「起きたこと」と「この先の見通し」をはっきり分け、見通しは「〜かもしれない」「〜の可能性がある」と書く。
- 特定の銘柄の売買をすすめない。
- 識者の見方は、その人自身の発言・寄稿として読み取れるものだけを要約する。名前が出てくるだけの記事や、別人の記事は relevant を false にする。
- 日本語で書く。一文は40字くらいまでに短く切る。むずかしい言葉は少なくし、使うときはかんたんな言い換えを添える。"""

DIR = {"type": "string", "enum": ["up", "down"]}


def obj(props, required=None):
    return {"type": "object", "additionalProperties": False, "required": required or list(props), "properties": props}


def arr(items, lo=None, hi=None, desc=None):
    a = {"type": "array", "items": items}
    if lo is not None:
        a["minItems"] = lo
    if hi is not None:
        a["maxItems"] = hi
    if desc:
        a["description"] = desc
    return a


def s(desc=None):
    return {"type": "string", **({"description": desc} if desc else {})}


def tag_schema(nodes):
    return obj({"node": {"type": "string", "enum": nodes}, "dir": DIR})


def main_schema(nodes, cats):
    tag = tag_schema(nodes)
    return obj({
        "headline": s("今日の世の中の動きを一言で（40字以内）"),
        "themes": arr(obj({
            "title": s("テーマ名（20字以内）"),
            "point": s("ひとことで言うと（30字以内。一覧に出す）"),
            "thread": s("このテーマが続いている『流れ』の名前（15字以内）。既にある流れと同じ話題ならその名前をそのまま使う"),
            "what": s("何が起きたか（事実だけ・100字以内・短い文で）"),
            "chain": arr(tag, 2, 6, "原因から影響へ、つながり図の項目を順に並べる"),
            "chain_text": s("そのつながりの説明（150字以内）"),
            "outlook": arr(s(), 2, 3, "今後こうなるかもしれないこと（各70字以内）"),
            "watch": s("次に注目する予定・指標（60字以内）"),
            "news": arr(s(), desc="関係するニュースのID（n12 など）"),
            "experts": arr(s(), desc="関係する識者の発信のID（e3 など）"),
        }), 3, 5),
        "news": arr(obj({
            "id": s(), "tags": arr(tag, hi=3),
            "cat": {"type": "string", "enum": cats, "description": "分類を1つ（そのニュースのいちばん大事な面で選ぶ）"},
            "same": arr(s(), desc="同じ出来事を伝える別の記事のID（この1本にまとめたもの）"),
            "title_ja": s("英語の記事（[英語]の印）のときだけ、内容がわかる短い日本語の見出し（40字以内）。日本語の記事は空文字"),
            "plain": s("やさしい要点（60字以内）"), "next": s("この先どうつながるか（70字以内）"),
            "level": {"type": "integer", "minimum": 1, "maximum": 3, "description": "重要度 3=大きい"},
        })),
        "experts": arr(obj({
            "id": s(), "relevant": {"type": "boolean"}, "view": s("この人の見方（90字以内）"),
            "stance": {"type": "string", "enum": ["強気", "慎重", "中立"]}, "tags": arr(tag, hi=3),
        })),
        "debates": arr(obj({
            "topic": s("見方が分かれている話題（25字以内）"),
            "crux": s("どこで見方が分かれるのか（80字以内）"),
            "sides": arr(obj({
                "stance": {"type": "string", "enum": ["強気", "慎重"]},
                "experts": arr(s(), 1, 4, "その見方の識者の発信のID（e3 など）"),
                "view": s("その側の見方の要約（90字以内）"),
            }), 2, 2),
        }), 0, 3, "識者の見方が分かれている点。はっきり分かれているものだけ（なければ空）"),
        "scenarios": arr(obj({
            "event": s("予定の名前"), "date": s("YYYY-MM-DD（わからなければ空文字）"),
            "focus": s("何が焦点か（70字以内）"),
            "cases": arr(obj({
                "label": s("場合の名前（例：予想より利下げに前向き）（25字以内）"),
                "chain": arr(tag, 2, 5),
                "text": s("そうなったときの広がり（90字以内）"),
            }), 2, 2),
        }), 0, 5, "これからの予定ごとの2通りのシナリオ"),
        "terms": arr(obj({"term": s("言葉（文中の書き方のまま）"), "explain": s("高校生にわかる説明（60字以内・1〜2文）")}), 0, 12,
                     "今日の文章に出てくる難しい言葉のうち、下の用語集にないもの"),
        "moving": arr(obj({"node": {"type": "string", "enum": nodes}, "dir": DIR,
                           "why": s("いまそう動いている理由（50字以内）")}), 3, 10),
        "quiz": arr(obj({"q": s(), "choices": arr(s(), 3, 3),
                         "answer": {"type": "integer", "minimum": 0, "maximum": 2}, "explain": s()}), 3, 3),
    })


def review_schema():
    return obj({
        "summary": s("この答え合わせのまとめ（120字以内）"),
        "items": arr(obj({
            "theme": s("もとのテーマ名"),
            "outlook": s("もとの見通し（そのまま）"),
            "verdict": {"type": "string", "enum": ["当たり", "一部当たり", "外れ", "まだわからない"]},
            "actual": s("実際にどうなったか（100字以内。材料にある事実だけ）"),
            "lesson": s("そこから学べること・外れた理由（90字以内）"),
        }), 1, 12),
    })


def weekly_schema(nodes):
    tag = tag_schema(nodes)
    return obj({
        "title": s("この1週間を一言で（35字以内）"),
        "summary": s("1週間の大きな流れ（250字以内）"),
        "moves": arr(obj({"title": s("動きの名前（20字以内）"), "text": s("何が起きて、何につながったか（140字以内）"),
                          "chain": arr(tag, 2, 5)}), 2, 5),
        "markets": s("相場の1週間（ドル円・日米の金利）の動きと理由（120字以内）"),
        "next_week": arr(obj({"date": s("YYYY-MM-DD か空文字"), "event": s(), "why": s("なぜ注目か（60字以内）")}), 0, 5),
        "lessons": arr(s("今週わかった経済のつながり（60字以内）"), 2, 4),
    })


def short_time(iso):
    if not iso:
        return ""
    return datetime.fromisoformat(iso).astimezone(JST).strftime("%m/%d %H:%M")


def load(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save(path, data, pretty=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1 if pretty else None), encoding="utf-8")


def markets_text(markets):
    mk = []
    for m in markets.values():
        ser = m.get("series") or []
        if len(ser) < 2:
            continue
        last = ser[-1]
        week = ser[-6] if len(ser) >= 6 else ser[0]
        month = ser[-22] if len(ser) >= 22 else ser[0]
        mk.append(f"{m['name']}：{last['v']}{m['unit']}（{last['d']}）／1週間前 {week['v']}／1か月前 {month['v']}")
    return "\n".join(mk) or "（なし）"


def market_moves(markets):
    """相場の1週間の向き。テーマのつながりやいま動いているものと照らすのに使う。"""
    out = {}
    for key, m in markets.items():
        ser = m.get("series") or []
        if len(ser) < 6:
            continue
        last, base = ser[-1], ser[-6]
        diff = last["v"] - base["v"]
        if abs(diff) < MOVE_MIN.get(key, 0):
            continue
        unit = "円" if m["unit"] == "円" else "pt"
        out[key] = {"dir": "up" if diff > 0 else "down",
                    "text": f"1週間で {base['v']}→{last['v']}{m['unit']}（{'+' if diff > 0 else '−'}{abs(diff):.2f}{unit}）"}
    return out


def value_on(series, day):
    """day（YYYY-MM-DD）以前でいちばん近い値。"""
    pts = [p for p in series or [] if p["d"] <= day]
    return pts[-1] if pts else None


def glossary_words():
    g = load(ROOT / "data" / "glossary.json", {"terms": []})
    return [k for t in g["terms"] for k in [t["t"], *t.get("a", [])]]


def build_prompt(graph, raw, experts_cfg, threads):
    nodes = "\n".join(f"{n['id']}｜{n['name']}｜上がる＝{n['up']}／下がる＝{n['down']}" for n in graph["nodes"])
    edges = " ".join(f"{e['from']}>{e['to']}({'+' if e['sign'] > 0 else '-'})" for e in graph["edges"])
    news = "\n".join(
        f"[n{i}] {'[英語] ' if x.get('lang') == 'en' else ''}{x['source']} {short_time(x['time'])}｜{x['title']}" + (f"｜{x['summary'][:90]}" if x["summary"] else "")
        for i, x in enumerate(raw["news"][:MAX_NEWS]))
    who = {e["id"]: e for e in experts_cfg}
    exps = "\n".join(
        f"[e{i}] {who[x['expert']]['name']}（{who[x['expert']]['role']}）｜{x['kind']}｜{x['source']} {short_time(x['time'])}｜{x['title']}"
        + (f"｜{x['summary'][:260]}" if x["summary"] else "")
        for i, x in enumerate(raw["experts"][:MAX_EXPERTS]))
    today = datetime.now(JST).date()
    cal = "\n".join(f"{e['date']}｜{e['name']}｜{e['note']}" for e in raw.get("calendar", [])
                    if e["date"] <= (today + timedelta(days=14)).isoformat()) or "（なし）"
    th = "\n".join(f"{t['name']}（最後 {t['entries'][-1]['date']}・{len(t['entries'])}日分）"
                   for t in sorted(threads.get("threads", []), key=lambda t: t["entries"][-1]["date"], reverse=True)[:25]) or "（まだない）"
    return f"""今日は {datetime.now(JST).strftime('%Y年%m月%d日 %H時')}。下の材料から、今日の経済の動きを読み解いてください。

## 相場の数字（公的な実データ。上がった・下がったはこの数字を優先する）
{markets_text(raw.get('markets', {}))}

## これから2週間の大きな予定（公式の日程）
{cal}

## これまでの『流れ』（テーマの続き）
{th}

## つながり図の項目（id｜名前｜上がる／下がるの意味）
{nodes}

## つながり図にある基本の関係（原因>結果、+は同じ向き、-は逆向き）
{edges}

## ニュース（ID｜媒体 日時｜見出し｜要約）
{news}

## 識者の発信（ID｜名前（肩書き）｜種類｜媒体 日時｜題名｜要約）
{exps}

## ニュースの分類（cat に使う id｜名前）
{chr(10).join(f"{c['id']}｜{c['name']}" for c in graph["cats"])}

## 用語集にある言葉（アプリでタップすると説明が出る。terms には入れない）
{"、".join(glossary_words())}

## 作るもの
- headline: 今日の世の中の動きを一言で。
- themes: 今日いちばん大事な動きを3〜5個。経済への影響が大きい動きだけにする（情報流出・サイバー攻撃などの事件は、相場や業績を大きく動かしたときだけ）。chain は原因から影響へ、項目を順に並べる（なるべく上の基本の関係に沿う。沿わないつながりは chain_text で理由を書く）。chain の向きは今日実際に起きている向き（相場の数字とニュース）に合わせ、まだ起きていない仮の向きを使うときは chain_text に「もし〜なら」と書く。outlook は「〜かもしれない」で。thread は、上の『流れ』と同じ話題ならその名前をそのまま使い、新しい話題なら短い名前を付ける。つながり図の基本の関係でうまくつながらないときは、chain を2項目にとどめ、無理に項目を足さない。
- news: 経済・金融・ビジネスに関係し、世の中の流れを知るために押さえておきたいものを30〜50本選び、重要な順に並べる。個人の好みやクリックされやすさでは選ばない。金融政策・為替・物価や景気・企業や産業・海外や政治の動きを広く見渡し、原資料に大事な動きがある分野を落とさない。一つの人気業界や銘柄だけで埋めない。新聞・通信社・経済誌・公的機関・海外の媒体を広く見渡し、同じ大事さなら一つの媒体ばかりにならないようにする。海外の媒体（[英語] を含む）は、日本の経済や世界の流れに関わる大事な動きを拾う。公的機関の発表は、政策や統計として大事なものだけにする。ただし原資料にない話題を分野の穴埋めのために作らない。スポーツ・事件・芸能などは入れない。同じ出来事の続報・別の媒体・見出し違いは、いちばん詳しい1本だけを選び、残りの ID を same に入れる（別の意味を持つ変化だけ分ける）。cat は下の分類から1つ選ぶ（例：日経平均の動き→market、日銀の決定→policy、企業の決算→industry、物価の統計→economy、海外の景気→global、政府の予算や選挙→politics、家計や住宅→life）。情報流出・サイバー攻撃・事件・選挙制度などは、経済への影響がはっきりしているときだけ入れ、level は1にする。level=3 は経済全体に広く影響する動きや重要な政策・統計、level=2 はその分野の流れを知るために押さえる動き、level=1 は補足。plain は見出しの繰り返しだけでなく、何が変わりなぜ押さえたいかを、原資料から分かる範囲の短い一文で書く。tags はそのニュースが動かす項目と向き（関係が薄ければ空でよい）。
- experts: すべての識者の発信について、その人の見方として読めるかを判断する（relevant）。
- debates: relevant な識者の発信のなかで、同じ話題について強気と慎重に見方が分かれているもの。無理に作らない。
- scenarios: 上の予定のうち2週間以内のものそれぞれに、結果が2通りに分かれた場合の広がり。ニュースに日付つきで出てくる大きな予定（米雇用統計・米消費者物価など）があれば足してよい（日付がわからなければ date は空文字）。
- moving: 今日のニュースから見て、いま動いている項目と向き。
- quiz: 今日のニュースを使った3択クイズを3問。つながり（AならB）を考えさせる問題にする。
- terms: あなたが書いた文章（what・chain_text・outlook・plain・next・view など）に出てくる難しい言葉で、上の用語集にないもの。会社名・人名は入れない。"""


def find_claude():
    p = shutil.which("claude")
    if p:
        return p
    found = sorted(glob.glob(os.path.expanduser(
        "~/Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude")),
        key=lambda s: [int(x) if x.isdigit() else x for x in re.split(r"[./]", s.split("claude-code/")[1].split("/")[0])])
    return found[-1] if found else None


def run_claude(prompt, schema, name):
    """Claude を1回呼ぶ。結果は _work/raw/ai_{name}.json にも残す（--reuse で使い回せる）。"""
    keep = ROOT / "_work" / "raw" / f"ai_{name}.json"
    if "--reuse" in ARGS:
        got = load(keep, None)
        if not got:
            raise RuntimeError(f"{keep.name} がないので使い回せない")
        return got["data"], got["meta"]
    exe = find_claude()
    if not exe:
        raise RuntimeError("claude コマンドが見つからない")
    cmd = [exe, "-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
           "--output-format", "json", "--model", MODEL, "--system-prompt", SYSTEM,
           "--json-schema", json.dumps(schema, ensure_ascii=False)]
    (ROOT / "_work").mkdir(exist_ok=True)
    p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=900, cwd=str(ROOT / "_work"))
    if p.returncode != 0:
        raise RuntimeError(f"claude が失敗: {p.stderr[-400:] or p.stdout[-400:]}")
    out = json.loads(p.stdout)
    data = out.get("structured_output")
    if data is None:
        m = re.search(r"\{.*\}", out.get("result", ""), re.S)
        data = json.loads(m.group(0)) if m else None
    if not isinstance(data, dict):
        raise RuntimeError("claude の結果を読めない")
    meta = {"model": MODEL, "cost_usd": out.get("total_cost_usd"), "ms": out.get("duration_ms")}
    save(keep, {"data": data, "meta": meta}, pretty=True)
    return data, meta


def source_stats(cfg, raw, news):
    """媒体ごとの、集めた本数と載せた本数（画面の「集めている媒体」に出す）。"""
    got, shown = {}, {}
    feed_of = {}
    for i, x in enumerate(raw["news"]):
        got[x["feed"]] = got.get(x["feed"], 0) + 1
        feed_of[f"n{i}"] = x["feed"]
    for n in news:
        f = feed_of.get(n["id"])
        shown[f] = shown.get(f, 0) + 1
    return [{"name": s["name"], "group": s.get("group", ""), "lang": s.get("lang", "ja"),
             "collected": got.get(s["id"], 0), "shown": shown.get(s["id"], 0)} for s in cfg["news"]]


def bigrams(t):
    t = re.sub(r"[\s　、。,.・「」『』【】（）()!?！？:：\-－—…｜|]", "", t)
    return {t[i:i + 2] for i in range(len(t) - 1)}


def merge_similar(news, limit=0.5):
    """AI がまとめきれなかった、見出しがほぼ同じ記事を1本にまとめる（上にあるほうを残す）。"""
    out, alias = [], {}
    for n in news:
        b = bigrams(n["title"])
        twin = next((o for o in out if b and len(b & bigrams(o["title"])) / len(b | bigrams(o["title"])) >= limit), None)
        if twin:
            twin.setdefault("related", []).append({k: n[k] for k in ("title", "link", "source", "time")})
            twin["related"].extend(n.get("related", []))
            alias[n["id"]] = twin["id"]
        else:
            out.append(n)
    return out, alias


def keyword_tags(title, graph):
    """AI を使わないときの簡易な項目付け（向きは付けない）。"""
    return [{"node": n["id"], "dir": None} for n in graph["nodes"] if any(k in title for k in n["kw"])][:3]


def daily(graph, cfg, raw):
    node_ids = [n["id"] for n in graph["nodes"]]
    by_id = {n["id"]: n for n in graph["nodes"]}
    edge_set = {(e["from"], e["to"]) for e in graph["edges"]}
    experts_cfg = {e["id"]: e for e in cfg["experts"]}
    threads = load(THREADS, {"threads": []})
    no_ai = "--no-ai" in ARGS

    ai, meta = None, None
    if not no_ai:
        try:
            ai, meta = run_claude(build_prompt(graph, raw, cfg["experts"], threads), main_schema(node_ids, [c["id"] for c in graph["cats"]]), "main")
        except Exception as e:  # noqa: BLE001
            # 失敗した回は前の版を残す（キーワードだけの薄い版で上書きしない）
            print("AI の分析に失敗したので、前の版を残す:", str(e)[:300], file=sys.stderr)
            return 2

    def ok_tags(tags):
        return [dict(t) for t in tags or [] if t.get("node") in node_ids]

    def ref(prefix, r, n):
        m = re.match(rf"^{prefix}(\d+)$", r or "")
        return int(m.group(1)) if m and int(m.group(1)) < n else None

    def news_item(i, extra=None):
        x = raw["news"][i]
        item = {"id": f"n{i}", "title": x["title"], "link": x["link"], "source": x["source"], "time": x["time"],
                "group": x.get("group", ""), **(extra or {})}
        if x.get("lang") == "en":
            item["lang"] = "en"
        return item

    def expert_item(i, extra=None):
        x = raw["experts"][i]
        ex = experts_cfg[x["expert"]]
        return {"id": f"e{i}", "expert": x["expert"], "name": ex["name"], "role": ex["role"], "kind": x["kind"],
                "title": x["title"], "link": x["link"], "source": x["source"], "time": x["time"], **(extra or {})}

    now = datetime.now(JST)
    today = now.date().isoformat()
    moves = market_moves(raw.get("markets", {}))
    debates, scenarios, conflicts = [], [], 0
    if ai:
        news, used, alias = [], set(), {}
        cat_ids = {c["id"] for c in graph["cats"]}

        def cat_of(c, tags):
            # 分類は AI が選んだもの。ないときは、いちばん目の項目札の分類
            if c in cat_ids:
                return c
            return next((by_id[t["node"]]["cat"] for t in tags if t["node"] in by_id), "")

        def brief_item(i):
            x = raw["news"][i]
            return {"title": x["title"], "link": x["link"], "source": x["source"], "time": x["time"]}

        for n in ai.get("news", []):
            i = ref("n", n.get("id"), len(raw["news"]))
            if i is None or i in used:
                continue
            used.add(i)
            tags = ok_tags(n.get("tags"))
            # 同じ出来事の別の記事は、代表の1本の中に「関連記事」として入れる
            related = []
            for r in n.get("same", []):
                j = ref("n", r, len(raw["news"]))
                if j is not None and j not in used:
                    used.add(j)
                    alias[f"n{j}"] = f"n{i}"
                    related.append(brief_item(j))
            extra_ja = {"title_ja": n["title_ja"].strip()} if raw["news"][i].get("lang") == "en" and (n.get("title_ja") or "").strip() else {}
            news.append(news_item(i, {**extra_ja, "tags": tags, "cat": cat_of(n.get("cat"), tags), "plain": n.get("plain", ""),
                                      "next": n.get("next", ""), "level": n.get("level", 1), "related": related}))
        news, more = merge_similar(news)
        alias.update(more)
        experts = []
        for e in ai.get("experts", []):
            i = ref("e", e.get("id"), len(raw["experts"]))
            if i is None or not e.get("relevant"):
                continue
            experts.append(expert_item(i, {"view": e.get("view", ""), "stance": e.get("stance", "中立"),
                                           "tags": ok_tags(e.get("tags"))}))
        shown = {x["id"] for x in experts}
        themes = []
        for t in ai.get("themes", []):
            chain = ok_tags(t.get("chain"))
            for a, b in zip(chain, chain[1:]):
                b["known"] = (a["node"], b["node"]) in edge_set
            # 相場の数字（1週間）と逆向きの項目には、実際の動きを添える
            for c in chain:
                mv = moves.get(c["node"])
                if mv and mv["dir"] != c["dir"]:
                    n = by_id[c["node"]]
                    c["conflict"] = f"{n['short']}は実際には{n['up'] if mv['dir'] == 'up' else n['down']}方向（{mv['text']}）"
                    conflicts += 1
            refs = [ref("n", r, len(raw["news"])) for r in t.get("news", [])]
            for i in refs:
                if i is not None and i not in used:
                    used.add(i)
                    news.append(news_item(i, {"tags": [], "cat": "", "plain": "", "next": "", "level": 1, "related": []}))
            themes.append({
                "title": t.get("title", ""), "point": t.get("point", ""), "thread": (t.get("thread") or t.get("title", ""))[:20], "what": t.get("what", ""),
                "chain": chain, "chain_text": t.get("chain_text", ""), "outlook": t.get("outlook", []), "watch": t.get("watch", ""),
                # まとめた記事を指していたら、代表の1本に置きかえる
                "news": list(dict.fromkeys(alias.get(f"n{i}", f"n{i}") for i in refs if i is not None)),
                "experts": [f"e{i}" for i in (ref("e", r, len(raw["experts"])) for r in t.get("experts", [])) if i is not None and f"e{i}" in shown],
            })
        brief = {"headline": ai.get("headline", ""), "themes": themes}
        moving = []
        for m in ai.get("moving", []):
            if m.get("node") not in node_ids:
                continue
            mv = moves.get(m["node"])
            if mv and mv["dir"] != m["dir"]:
                m = {**m, "dir": mv["dir"], "why": mv["text"], "fixed": True}
                conflicts += 1
            moving.append(m)
        for d in ai.get("debates", []):
            sides = []
            for sd in d.get("sides", []):
                ids = [f"e{i}" for i in (ref("e", r, len(raw["experts"])) for r in sd.get("experts", [])) if i is not None and f"e{i}" in shown]
                if ids:
                    sides.append({"stance": sd.get("stance"), "experts": ids, "view": sd.get("view", "")})
            if len(sides) == 2 and sides[0]["stance"] != sides[1]["stance"]:
                debates.append({"topic": d.get("topic", ""), "crux": d.get("crux", ""), "sides": sides})
        for sc in ai.get("scenarios", []):
            cases = [{"label": c.get("label", ""), "chain": ok_tags(c.get("chain")), "text": c.get("text", "")} for c in sc.get("cases", [])]
            if len(cases) == 2:
                dt = sc.get("date", "")
                scenarios.append({"event": sc.get("event", ""), "date": dt if re.match(r"^\d{4}-\d{2}-\d{2}$", dt or "") else "",
                                  "focus": sc.get("focus", ""), "cases": cases})
        quiz = [q for q in ai.get("quiz", []) if len(q.get("choices", [])) == 3]
        # 今日の用語：用語集にない言葉で、実際に文章に出てくるものだけ
        known = set(glossary_words())
        text = json.dumps([brief, news, experts, debates, scenarios], ensure_ascii=False)
        terms, seen_t = [], set()
        for t in ai.get("terms", []):
            w = (t.get("term") or "").strip()
            if w and w not in known and w not in seen_t and w in text and t.get("explain"):
                seen_t.add(w)
                terms.append({"term": w, "explain": t["explain"]})
    else:
        terms = []
        news = [news_item(i, {"tags": keyword_tags(x["title"], graph), "plain": "", "next": "", "level": 1})
                for i, x in enumerate(raw["news"][:80])]
        experts = [expert_item(i, {"view": "", "stance": "中立", "tags": keyword_tags(x["title"], graph)})
                   for i, x in enumerate(raw["experts"]) if x["kind"] != "記事"]
        brief, moving, quiz = {"headline": "", "themes": []}, [], []

    data = {
        "updated": now.isoformat(timespec="seconds"),
        "collected": raw["collected"],
        "ai": meta,
        "brief": brief,
        "moving": moving,
        "news": news,
        "experts": experts,
        "debates": debates,
        "scenarios": scenarios,
        "calendar": raw.get("calendar", []),
        "markets": raw["markets"],
        "quiz": quiz,
        "terms": terms,
        "sources": source_stats(cfg, raw, news),
    }
    save(OUT, data, pretty=True)
    save(ARCHIVE / f"{today}.json", data)
    save(ARCHIVE / "index.json", {"days": sorted(p.stem for p in ARCHIVE.glob("????-??-??.json"))})
    if ai:
        # 流れ：今日の分を入れ替える（同じ日に何度更新しても、その日の最後の内容が残る）
        th = {t["name"]: t for t in threads.get("threads", [])}
        for t in th.values():
            t["entries"] = [e for e in t["entries"] if e["date"] != today]
        for t in brief["themes"]:
            entry = {"date": today, "title": t["title"], "what": t["what"], "chain": t["chain"],
                     "outlook": t["outlook"], "watch": t["watch"]}
            th.setdefault(t["thread"], {"name": t["thread"], "entries": []})["entries"].append(entry)
        cut = (now.date() - timedelta(days=60)).isoformat()
        kept = []
        for t in th.values():
            t["entries"] = sorted(t["entries"], key=lambda e: e["date"])[-40:]
            if t["entries"] and t["entries"][-1]["date"] >= cut:
                kept.append(t)
        kept.sort(key=lambda t: (t["entries"][-1]["date"], len(t["entries"])), reverse=True)
        save(THREADS, {"updated": data["updated"], "threads": kept}, pretty=True)
    print(f"テーマ {len(brief['themes'])} / ニュース {len(news)} / 識者 {len(experts)} / 対立 {len(debates)} / シナリオ {len(scenarios)}"
          f" / 動き {len(moving)} / 相場と逆向き {conflicts} / クイズ {len(quiz)} / 今日の用語 {len(terms)}" + (f" / {meta}" if meta else "") + f" → {OUT}")
    return 0


def review(graph):
    """3日ほど前の見通しが、その後どうなったかを答え合わせする（1日1回）。"""
    today = datetime.now(JST).date()
    reviews = load(REVIEWS, {"reviews": []})
    if "--force" not in ARGS and any(r["reviewed"] == today.isoformat() for r in reviews["reviews"]):
        print("答え合わせ：今日の分は済み")
        return 0
    done = {r["target"] for r in reviews["reviews"]}
    lo, hi = (today - timedelta(days=7)).isoformat(), (today - timedelta(days=3)).isoformat()
    cands = sorted((p.stem for p in ARCHIVE.glob("????-??-??.json") if lo <= p.stem <= hi and p.stem not in done), reverse=True)
    if "--force" in ARGS and not cands:
        cands = sorted((p.stem for p in ARCHIVE.glob("????-??-??.json")), reverse=True)[:1]
    if not cands:
        print("答え合わせ：3日以上前の記録がまだない")
        return 0
    target = cands[0]
    past = load(ARCHIVE / f"{target}.json", None)
    now = load(OUT, None)
    if not past or not now or not past.get("brief", {}).get("themes"):
        print("答え合わせ：材料が足りない")
        return 0
    themes = "\n".join(f"- {t['title']}：{t['what']}\n  見通し：" + " ／ ".join(t.get("outlook", [])) + f"\n  注目：{t.get('watch', '')}"
                       for t in past["brief"]["themes"])
    scen = "\n".join(f"- {s['event']}（{s.get('date', '')}）：" + " ／ ".join(f"{c['label']}→{c['text']}" for c in s["cases"])
                     for s in past.get("scenarios", [])) or "（なし）"
    mk = []
    for key, m in now.get("markets", {}).items():
        a, b = value_on(m.get("series"), target), (m.get("series") or [None])[-1]
        if a and b:
            mk.append(f"{m['name']}：{a['d']} {a['v']}{m['unit']} → {b['d']} {b['v']}{m['unit']}")
    news = "\n".join(f"- {n['source']} {short_time(n['time'])}｜{n['title']}" for n in now.get("news", [])[:45])
    prompt = f"""{target} に書いた「今後こうなるかも」が、今日（{today}）までにどうなったかを答え合わせしてください。

## {target} のテーマと見通し
{themes}

## {target} に書いた予定のシナリオ
{scen}

## 相場の数字（{target} → 今日）
{chr(10).join(mk) or '（なし）'}

## 今日の動き
一言：{now['brief'].get('headline', '')}
テーマ：{' ／ '.join(t['title'] + '：' + t['what'] for t in now['brief'].get('themes', []))}

## 今日のニュース
{news}

## 書き方
- 見通し1つずつに verdict を付ける。材料から判断できないものは「まだわからない」にする（無理に当たり外れを決めない）。
- actual は材料にある事実だけで書く。lesson は「なぜそうなったか」「どのつながりが効いたか」を学びとして書く。"""
    try:
        ai, meta = run_claude(prompt, review_schema(), "review")
    except Exception as e:  # noqa: BLE001
        print("答え合わせに失敗:", str(e)[:300], file=sys.stderr)
        return 2
    items = [i for i in ai.get("items", []) if i.get("verdict")]
    entry = {"reviewed": today.isoformat(), "target": target, "summary": ai.get("summary", ""), "items": items, "ai": meta}
    reviews["reviews"] = [entry] + [r for r in reviews["reviews"] if r["target"] != target][:59]
    save(REVIEWS, reviews, pretty=True)
    print(f"答え合わせ：{target} の見通し {len(items)} 件 → {REVIEWS}")
    return 0


def weekly(graph):
    """週末に、その週（月〜日）の流れを1本にまとめる。"""
    now = datetime.now(JST)
    today = now.date()
    if "--force" not in ARGS and today.weekday() < 5:
        print("週のまとめ：土日だけ作る")
        return 0
    y, w, _ = today.isocalendar()
    wid = f"{y}-W{w:02d}"
    path = WEEKLY / f"{wid}.json"
    if path.exists() and "--force" not in ARGS:
        print(f"週のまとめ：{wid} は済み")
        return 0
    monday = today - timedelta(days=today.weekday())
    days = [d for d in sorted(p.stem for p in ARCHIVE.glob("????-??-??.json")) if monday.isoformat() <= d <= today.isoformat()]
    if len(days) < 2 and "--force" not in ARGS:
        print("週のまとめ：今週の記録が2日分ない")
        return 0
    node_ids = [n["id"] for n in graph["nodes"]]
    parts = []
    for d in days:
        a = load(ARCHIVE / f"{d}.json", {})
        b = a.get("brief", {})
        parts.append(f"### {d}\n一言：{b.get('headline', '')}\n" + "\n".join(f"- {t['title']}：{t['what']}" for t in b.get("themes", [])))
    latest = load(OUT, {})
    mk = []
    for m in latest.get("markets", {}).values():
        a, b = value_on(m.get("series"), (monday - timedelta(days=1)).isoformat()), (m.get("series") or [None])[-1]
        if a and b:
            mk.append(f"{m['name']}：{a['d']} {a['v']}{m['unit']} → {b['d']} {b['v']}{m['unit']}")
    rv = "\n".join(f"- {r['target']}の見通し：{r['summary']}" for r in load(REVIEWS, {"reviews": []})["reviews"] if r["reviewed"] >= monday.isoformat())
    nxt = "\n".join(f"{e['date']}｜{e['name']}" for e in latest.get("calendar", []) if e["date"] <= (today + timedelta(days=9)).isoformat())
    nodes = "\n".join(f"{n['id']}｜{n['name']}｜上がる＝{n['up']}／下がる＝{n['down']}" for n in graph["nodes"])
    prompt = f"""{monday} から {today} までの1週間の経済の動きを、週末に読み返す1本のまとめにしてください。

## 毎日の記録
{chr(10).join(parts)}

## 相場の数字（先週末 → 今）
{chr(10).join(mk) or '（なし）'}

## 今週の答え合わせ
{rv or '（なし）'}

## 来週の予定（公式の日程）
{nxt or '（なし）'}

## つながり図の項目（id｜名前｜上がる／下がるの意味）
{nodes}

## 書き方
- 毎日の記録にある事実だけを使う。見通しは「〜かもしれない」で。
- moves は今週いちばん大きかった動きを2〜5つ、chain は原因から影響へ。
- lessons は「今週の動きでわかった経済のつながり」を、あとで読んでも学べる形で。"""
    try:
        ai, meta = run_claude(prompt, weekly_schema(node_ids), "weekly")
    except Exception as e:  # noqa: BLE001
        print("週のまとめに失敗:", str(e)[:300], file=sys.stderr)
        return 2
    for mv in ai.get("moves", []):
        mv["chain"] = [t for t in mv.get("chain", []) if t.get("node") in node_ids]
    entry = {"id": wid, "from": monday.isoformat(), "to": today.isoformat(), "made": now.isoformat(timespec="seconds"),
             "days": days, "ai": meta, **ai}
    save(path, entry, pretty=True)
    idx = load(WEEKLY / "index.json", {"weeks": []})
    idx["weeks"] = [{"id": wid, "title": ai.get("title", ""), "from": entry["from"], "to": entry["to"]}] + \
        [x for x in idx["weeks"] if x["id"] != wid]
    save(WEEKLY / "index.json", idx, pretty=True)
    print(f"週のまとめ：{wid} → {path}")
    return 0


def main():
    graph = json.loads((ROOT / "data" / "graph.json").read_text(encoding="utf-8"))
    if "--dry-run" in ARGS:
        # 試し書きの前に、いまのデータを写しておく（本物の data/ は書き換えない。試し書き同士は残す）
        shutil.copytree(ROOT / "data", DATA, dirs_exist_ok=True)
    if "--review" in ARGS:
        return review(graph)
    if "--weekly" in ARGS:
        return weekly(graph)
    cfg = json.loads((ROOT / "tools" / "sources.json").read_text(encoding="utf-8"))
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    return daily(graph, cfg, raw)


if __name__ == "__main__":
    sys.exit(main())
