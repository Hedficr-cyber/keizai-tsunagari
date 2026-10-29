"""元の配信材料に明示された指標の動きだけ、ニュースの導線を補う。

AIの説明や予想から項目・方向を逆算しない。対応しない表現は推測せず、
既存の国・主体・意味照合を通った候補だけを利用する。
"""
import re

from news_integrity import (
    _countries, _metric_directions, _norm, _policy_change_confirmed,
    _semantic_direction, valid_news_tags,
)


_MARKETS = {
    "nikkei": r"日経平均(?:株価)?|topix|日本株|東京株|\bnikkei(?:\s+225)?\b|\bjapanese (?:stocks|shares)\b",
    "us_stocks": r"米(?:国)?(?:ハイテク)?株|nyダウ|ny株|ダウ平均|s&p\s*500|ナスダック|\bnasdaq\b|\bdow(?: jones)?\b|\bu\.?s\.? (?:tech )?(?:stocks|shares)\b",
    "jgb10": r"日本(?:の)?長期金利|日本(?:の)?10年(?:物)?(?:国債|債)(?:利回り)?|新発10年(?:物)?(?:国債|債)(?:利回り)?|\bjapanese 10[- ]year (?:bond|government bond) yields?\b",
    "ust10": r"米(?:国)?(?:の)?長期金利|米(?:国)?(?:の)?10年(?:物)?(?:国債|債)(?:利回り)?|\bu\.?s\.? 10[- ]year (?:treasury|bond) yields?\b|\b10[- ]year treasury yields?\b",
    "oil": r"原油(?:価格|相場|先物)?|wti(?:原油)?|ブレント(?:原油)?|\b(?:crude oil|oil prices?|brent|wti)\b",
    "gold": r"金(?:価格|相場|先物)|ゴールド|(?<![一-龯])金(?=は|が|[、,])|\bgold(?: prices?)?\b",
}
_UP = r"上昇|値上がり|続伸|反発|急伸|高騰|上げ(?:た|る)|\d(?:[\d,.]*)(?:円|ドル|ポイント|%)高|\b(?:rise[sn]?|rising|rose|rally|rallies|rallied|gain[sed]*|climb[sed]*|higher|surge[sd]?)\b"
_DOWN = r"下落|低下|値下がり|続落|反落|急落|下げ(?:た|る)|\d(?:[\d,.]*)(?:円|ドル|ポイント|%)安|\b(?:fall[sn]?|falling|fell|drop[sped]*|decline[sd]?|lower|slump[sed]*|tumble[sd]?)\b"
_UNCERTAIN = (
    r"予想|予測|見通し|見込み|観測|期待|可能性|懸念|なら|場合|したら|とすれば|かもしれ|"
    r"しない|せず|していない|増えず|減らず|なかった|見送|否定|歯止め|一服|だろう|"
    r"目指|見込(?:む|ん|ま)|予定|検討|計画(?:する|を|し)|"
    r"\b(?:not|never|no|may|might|could|would|should|if|expect\w*|forecast\w*|set to|likely|will)\b"
)
_OTHER_QUANTITY = (
    r"株価|株[がはをも]|株\s*\d|関連株|投資|支出|売上|利益|収益|需要|生産|発行|調達コスト|"
    r"政策金利|価格|消費者物価|消費者心理|消費者態度|\bgdp\b|"
    r"\b(?:profit|revenue|earnings|spending|investment|demand|production|issuance)\b"
)
_BANK_ACTOR = r"銀行|メガバンク|地銀|三菱ufj|三井住友|みずほ|\bbanks?\b"
_BANK_PROFIT = (
    rf"(?:{_BANK_ACTOR})"
    r"[^。！？!?;；、,]{0,24}?(?:純利益|営業利益|経常利益|利益|収益|利ざや|\bprofits?\b|\bearnings\b|\bnet income\b)"
)
_CONSUMPTION = r"個人消費|消費支出|家計消費|小売売上高|\bconsumer spending\b|\bretail sales\b"
_NON_USD_CURRENCY = (
    r"豪(?:州)?ドル|オーストラリアドル|カナダドル|ニュージーランドドル|nzドル|"
    r"ユーロ|(?:英)?ポンド|スイスフラン|人民元|韓国ウォン|ウォン|香港ドル|シンガポールドル|台湾ドル|"
    r"南ア(?:フリカ)?ランド|トルコリラ|"
    r"\b(?:australian dollar|canadian dollar|new zealand dollar|hong kong dollar|singapore dollar|"
    r"euro|pound|sterling|swiss franc|yuan|won|lira|rand|aud|cad|nzd|eur|gbp|chf|cny|krw)\b"
)
_FX_PAIR = (
    rf"(?:{_NON_USD_CURRENCY}|米(?:国)?ドル|ドル)\s*(?:[/／-]\s*)?円(?:相場)?"
    r"|\b(?:usd|aud|cad|nzd|eur|gbp|chf|cny|krw)[/-]?jpy\b"
    rf"|(?:{_NON_USD_CURRENCY}|\bdollar\b)[ /-]+yen\b"
)


def _parts(article):
    return [_norm(article.get(k)) for k in ("title", "summary", "description") if article.get(k)]


def _market_direction(article, anchor, *, yen=False, fx=False):
    directions = set()
    for text in _parts(article):
        text = re.sub(r"(?<=\d),(?=\d{3}(?:\D|$))", "", text)
        # 「日経平均、続伸」の区切りだけは同じ指標の述部として読む。
        text = re.sub(f"({anchor})[、,]\\s*", r"\1 ", text)
        for clause in re.split(r"[。！？!?;；\n、,]|一方|対して|しかし|\bbut\b", text):
            for match in re.finditer(anchor, clause):
                if re.search(r"なら|場合|したら|とすれば|\bif\b", clause[max(0, match.start() - 24):match.start()]):
                    continue
                tail = clause[match.end():match.end() + 48]
                if fx:
                    before = clause[:match.start()]
                    through_anchor = clause[:match.end()]
                    # 「豪ドル円」の中の「ドル円」や「ユーロ円」の円を借りない。
                    if re.search(rf"(?:{_NON_USD_CURRENCY})\s*(?:[/／-]\s*)?(?:円(?:相場)?|yen)\s*$", through_anchor):
                        continue
                    if yen and re.search(r"(?:ドル|ユーロ|ポンド|フラン|元|ウォン|リラ|ランド)\s*$", before):
                        continue
                    next_pair = re.search(_FX_PAIR, tail)
                    if next_pair:
                        tail = tail[:next_pair.start()]
                    # 対象が円でも相手がユーロ等なら、ドル円の動きではない。
                    if yen and (re.search(rf"(?:{_NON_USD_CURRENCY})(?:に対する|に対して|に対し|の|で|との|と比べて)?\s*$", before)
                                or re.search(_NON_USD_CURRENCY, tail)):
                        continue
                boundary = re.search(_OTHER_QUANTITY, tail)
                if boundary:
                    tail = tail[:boundary.start()]
                # 末尾の「下落へ」など、まだ起きていない方向を補わない。
                found = set()
                for direction, pattern in (("up", _UP), ("down", _DOWN)):
                    for change in re.finditer(pattern, tail):
                        context = tail[max(0, change.start() - 12):change.end() + 16]
                        if not re.search(_UNCERTAIN, context) and not re.search(r"(?:上昇|下落|値上がり|値下がり)へ", context):
                            found.add(direction)
                if yen:
                    found = {"down" if d == "up" else "up" for d in found}
                directions.update(found)
    return next(iter(directions)) if len(directions) == 1 else None


def _actual_direction(article, node_id):
    if node_id in _MARKETS:
        return _market_direction(article, _MARKETS[node_id])
    if node_id == "usdjpy":
        # ドル円という数字の上下と、円そのものの強弱を逆転させる。
        numeric = _market_direction(article, r"ドル円(?:相場)?|\busd/jpy\b|\bdollar-yen\b", fx=True)
        yen = _market_direction(article, r"(?<!ドル)円相場|(?<![\d.])円(?=は|が)|\byen\b", yen=True, fx=True)
        found = {d for d in (numeric, yen) if d}
        return next(iter(found)) if len(found) == 1 else None
    if node_id in ("ai_semis", "import_prices", "china"):
        # 既存の否定/予想ガードに加え、計画や目標を実施済み投資等にしない。
        evidence = {k: v for k, v in article.items() if k not in ("title", "summary", "description") or not re.search(r"目指|見込(?:む|ん|ま)|予定|検討|計画(?:する|を|し)", _norm(v))}
        return _semantic_direction(evidence, node_id)
    if node_id in ("boj", "fed"):
        directions = {d for d in ("up", "down") if _policy_change_confirmed(article, node_id, d)}
        return next(iter(directions)) if len(directions) == 1 else None
    if node_id in ("banks", "consumption"):
        directions = set()
        for text in _parts(article):
            if re.search(r"目指|見込(?:む|ん|ま)|予定|検討|計画(?:する|を|し)", text):
                continue
            countries = _countries(text)
            if countries - {"jp"} and "jp" not in countries:
                continue
            if node_id == "consumption" and re.search(r"[a-z]", text) and "jp" not in countries:
                continue
            anchor = _BANK_PROFIT if node_id == "banks" else _CONSUMPTION
            if node_id == "banks":
                text = re.sub(rf"({_BANK_ACTOR})[、,]\s*(?=[^。！？!?;；、,]{{0,16}}(?:利益|収益|利ざや|profit|earnings|net income))", r"\1 ", text)
            text = re.sub(f"({anchor})[、,]\\s*", r"\1 ", text)
            directions.update(_metric_directions(text, anchor))
        return next(iter(directions)) if len(directions) == 1 else None
    return None


_EXPLICIT = tuple(_MARKETS) + ("usdjpy", "ai_semis", "import_prices", "china", "boj", "fed", "banks", "consumption")


def infer_news_tags(article, graph):
    """元材料に対象と実際の方向が一つだけ明示される項目を返す。"""
    by_id = {n["id"]: n for n in graph.get("nodes", [])}
    candidates = []
    for node_id in _EXPLICIT:
        if node_id in by_id and (direction := _actual_direction(article, node_id)):
            candidates.append({"node": node_id, "dir": direction})
    # 単独の「金は上昇」も金利や賃金と区別できる。既存の語句照合用に、
    # 推測した説明ではなく元の金という指標名だけを同義表記へそろえる。
    evidence = dict(article)
    if any(t["node"] == "gold" for t in candidates):
        for key in ("title", "summary", "description"):
            if evidence.get(key):
                evidence[key] = re.sub(r"(?<![一-龯])金(?=は|が|[、,])", "金価格", evidence[key])
    return valid_news_tags(evidence, candidates, graph)


def news_connection_tags(article, tags, graph):
    """既存候補を検証し、明示事実から不足する導線を補う（入力は不変）。"""
    existing = valid_news_tags(article, tags, graph)
    inferred = infer_news_tags(article, graph)
    explicit = {tag["node"]: tag for tag in inferred}
    out, seen = [], set()
    for tag in existing:
        node_id = tag["node"]
        # 銀行統合を増益、消費者心理を実際の個人消費の減少としない。
        if node_id in (*_MARKETS, "usdjpy", "banks", "consumption") and node_id not in explicit:
            continue
        tag = explicit.get(node_id, tag)
        if node_id not in seen:
            out.append(dict(tag))
            seen.add(node_id)
    for tag in inferred:
        if tag["node"] not in seen:
            out.append(dict(tag))
            seen.add(tag["node"])
    return out
