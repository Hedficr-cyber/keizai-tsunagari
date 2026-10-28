"""集めたニュースを Claude で読み解き、アプリが読む data/latest.json を作る。

使い方: /opt/homebrew/bin/python3 -X utf8 tools/analyze.py [--no-ai]
- Claude Code（デスクトップアプリに入っている claude コマンド）を裏で1回だけ呼ぶ。
- 呼べないときは何も書き換えない（前の版が残る）。--no-ai のときは、キーワードでつながり図の項目を付けるだけにする。
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "_work" / "raw" / "collected.json"
OUT = ROOT / "data" / "latest.json"
ARCHIVE = ROOT / "data" / "archive"
JST = timezone(timedelta(hours=9))
MODEL = os.environ.get("KEIZAI_MODEL", "sonnet")
MAX_NEWS = 140
MAX_EXPERTS = 45

SYSTEM = """あなたは経済・金融ニュースの解説者です。経済を学び始めた大学生に向けて、ニュースどうしのつながりと、この先の影響をやさしく説明します。
守ること:
- 見出しと要約に書かれていない事実を作らない。数字は与えられたものだけを使う。
- 「起きたこと」と「この先の見通し」をはっきり分け、見通しは「〜かもしれない」「〜の可能性がある」と書く。
- 特定の銘柄の売買をすすめない。
- 識者の見方は、その人自身の発言・寄稿として読み取れるものだけを要約する。名前が出てくるだけの記事や、別人の記事は relevant を false にする。
- 日本語で、短く、むずかしい言葉にはかんたんな言い換えを添える。"""

DIR = {"type": "string", "enum": ["up", "down"]}


def tag_schema(nodes):
    return {"type": "object", "additionalProperties": False, "required": ["node", "dir"],
            "properties": {"node": {"type": "string", "enum": nodes}, "dir": DIR}}


def schema(nodes):
    tag = tag_schema(nodes)
    return {
        "type": "object", "additionalProperties": False,
        "required": ["headline", "themes", "news", "experts", "moving", "quiz"],
        "properties": {
            "headline": {"type": "string", "description": "今日の世の中の動きを一言で（40字以内）"},
            "themes": {"type": "array", "minItems": 3, "maxItems": 5, "items": {
                "type": "object", "additionalProperties": False,
                "required": ["title", "what", "chain", "chain_text", "outlook", "watch", "news", "experts"],
                "properties": {
                    "title": {"type": "string", "description": "テーマ名（20字以内）"},
                    "what": {"type": "string", "description": "何が起きたか（事実だけ・120字以内）"},
                    "chain": {"type": "array", "minItems": 2, "maxItems": 6, "items": tag,
                              "description": "原因から影響へ、つながり図の項目を順に並べる"},
                    "chain_text": {"type": "string", "description": "そのつながりの説明（150字以内）"},
                    "outlook": {"type": "array", "minItems": 2, "maxItems": 3, "items": {"type": "string"},
                                "description": "今後こうなるかもしれないこと（各70字以内）"},
                    "watch": {"type": "string", "description": "次に注目する予定・指標（60字以内）"},
                    "news": {"type": "array", "items": {"type": "string"}, "description": "関係するニュースのID（n12 など）"},
                    "experts": {"type": "array", "items": {"type": "string"}, "description": "関係する識者の発信のID（e3 など）"},
                }}},
            "news": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "tags", "plain", "next", "level"],
                "properties": {
                    "id": {"type": "string"},
                    "tags": {"type": "array", "maxItems": 3, "items": tag},
                    "plain": {"type": "string", "description": "やさしい要点（60字以内）"},
                    "next": {"type": "string", "description": "この先どうつながるか（70字以内）"},
                    "level": {"type": "integer", "minimum": 1, "maximum": 3, "description": "重要度 3=大きい"},
                }}},
            "experts": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "relevant", "view", "stance", "tags"],
                "properties": {
                    "id": {"type": "string"},
                    "relevant": {"type": "boolean"},
                    "view": {"type": "string", "description": "この人の見方（90字以内）"},
                    "stance": {"type": "string", "enum": ["強気", "慎重", "中立"]},
                    "tags": {"type": "array", "maxItems": 3, "items": tag},
                }}},
            "moving": {"type": "array", "minItems": 3, "maxItems": 10, "items": {
                "type": "object", "additionalProperties": False, "required": ["node", "dir", "why"],
                "properties": {"node": {"type": "string", "enum": nodes}, "dir": DIR,
                               "why": {"type": "string", "description": "いまそう動いている理由（50字以内）"}}}},
            "quiz": {"type": "array", "minItems": 3, "maxItems": 3, "items": {
                "type": "object", "additionalProperties": False, "required": ["q", "choices", "answer", "explain"],
                "properties": {"q": {"type": "string"}, "choices": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"type": "string"}},
                               "answer": {"type": "integer", "minimum": 0, "maximum": 2}, "explain": {"type": "string"}}}},
        },
    }


def short_time(iso):
    if not iso:
        return ""
    return datetime.fromisoformat(iso).astimezone(JST).strftime("%m/%d %H:%M")


def build_prompt(graph, raw, experts_cfg):
    nodes = "\n".join(f"{n['id']}｜{n['name']}｜上がる＝{n['up']}／下がる＝{n['down']}" for n in graph["nodes"])
    edges = " ".join(f"{e['from']}>{e['to']}({'+' if e['sign'] > 0 else '-'})" for e in graph["edges"])
    news = "\n".join(
        f"[n{i}] {x['source']} {short_time(x['time'])}｜{x['title']}" + (f"｜{x['summary'][:110]}" if x["summary"] else "")
        for i, x in enumerate(raw["news"][:MAX_NEWS]))
    who = {e["id"]: e for e in experts_cfg}
    exps = "\n".join(
        f"[e{i}] {who[x['expert']]['name']}（{who[x['expert']]['role']}）｜{x['kind']}｜{x['source']} {short_time(x['time'])}｜{x['title']}"
        + (f"｜{x['summary'][:260]}" if x["summary"] else "")
        for i, x in enumerate(raw["experts"][:MAX_EXPERTS]))
    mk = []
    for m in raw.get("markets", {}).values():
        ser = m.get("series") or []
        if len(ser) < 2:
            continue
        last = ser[-1]
        week = ser[-6] if len(ser) >= 6 else ser[0]
        month = ser[-22] if len(ser) >= 22 else ser[0]
        mk.append(f"{m['name']}：{last['v']}{m['unit']}（{last['d']}）／1週間前 {week['v']}／1か月前 {month['v']}")
    markets = "\n".join(mk) or "（なし）"
    return f"""今日は {datetime.now(JST).strftime('%Y年%m月%d日 %H時')}。下の材料から、今日の経済の動きを読み解いてください。

## 相場の数字（公的な実データ。上がった・下がったはこの数字を優先する）
{markets}

## つながり図の項目（id｜名前｜上がる／下がるの意味）
{nodes}

## つながり図にある基本の関係（原因>結果、+は同じ向き、-は逆向き）
{edges}

## ニュース（ID｜媒体 日時｜見出し｜要約）
{news}

## 識者の発信（ID｜名前（肩書き）｜種類｜媒体 日時｜題名｜要約）
{exps}

## 作るもの
- headline: 今日の世の中の動きを一言で。
- themes: 今日いちばん大事な動きを3〜5個。chain は原因から影響へ、項目を順に並べる（なるべく上の基本の関係に沿う。沿わないつながりは chain_text で理由を書く）。chain の向きは今日実際に起きている向き（相場の数字とニュース）に合わせ、まだ起きていない仮の向きを使うときは chain_text に「もし〜なら」と書く。outlook は「〜かもしれない」で。
- news: 経済・金融・ビジネスに関係するものだけを30〜50本選び、重要な順に並べる。スポーツ・事件・芸能などは入れない。同じ出来事の重複は1本にまとめる。tags はそのニュースが動かす項目と向き（関係が薄ければ空でよい）。
- experts: すべての識者の発信について、その人の見方として読めるかを判断する（relevant）。
- moving: 今日のニュースから見て、いま動いている項目と向き。
- quiz: 今日のニュースを使った3択クイズを3問。つながり（AならB）を考えさせる問題にする。"""


def find_claude():
    p = shutil.which("claude")
    if p:
        return p
    found = sorted(glob.glob(os.path.expanduser(
        "~/Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude")),
        key=lambda s: [int(x) if x.isdigit() else x for x in re.split(r"[./]", s.split("claude-code/")[1].split("/")[0])])
    return found[-1] if found else None


def run_claude(prompt, nodes):
    exe = find_claude()
    if not exe:
        raise RuntimeError("claude コマンドが見つからない")
    cmd = [exe, "-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
           "--output-format", "json", "--model", MODEL, "--system-prompt", SYSTEM,
           "--json-schema", json.dumps(schema(nodes), ensure_ascii=False)]
    p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=900, cwd=str(ROOT / "_work"))
    if p.returncode != 0:
        raise RuntimeError(f"claude が失敗: {p.stderr[-400:] or p.stdout[-400:]}")
    out = json.loads(p.stdout)
    data = out.get("structured_output")
    if data is None:
        text = out.get("result", "")
        m = re.search(r"\{.*\}", text, re.S)
        data = json.loads(m.group(0)) if m else None
    if not isinstance(data, dict):
        raise RuntimeError("claude の結果を読めない")
    return data, {"model": MODEL, "cost_usd": out.get("total_cost_usd"), "ms": out.get("duration_ms")}


def keyword_tags(title, graph):
    """AI を使わないときの簡易な項目付け（向きは付けない）。"""
    tags = []
    for n in graph["nodes"]:
        if any(k in title for k in n["kw"]):
            tags.append({"node": n["id"], "dir": None})
    return tags[:3]


def main():
    no_ai = "--no-ai" in sys.argv
    graph = json.loads((ROOT / "data" / "graph.json").read_text(encoding="utf-8"))
    cfg = json.loads((ROOT / "tools" / "sources.json").read_text(encoding="utf-8"))
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    node_ids = [n["id"] for n in graph["nodes"]]
    edge_set = {(e["from"], e["to"]) for e in graph["edges"]}
    experts_cfg = {e["id"]: e for e in cfg["experts"]}

    ai, meta, error = None, None, None  # error は互換のため残す
    if not no_ai:
        try:
            ai, meta = run_claude(build_prompt(graph, raw, cfg["experts"]), node_ids)
        except Exception as e:  # noqa: BLE001
            # 失敗した回は前の版を残す（キーワードだけの薄い版で上書きしない）
            print("AI の分析に失敗したので、前の版を残す:", str(e)[:300], file=sys.stderr)
            return 2

    def ok_tags(tags):
        return [t for t in tags or [] if t.get("node") in node_ids]

    def news_ref(ref):
        m = re.match(r"^n(\d+)$", ref or "")
        return int(m.group(1)) if m and int(m.group(1)) < len(raw["news"]) else None

    def expert_ref(ref):
        m = re.match(r"^e(\d+)$", ref or "")
        return int(m.group(1)) if m and int(m.group(1)) < len(raw["experts"]) else None

    def news_item(i, extra=None):
        x = raw["news"][i]
        item = {"id": f"n{i}", "title": x["title"], "link": x["link"], "source": x["source"], "time": x["time"]}
        item.update(extra or {})
        return item

    def expert_item(i, extra=None):
        x = raw["experts"][i]
        ex = experts_cfg[x["expert"]]
        item = {"id": f"e{i}", "expert": x["expert"], "name": ex["name"], "role": ex["role"], "kind": x["kind"],
                "title": x["title"], "link": x["link"], "source": x["source"], "time": x["time"]}
        item.update(extra or {})
        return item

    if ai:
        news, used = [], set()
        for n in ai.get("news", []):
            i = news_ref(n.get("id"))
            if i is None or i in used:
                continue
            used.add(i)
            news.append(news_item(i, {"tags": ok_tags(n.get("tags")), "plain": n.get("plain", ""),
                                      "next": n.get("next", ""), "level": n.get("level", 1)}))
        experts = []
        for e in ai.get("experts", []):
            i = expert_ref(e.get("id"))
            if i is None or not e.get("relevant"):
                continue
            experts.append(expert_item(i, {"view": e.get("view", ""), "stance": e.get("stance", "中立"),
                                           "tags": ok_tags(e.get("tags"))}))
        themes = []
        for t in ai.get("themes", []):
            chain = ok_tags(t.get("chain"))
            for a, b in zip(chain, chain[1:]):
                b["known"] = (a["node"], b["node"]) in edge_set
            refs = [news_ref(r) for r in t.get("news", [])]
            for i in refs:
                if i is not None and i not in used:
                    used.add(i)
                    news.append(news_item(i, {"tags": [], "plain": "", "next": "", "level": 1}))
            themes.append({
                "title": t.get("title", ""), "what": t.get("what", ""), "chain": chain,
                "chain_text": t.get("chain_text", ""), "outlook": t.get("outlook", []), "watch": t.get("watch", ""),
                "news": [f"n{i}" for i in refs if i is not None],
                "experts": [f"e{i}" for i in (expert_ref(r) for r in t.get("experts", [])) if i is not None
                            and any(x["id"] == f"e{i}" for x in experts)],
            })
        brief = {"headline": ai.get("headline", ""), "themes": themes}
        moving = [m for m in ai.get("moving", []) if m.get("node") in node_ids]
        quiz = [q for q in ai.get("quiz", []) if len(q.get("choices", [])) == 3]
    else:
        news = [news_item(i, {"tags": keyword_tags(x["title"], graph), "plain": "", "next": "", "level": 1})
                for i, x in enumerate(raw["news"][:80])]
        experts = [expert_item(i, {"view": "", "stance": "中立", "tags": keyword_tags(x["title"], graph)})
                   for i, x in enumerate(raw["experts"]) if x["kind"] != "記事"]
        brief, moving, quiz = {"headline": "", "themes": []}, [], []

    now = datetime.now(JST)
    data = {
        "updated": now.isoformat(timespec="seconds"),
        "collected": raw["collected"],
        "ai": meta,
        "ai_error": error,
        "brief": brief,
        "moving": moving,
        "news": news,
        "experts": experts,
        "markets": raw["markets"],
        "quiz": quiz,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    (ARCHIVE / f"{now:%Y-%m-%d}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    days = sorted(p.stem for p in ARCHIVE.glob("????-??-??.json"))
    (ARCHIVE / "index.json").write_text(json.dumps({"days": days}, ensure_ascii=False), encoding="utf-8")
    print(f"テーマ {len(brief['themes'])} / ニュース {len(news)} / 識者 {len(experts)} / 動き {len(moving)} / クイズ {len(quiz)}"
          + (f" / {meta}" if meta else "") + f" → {OUT}")
    return 0 if (ai or no_ai) else 2


if __name__ == "__main__":
    sys.exit(main())
