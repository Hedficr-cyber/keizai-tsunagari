"""ニュース詳細を、確認できる事実と一般的な解説に分けて扱う補助処理。"""
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from news_integrity import clean_news_text, _text_sentences


DETAIL_FIELDS = ("plain", "context", "impact", "watch", "next")
JST = timezone(timedelta(hours=9))


def _numbers(text):
    normalized = unicodedata.normalize("NFKC", str(text or ""))
    # 桁区切りとbn/billion・億等の表記差は同じ数として扱う。
    # 通貨・対象・単位の意味までの検証ではない。
    normalized = re.sub(r"(?<=\d),(?=\d{3}(?:\D|$))", "", normalized)
    factors = {"trillion": 10**12, "billion": 10**9, "bn": 10**9,
               "million": 10**6, "mn": 10**6, "兆": 10**12, "億": 10**8, "万": 10**4}
    return {str((Decimal(number) * factors.get(unit.casefold(), 1)).normalize())
            for number, unit in re.findall(
                r"(\d+(?:\.\d+)?)(?:\s*(trillion\b|billion\b|million\b|bn\b|mn\b|兆|億|万))?",
                normalized, re.I)}


# 解説の欄（背景・影響・次に見ること）の一般的な数字（「50が分かれ目」「1回の幅」など）は残す。
# 金額・率・件数のように事実を思わせる数字だけを元材料と照らす。物価目標の2%は一般的な知識として扱う。
# 年・月・日などの期間や日付も、元材料にない予測や発表日を作らないように照らす。
_FACT_NUMBER = re.compile(r"\d+(?:\.\d+)?\s*(?:%|円|ドル|ユーロ|元|ポンド|兆|億|万|bp|ベーシス|pt|ポイント|件|人|台|社|戸|トン|バレル|倍|年|か月|ヶ月|カ月|月|週|日|時間)", re.I)
_TARGET_TWO = re.compile(r"2\s*%(?=の?(?:物価)?(?:安定)?目標)|(?<=目標の)2\s*%|(?<=目標)2\s*%")


# 「10年債」「2年物」「10年金利」の年限は、数字の事実ではなく言葉の一部として扱う。
_TENOR = re.compile(r"\d+\s*年(?=物|もの|債|国債|金利|利回り)")


def _plain_numbers(sentence):
    return _numbers(_TENOR.sub("", unicodedata.normalize("NFKC", sentence)))


def _general_sentence_ok(sentence, allowed_numbers):
    text = _TARGET_TWO.sub("", _TENOR.sub("", unicodedata.normalize("NFKC", sentence)))
    bound = " ".join(m.group(0) for m in _FACT_NUMBER.finditer(text))
    return not (_numbers(bound) - allowed_numbers)


def _date_numbers(article):
    """配信日（と、海外の市場で使う前日）の年・月・日。「5日の東京市場」のような書き方を外さない。"""
    try:
        day = datetime.fromisoformat(str(article.get("time") or "")).astimezone(JST)
    except ValueError:
        return set()
    days = {day, day - timedelta(days=1)}
    return _numbers(" ".join(f"{d.year} {d.month} {d.day}" for d in days))


def market_numbers(markets):
    """アプリに出している相場の数字（最新・1週間前・1か月前）。解説の欄で使ってよい。"""
    values = []
    for m in (markets or {}).values():
        series = m.get("series") or []
        for point in [series[-1], series[-6] if len(series) >= 6 else None, series[-22] if len(series) >= 22 else None]:
            if point:
                v = float(point["v"])
                values += [v, round(v, 2), round(v, 1), int(v)]
    return _numbers(" ".join(f"{v}" for v in values))


def source_fact_text(article):
    """生成できない記事では、配信要約の完結した短文か元見出しを残す。"""
    summary = str(article.get("summary") or "").strip()
    complete = []
    for sentence in _text_sentences(summary):
        if not re.search(r"[。！？.!?]$", sentence.strip()):
            continue
        if sum(map(len, complete)) + len(sentence) > 280:
            break
        complete.append(sentence)
    return "".join(complete).strip() or str(article.get("title") or "").strip()


def news_detail_fields(article, item, *, facts_fallback=False, markets=None):
    """新しい固有主体・国や、元材料にない数字を含む文を残さない。

    事実の追加を許すための処理ではない。context/impact/watchの一般的な
    仕組みや条件付き見通しと、plainの事実を分けることは生成側にも求める。
    文の意味・数字の対象や単位を万能に検証するものではない。
    """
    if not isinstance(item, dict):
        item = {}
    evidence = " ".join(str(article.get(k) or "") for k in ("title", "summary", "description"))
    allowed_numbers = _numbers(evidence) | _date_numbers(article)
    general_numbers = allowed_numbers | market_numbers(markets)
    out = {}
    for key in DETAIL_FIELDS:
        text = item.get(key)
        # 事実（plain）は厳しく照らす。解説の欄は、一般的な数字（「50が分かれ目」など）を書けるようにする。
        general = key != "plain"
        # 背景は日本の仕組みとして、影響・次に見ることは日本と米国への波及として書けるようにする。
        allow = () if not general else ("jp",) if key == "context" else ("jp", "us")
        text = clean_news_text(article, text if isinstance(text, str) else "", allow=allow)
        out[key] = "".join(sentence for sentence in _text_sentences(text)
                           if (_general_sentence_ok(sentence, general_numbers) if general
                               else not (_plain_numbers(sentence) - allowed_numbers))).strip()
    # 旧データや旧キャッシュのnextも、将来のUIと同じ欄で利用できる。
    if not out["impact"]:
        out["impact"] = out["next"]
    if not out["next"]:
        out["next"] = out["impact"]
    if facts_fallback and not out["plain"]:
        out["plain"] = source_fact_text(article)
    return out
