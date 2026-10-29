"""ニュース詳細を、確認できる事実と一般的な解説に分けて扱う補助処理。"""
import re
import unicodedata
from decimal import Decimal

from news_integrity import clean_news_text, _text_sentences


DETAIL_FIELDS = ("plain", "context", "impact", "watch", "next")


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


def news_detail_fields(article, item, *, facts_fallback=False):
    """新しい固有主体・国や、元材料にない数字を含む文を残さない。

    事実の追加を許すための処理ではない。context/impact/watchの一般的な
    仕組みや条件付き見通しと、plainの事実を分けることは生成側にも求める。
    文の意味・数字の対象や単位を万能に検証するものではない。
    """
    if not isinstance(item, dict):
        item = {}
    evidence = " ".join(str(article.get(k) or "") for k in ("title", "summary", "description"))
    allowed_numbers = _numbers(evidence)
    out = {}
    for key in DETAIL_FIELDS:
        text = item.get(key)
        text = clean_news_text(article, text if isinstance(text, str) else "")
        out[key] = "".join(sentence for sentence in _text_sentences(text)
                           if not (_numbers(sentence) - allowed_numbers)).strip()
    # 旧データや旧キャッシュのnextも、将来のUIと同じ欄で利用できる。
    if not out["impact"]:
        out["impact"] = out["next"]
    if not out["next"]:
        out["next"] = out["impact"]
    if facts_fallback and not out["plain"]:
        out["plain"] = source_fact_text(article)
    return out
