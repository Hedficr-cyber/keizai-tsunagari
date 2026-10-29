"""ニュースの統合と項目付けを、元の見出し・配信要約で保守的に確認する。

同じ話題であることと、同じ出来事であることを分けるための補助判定。
記事本文やAIを使う意味理解の代わりではない。判断材料が足りなければ
統合せず、項目付けも見出し・配信要約に根拠が見つかるものだけを残す。
"""

import re
import unicodedata
from datetime import datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def _norm(text):
    text = unicodedata.normalize("NFKC", str(text or "")).casefold()
    return re.sub(r"\s+", " ", text).strip()


def _article_text(article):
    # AIが付けたplain/next/title_jaを、AI自身の項目付けの根拠にはしない。
    return _norm(" ".join(str(article.get(k) or "") for k in ("title", "summary", "description")))


def _has(text, words):
    for word in words:
        word = _norm(word)
        if re.fullmatch(r"[a-z0-9 &.+-]+", word):
            if re.search(r"(?<![a-z0-9])" + re.escape(word) + r"(?![a-z0-9])", text):
                return True
        elif word and word in text:
            return True
    return False


_COUNTRIES = {
    "jp": r"日本|日銀|東証|日経平均|topix|japan(?:ese)?|\bboj\b",
    "us": r"米(?:国|株|経済|景気|雇用|消費者|金利|長期|連邦|小売|物価|cpi|pce|利上げ|利下げ)|アメリカ|frb|fomc|\bfed\b|federal reserve|u\.?s\.?\b|united states|nyダウ|ny株|s&p\s*500|ナスダック|nasdaq|wall street",
    "au": r"豪州|豪(?:中銀|経済|物価)|オーストラリア|australia(?:n)?|\brba\b",
    "nz": r"ニュージーランド|(?<![a-z])nz(?![a-z])|new zealand|\brbnz\b",
    "tw": r"台湾|taiwan(?:ese)?",
    "th": r"タイ(?:中銀|中央銀行|経済|政府|銀行|物価|の)|thailand|\bthai\b",
    "cn": r"中国|人民銀|人民元|china|chinese|\bpboc\b",
    "uk": r"英国|英(?:中銀|経済|金利|消費者|物価)|イングランド銀行|united kingdom|britain|british|bank of england|\bboe\b",
    "eu": r"ユーロ圏|欧州中央銀行|\becb\b|eurozone|euro area",
    "kr": r"韓国|korea(?:n)?",
    "ca": r"カナダ|canada|canadian",
}


def _countries(text):
    return {country for country, pattern in _COUNTRIES.items() if re.search(pattern, text)}


# 同じ企業を指す表記だけをまとめる。分からない企業は先頭の主体を補助に使う。
# これは全企業の名寄せ辞書ではなく、判別できない場合は統合しない。
_COMPANIES = {
    "mufg_securities": ("三菱ufj証券", "mufg securities"),
    "nomura": ("野村hd", "野村ホールディングス", "野村証券", "nomura"),
    "bnp": ("bnpパリバ", "bnp paribas"),
    "deutsche": ("ドイツ銀", "ドイツ銀行", "deutsche bank"),
    "standard_chartered": ("スタンダードチャータード", "standard chartered"),
    "advantest": ("アドバンテスト", "アドテスト", "advantest"),
    "hitachi": ("日立", "hitachi"),
    "sony": ("ソニーグループ", "ソニーg", "ソニー", "sony"),
    "toyota": ("トヨタ", "toyota"),
    "honda": ("ホンダ", "本田技研", "honda"),
    "jal": ("日本航空", "jal", "日航"),
    "ana": ("全日本空輸", "全日空", "anaホールディングス", "ana"),
    "gmo": ("gmo",),
    "nidec": ("ニデック", "nidec"),
    "sk_hynix": ("skハイニックス", "sk hynix"),
    "kioxia": ("キオクシア", "kioxia"),
    "openai": ("openai", "オープンai"),
    "anthropic": ("アンソロピック", "anthropic"),
    "nvidia": ("エヌビディア", "nvidia"),
    "yucho": ("ゆうちょ銀行", "japan post bank"),
    "matsui": ("松井証券", "matsui securities"),
}


def _company_keys(title):
    return {key for key, aliases in _COMPANIES.items() if _has(title, aliases)}


def _lead_subject(title):
    title = re.sub(r"^(?:[【(][^】)]{0,24}[】)]\s*)+", "", title)
    title = re.sub(r"^決算\s*[:：]\s*", "", title)
    match = re.match(r"^(.{2,30}?)(?:[、,]|の(?=\d|通期|今期|来期|中間|第|純利|営業|最終|業績|売上)|[はが](?=\d|増益|減益|上方|下方|最高|赤字|黒字))", title)
    if not match:
        return ""
    subject = match.group(1).strip()
    if re.search(r"各社|企業|銀行株|金融機関|証券会社|決算|ニュース|まとめ", subject):
        return ""
    return re.sub(r"(?:ホールディングス|holdings|hd|株式会社|社)$", "", subject).strip()


def _event_kind(title):
    if re.search(r"監査|有報|有価証券報告書|不正会計|内部管理体制確認書|上場維持|審査プロセス", title):
        return "audit"
    if re.search(r"新工場|工場(?:建設|検討|投資|新設)|工場を|工場検討|factory|new plant", title):
        return "factory"
    if re.search(r"出資|買収|資本提携|\btob\b|acquisition|acquire|\bstake\b", title):
        return "ownership"
    # 市況と、その中で触れられた企業の決算は別の出来事。
    if re.search(r"株価|株(?:が|は|一時)?\s*\d+[%％]|日経平均|東証(?:前引け|後場|大引け|市場)|ny株|s&p\s*500|nasdaq|stock(?:s| market)?|shares?\s+(?:rise|fall|jump|gain|drop)", title):
        return "stocks"
    if re.search(r"決算|純利|純益|営業益|利益|売上高|増益|減益|業績|最終益|最高益|earnings|\bprofit\b|financial results", title):
        return "earnings"
    if re.search(r"自社株買い|株主還元|配当|buyback|share repurchase|dividend", title):
        return "capital_return"
    for name, pattern in (
        ("cpi", r"消費者物価|\bcpi\b"),
        ("ppi", r"企業物価|生産者物価|\bppi\b"),
        ("pce", r"\bpce\b|個人消費支出"),
        ("inflation", r"インフレ|inflation"),
        ("gdp", r"\bgdp\b|国内総生産"),
        ("employment", r"雇用統計|失業率|就業者|nonfarm|payroll|unemployment"),
        ("retail", r"小売売上|retail sales"),
        ("policy", r"政策金利|金利.*(?:維持|据え置|引き上げ|引き下げ)|利上げ|利下げ|rate (?:decision|cut|hike)|interest rates?"),
        ("fx", r"円相場|ドル[・/]?円|為替相場|円安|円高|forex|yen"),
        ("cyber", r"不正アクセス|情報漏|情報流出|サイバー攻撃|ハッカー|攻撃者|cyberattack|data breach"),
        ("tax", r"消費税|減税|補助金?|tax cut|subsid"),
        ("oil", r"原油|石油|crude|oil price"),
    ):
        if re.search(pattern, title):
            return name
    return ""


def _periods(title):
    periods = {}
    match = re.search(r"(\d{1,2})\s*[-ー―−–〜~]\s*(\d{1,2})月", title)
    if match:
        periods["months"] = tuple(map(int, match.groups()))
    match = re.search(r"第\s*([1-4])\s*四半期|\bq([1-4])\b", title)
    if match:
        periods["quarter"] = int(match.group(1) or match.group(2))
    match = re.search(r"(?<!\d)(20\d{2})年", title)
    if match:
        periods["year"] = int(match.group(1))
    match = re.search(r"(?<![\dー―−–〜~])(\d{1,2})月(?!期)", title)
    if match and "months" not in periods:
        periods["month"] = int(match.group(1))
    return periods


def _similarity(a, b):
    def pairs(text):
        text = re.sub(r"[^\w]", "", text)
        return {text[i:i + 2] for i in range(len(text) - 1)}
    aa, bb = pairs(a), pairs(b)
    return len(aa & bb) / len(aa | bb) if aa and bb else 0


def _time(article):
    try:
        return datetime.fromisoformat(str(article.get("time") or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def _same_day(a, b):
    da, db = _time(a), _time(b)
    return bool(da and db and da.date() == db.date())


def _forecast(title):
    # 「市場予想を上回った」は公表済みの実績との比較で、会社の業績予想ではない。
    title = re.sub(r"(?:市場|アナリスト)(?:の)?予想|予想(?:を)?(?:上回|下回|超え)", "", title)
    return bool(re.search(r"予想|見通し|修正|上振れ|下振れ|見込み|forecast|outlook", title))


def _audit_failure(text):
    text = re.sub(r"[\s「」『』“”\"]", "", text)
    return bool(re.search(r"監査(?:法人)?(?:の)?(?:意見|お墨付き)|適正意見", text) and re.search(r"間に合わ|得られず|取得できず|得られていない", text))


def _gasoline_record(text):
    if not re.search(r"ガソリン.{0,6}補助|gasoline subsid", text):
        return "", set()
    phase = "record" if re.search(r"過去最高|最高額|最大", text) else "cut" if re.search(r"縮小|減額|削減", text) else ""
    amounts = set(re.findall(r"(?<!\d)(\d+(?:\.\d+)?)円", text))
    return phase, amounts


def _stock_fact(text):
    indices = {name for name, pattern in (("nikkei", r"日経平均|nikkei"), ("topix", r"topix"), ("sp500", r"s&p\s*500"), ("dow", r"nyダウ|ダウ平均|dow"), ("nasdaq", r"ナスダック|nasdaq")) if re.search(pattern, text)}
    changes = {(amount.replace(",", ""), direction) for amount, direction in re.findall(r"(\d[\d,]*(?:\.\d+)?)円(高|安)", text)}
    return indices, changes


def _same_link(a, b):
    def canonical(link):
        try:
            parts = urlsplit(str(link or ""))
            if parts.scheme not in ("http", "https") or not parts.netloc or not parts.path.strip("/"):
                return ""
            query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                     if not k.casefold().startswith("utm_") and k.casefold() not in ("ref", "rss", "at_medium", "at_campaign", "oc")]
            return urlunsplit((parts.scheme, parts.netloc.casefold(), parts.path, urlencode(sorted(query)), ""))
        except ValueError:
            return ""
    aa, bb = canonical(a.get("link")), canonical(b.get("link"))
    return bool(aa and aa == bb)


def same_event(a, b):
    """元記事2本が同じ出来事と確認できるときだけTrue。

    別の国・会社・統計・期間はまとめない。ニュース全体を見渡す目的なので、
    不確かな重複が残ることを、別の出来事を一覧から消すことより優先する。
    """
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    if _same_link(a, b):
        return True
    ta, tb = _norm(a.get("title")), _norm(b.get("title"))
    if not ta or not tb:
        return False
    full_a, full_b = _article_text(a), _article_text(b)
    ka, kb = _event_kind(ta) or _event_kind(full_a), _event_kind(tb) or _event_kind(full_b)
    if ka and kb and ka != kb:
        return False
    ca, cb = _company_keys(ta) or _company_keys(full_a), _company_keys(tb) or _company_keys(full_b)
    if ca and cb and not ca.intersection(cb):
        return False
    countries_a = _countries(ta) or _countries(_article_text(a))
    countries_b = _countries(tb) or _countries(_article_text(b))
    if countries_a and countries_b and not countries_a.intersection(countries_b):
        return False
    pa, pb = _periods(ta), _periods(tb)
    if any(pa[key] != pb[key] for key in pa.keys() & pb.keys()):
        return False
    da, db = _time(a), _time(b)
    if da and db and bool(da.tzinfo) == bool(db.tzinfo) and abs((da - db).total_seconds()) > 72 * 3600:
        return False
    score = _similarity(ta, tb)
    if ka in ("earnings", "capital_return") or kb in ("earnings", "capital_return"):
        subjects_match = bool(ca and ca == cb)
        if not subjects_match:
            sa, sb = _lead_subject(ta), _lead_subject(tb)
            subjects_match = bool(sa and sa == sb)
        if not subjects_match or ka != kb:
            return False
        if ka == "earnings":
            # 会社と決算の種類が一致すれば、売上/営業益/純益などの見出しの違いは認める。
            if _forecast(ta) != _forecast(tb):
                return False
            return bool(_same_day(a, b) or pa.keys() & pb.keys() or score >= 0.22)
        buyback_a = bool(re.search(r"自社株買|buyback|repurchase", ta))
        buyback_b = bool(re.search(r"自社株買|buyback|repurchase", tb))
        return buyback_a == buyback_b and score >= 0.22
    if ka == kb == "audit":
        if ca and ca == cb:
            return True
        # 速報で社名が省かれた場合も、同日の特徴的な監査失敗の表現を確認する。
        if _same_day(a, b) and _audit_failure(full_a) and _audit_failure(full_b) and (ca or cb):
            return True
    if ka == kb == "ownership" and ca and ca == cb and len(ca) >= 2:
        return bool(_same_day(a, b) or score >= 0.30)
    if ka == kb == "tax" and _same_day(a, b):
        phase_a, amounts_a = _gasoline_record(ta)
        phase_b, amounts_b = _gasoline_record(tb)
        if amounts_a and amounts_b and not amounts_a.intersection(amounts_b):
            return False
        if (phase_a and phase_a == phase_b) or amounts_a.intersection(amounts_b):
            return True
    if ka == kb == "stocks" and _same_day(a, b):
        indices_a, changes_a = _stock_fact(full_a)
        indices_b, changes_b = _stock_fact(full_b)
        if indices_a.intersection(indices_b) and changes_a.intersection(changes_b):
            return True
    if ka in ("cpi", "ppi", "pce", "inflation", "gdp", "employment", "retail", "policy"):
        # 「各国の金融政策」という広い共通点では足りない。
        if not (countries_a and countries_b and countries_a == countries_b):
            return False
        if ka == "policy":
            def action(text):
                return {name for name, pattern in (("up", r"利上げ|引き上げ|rate hike"), ("down", r"利下げ|引き下げ|rate cut"), ("hold", r"据え置|維持|unchanged|hold")) if re.search(pattern, text)}
            aa, ab = action(ta), action(tb)
            if aa and ab and not aa.intersection(ab):
                return False
        return score >= 0.30
    if ca.intersection(cb) and ka and ka == kb:
        return score >= 0.30
    # 未知の主体でも、単語が少し重なるだけの記事は統合しない。
    return score >= 0.62


_REGION = {
    "boj": "jp", "jgb10": "jp", "nikkei": "jp", "jp_cpi": "jp", "jp_economy": "jp",
    "fed": "us", "ust10": "us", "us_stocks": "us", "us_cpi": "us", "us_economy": "us", "china": "cn",
}
_DIRECT = {
    "boj": r"日銀|日本銀行|日本の政策金利|\bboj\b|bank of japan",
    "fed": r"frb|fomc|\bfed\b|federal reserve|米(?:国)?(?:の)?(?:政策金利|利上げ|利下げ)",
    "jgb10": r"日本(?:の)?(?:国債|長期金利|10年債)|日本国債|新発10年|\bjgb\b",
    "ust10": r"米(?:国)?(?:の)?(?:国債|長期金利|10年債|金利)|u\.?s\.?\s+(?:treasur|bond)|treasur(?:y|ies)",
    "nikkei": r"日経平均|topix|東証|日本株|東京株|japan(?:ese)?\s+(?:stock|share)|nikkei",
    "us_stocks": r"米(?:国)?株|ny株|nyダウ|ダウ平均|s&p\s*500|ナスダック|nasdaq|wall street|u\.?s\.?\s+(?:stock|share)|sox",
    "jp_cpi": r"日本(?:の)?(?:消費者物価|物価|インフレ|cpi)|japan(?:ese)?.{0,20}(?:cpi|inflation|consumer price)",
    "us_cpi": r"米(?:国)?(?:の)?(?:消費者物価|物価|インフレ|cpi|pce)|(?<![a-z])(?:u\.?s\.?|united states|american)(?![a-z]).{0,24}(?:cpi|pce|inflation|consumer price)",
    "jp_economy": r"日本(?:の)?(?:gdp|景気|経済|成長|雇用)|japan(?:ese)?.{0,20}(?:gdp|economy|growth)",
    "us_economy": r"米(?:国)?(?:の)?(?:gdp|景気|経済|成長|雇用|小売)|(?<![a-z])(?:u\.?s\.?|united states|american)(?![a-z]).{0,24}(?:gdp|economy|growth|jobs|payroll|retail)",
    "china": r"中国|人民元|人民銀|china|chinese|pboc",
}
_MORE_WORDS = {
    "boj": ("bank of japan", "boj"), "fed": ("federal reserve", "fed"),
    "jgb10": ("jgb",), "ust10": ("treasury", "treasuries", "treasury yields"),
    "nikkei": ("nikkei", "japanese stocks"), "us_stocks": ("us stocks", "u.s. stocks", "wall street", "nasdaq", "s&p 500", "dow"),
    "us_cpi": ("inflation", "cpi", "pce", "consumer prices"), "jp_cpi": ("食費", "食品", "物価安"),
    "us_economy": ("us economy", "u.s. economy", "recession", "payrolls", "us gdp"),
    "mortgage": ("mortgage", "home loan"), "usdjpy": ("yen", "usd/jpy", "dollar-yen"),
    "gold": ("gold",), "wages": ("wages", "salary", "pay growth"),
    "consumption": ("consumer spending", "consumption", "retail sales"),
    "import_prices": ("import prices", "import costs", "船賃", "海上運賃"),
    "trade_balance": ("trade balance", "trade deficit", "trade surplus"),
    "oil": ("crude", "oil", "gasoline", "petrol", "燃料費"),
    "banks": ("銀行", "証券", "金融機関", "bank", "banks", "banking", "securities"),
    "ai_semis": ("semiconductor", "semiconductors", "chip", "chips", "artificial intelligence", "nvidia", "openai", "anthropic", "アドテスト", "sk hynix", "skハイニックス", "キオクシア"),
    "realestate": ("real estate", "housing", "property prices"),
    "construction": ("construction costs",), "inbound": ("inbound tourism", "tourists", "visitors to japan"),
    "household": ("食費", "エンゲル係数", "food costs", "household", "cost of living"),
    "labor_shortage": ("labor shortage", "labour shortage"),
    "fiscal": ("補助金", "ガソリン補助", "government spending", "fiscal", "tax cut", "subsidies"),
}
_STRICT_WORDS = {
    # 地名・人名や、どの会社にもある「決算」だけを根拠にしない。
    "exporters": ("輸出", "自動車", "トヨタ", "ホンダ", "電機", "export", "exports", "exporter", "exporters", "automaker", "automakers", "auto tariffs", "toyota", "honda"),
    "tariffs": ("関税", "貿易摩擦", "通商", "tariff", "tariffs", "trade war", "trade tensions"),
    "geopolitics": ("戦争", "紛争", "停戦", "攻撃", "軍事", "経済安保", "安全保障", "war", "conflict", "ceasefire", "attack", "attacks", "security cooperation"),
    "risk_off": ("リスクオフ", "リスク回避", "急落", "暴落", "vix", "安全資産", "risk-off", "risk aversion", "safe haven", "market crash"),
}


_POLICY_BANK = {
    "boj": r"日銀|日本銀行|\bboj\b|bank of japan",
    "fed": r"frb|fomc|\bfed\b|federal reserve|米(?:国)?(?:の)?(?:中央銀行|連邦準備制度)",
}
_POLICY_ACTION = {
    1: r"利上げ|(?:政策)?金利.{0,20}(?:引き上げ|引上げ)|\brais(?:e|es|ed|ing).{0,20}(?:rates?|interest)|\brate hikes?\b",
    -1: r"利下げ|(?:政策)?金利.{0,20}(?:引き下げ|引下げ)|\b(?:cut|cuts|lower|lowers|lowered|reduce|reduces|reduced).{0,20}(?:rates?|interest)|\brate cuts?\b",
}


# 株価・売上・投資は別の量。これら3項目は一般語の一致だけでは残さず、
# 項目そのものと、その量の変化が明示された区間だけを根拠にする。
_AI_INVESTMENT = (
    r"(?:(?:生成)?ai|人工知能|半導体|データセンター)"
    r"(?:向け|関連|分野|の|への|に|・|インフラ|設備|開発|研究|用|と|及び|および|\s){0,12}"
    r"(?:設備投資|投資(?!家|信託)|設備支出|支出|工場建設)"
    r"|\b(?:ai|artificial intelligence|semiconductor|chip|data cent(?:er|re)s?)"
    r"(?:[ -]+(?:infrastructure|capital|related|sector))*[ -]+(?:investment|spending|capex)\b"
    r"|\b(?:investment|spending|capex)[ -]+(?:in|on|for)[ -]+(?:ai|semiconductors?|chips?|data cent(?:er|re)s?)\b"
)
_IMPORT_INDICATOR = r"輸入物価(?:指数)?|輸入価格|輸入コスト|\bimport (?:prices?|costs?)\b"
_JAPAN_IMPORT_INDICATOR = (
    r"(?:日本|本邦)(?:の|における)?(?:\d{1,2}月)?(?:円建て)?(?:輸入物価(?:指数)?|輸入価格|輸入コスト)"
    r"|円建て(?:の)?(?:輸入物価(?:指数)?|輸入価格|輸入コスト)"
    r"|(?:輸入物価(?:指数)?|輸入価格|輸入コスト)[(（](?:日本|円建て)[)）]"
    r"|\bjapan(?:'s|ese)?\s+(?:yen[ -]based\s+)?import (?:prices?|costs?)\b"
)
_CHINA_ECONOMY = (
    r"中国(?:の)?(?:経済|景気|gdp|国内総生産|成長率|個人消費|工業生産|小売売上|製造業pmi)"
    r"|中国[、,\s]+(?:gdp|国内総生産|成長率|工業生産|小売売上|製造業pmi)"
    r"|\b(?:china(?:'s)?|chinese)[ -]+(?:economy|economic growth|gdp|growth|industrial production|retail sales|manufacturing pmi)\b"
)
_SEMANTIC_ANCHORS = {
    "ai_semis": _AI_INVESTMENT,
    "import_prices": _IMPORT_INDICATOR,
    "china": _CHINA_ECONOMY,
}
_DIRECTION_WORDS = {
    "up": r"増(?:加|額|大|強|や|え)?|拡大|拡充|引き上げ|引上げ|上方修正|上昇|積み増|倍増|回復|持ち直|改善|加速|\b(?:ris(?:e|es|ing)|rose|grew|grow(?:s|ing)?|increas(?:e|es|ed|ing)|expand(?:s|ed|ing)?|higher|recover(?:s|ed|ing)?|accelerat(?:e|es|ed|ing))\b",
    "down": r"減(?:少|額|ら|り|る)?|削減|縮小|抑制|引き下げ|引下げ|下方修正|下落|低下|落ち込|悪化|減速|鈍化|弱含|\b(?:fall(?:s|ing)?|fell|drop(?:s|ped|ping)?|declin(?:e|es|ed|ing)|decreas(?:e|es|ed|ing)|shrink(?:s|ing)?|shrank|lower|slow(?:s|ed|ing)?|contract(?:s|ed|ing)?)\b",
}
_OTHER_METRIC = (
    r"株価|関連株|株[がはをも]|株\s*\d|株高|株安|増収|減収|増益|減益|利益|純益|売上|収益|回収率|回収|利回り|受注|生産|需要|人員|採用|雇用|増加率|伸び率"
    r"|\b(?:stock|shares?|profit|revenue|earnings|returns?|orders?|demand|production)\b"
)
_UNCERTAIN_CHANGE = (
    r"見送|撤回|否定|しない|せず|していない|しておらず|さない|さず|増えず|減らず|なかった|ない|ぬ|ずに|見通し|見込み|予想|予測|観測|期待|可能性|懸念|なら|場合|したら"
    r"|\b(?:not|never|no|deny|denies|denied|may|might|could|would|should|expect(?:s|ed|ing)?|forecast|if)\b"
)


def _metric_directions(text, anchor_pattern, *, china=False):
    """同じ節の指標と増減を結ぶ。別の指標へ移った先の増減を拾わない。"""
    directions = set()
    # 明示的に区切られた文・対比の外側から、方向を借りない。
    for clause in re.split(r"[。！？!?;；\n、,]|一方|対して|だが|しかし|whereas|\bbut\b", text):
        anchors = list(re.finditer(anchor_pattern, clause))
        for i, anchor in enumerate(anchors):
            end = anchors[i + 1].start() if i + 1 < len(anchors) else len(clause)
            tail = clause[anchor.end():min(end, anchor.end() + 42)]
            other = re.search(_OTHER_METRIC, tail)
            if other:
                tail = tail[:other.start()]
            # GDPの増加と成長率の鈍化は違う。明示的な回復/減速の表現を優先する。
            patterns = _DIRECTION_WORDS
            if china and re.search(r"回復|持ち直|改善|加速|悪化|減速|鈍化|弱含|\b(?:recover\w*|accelerat\w*|slow\w*)\b", tail):
                patterns = {
                    "up": r"回復|持ち直|改善|加速|\b(?:recover\w*|accelerat\w*)\b",
                    "down": r"悪化|減速|鈍化|弱含|\bslow\w*\b",
                }
            for direction, pattern in patterns.items():
                for change in re.finditer(pattern, tail):
                    # 「投資縮小を否定」「増やさない」「増加を予想」等は断定しない。
                    context = tail[max(0, change.start() - 12):change.end() + 20]
                    if not re.search(_UNCERTAIN_CHANGE, context):
                        directions.add(direction)
            # 英語では動詞が指標の前に来る。目的語の直前の動詞だけを扱う。
            prefix = clause[max(0, anchor.start() - 30):anchor.start()]
            for direction, pattern in (
                ("up", r"\b(?:increase[sd]?|raise[sd]?|boost(?:s|ed)?|expand(?:s|ed)?)"),
                ("down", r"\b(?:cuts?|reduc(?:e|es|ed)|slash(?:es|ed)?)"),
            ):
                match = re.search(pattern + r"(?:\s+(?:its|the|planned|annual|capital))*\s*$", prefix)
                if match and not re.search(_UNCERTAIN_CHANGE, prefix):
                    directions.add(direction)
    return directions


def _semantic_direction(article, node_id):
    """対象指標の明示的な方向1つだけを返す。不明/矛盾/根拠不足はNone。"""
    # titleの末尾とsummaryの先頭をつないで、架空の主語述語を作らない。
    parts = [_norm(article.get(k)) for k in ("title", "summary", "description") if article.get(k)]
    directions = set()
    for text in parts:
        anchor_pattern = _SEMANTIC_ANCHORS[node_id]
        if node_id == "china":
            # 「中国、GDPが…」は一つの指標名。国名だけを別の節にしない。
            text = re.sub(r"中国[、,]\s*(?=gdp|国内総生産|成長率|工業生産|小売売上|製造業pmi)", "中国", text)
        if node_id == "import_prices":
            countries = _countries(text)
            direct_jp = bool(re.search(_JAPAN_IMPORT_INDICATOR, text))
            # 日本の指標への代用を防ぐ。国省略の日本語「輸入物価」は扱うが、
            # 一企業の「原材料」や出所不明の英語import pricesだけでは認めない。
            if not direct_jp and (countries - {"jp"} or not re.search(r"輸入物価", text)):
                continue
            if countries - {"jp"}:
                anchor_pattern = _JAPAN_IMPORT_INDICATOR
        directions.update(_metric_directions(text, anchor_pattern, china=node_id == "china"))
        if node_id == "china":
            # 「GDPは増加、成長率は鈍化」の後半は同じ経済の別の量。
            # 水準の増加だけを回復へ変換せず、相反する方向なら札を外す。
            rate_scope = (
                r"(?:中国(?:の)?(?:gdp|国内総生産)|\bchina(?:'s)?\s+gdp)"
                r"[^。！？!?;；]{0,32}?[、,]\s*(?:成長率|伸び(?:率)?|growth(?: rate)?|pace of growth)"
                r"[^。！？!?;；、,]{0,24}?"
            )
            if re.search(rate_scope + r"(?:減速|鈍化|低下|\bslow\w*\b)", text):
                directions.add("down")
            if re.search(rate_scope + r"(?:加速|上昇|\baccelerat\w*\b)", text):
                directions.add("up")
    return next(iter(directions)) if len(directions) == 1 else None


def _policy_change_confirmed(article, node_id, direction):
    """思惑・姿勢・据え置きを、実際の政策金利変更に変換しない。

    明示的な決定/実施だけを認める補助ガード。すべての記事の時制や否定を
    完全に判定するものではない。判別しづらい文では政策方向の札を外す。
    """
    number = 1 if direction in ("up", 1) else -1 if direction in ("down", -1) else 0
    if not number:
        return False
    for sentence in re.split(r"[。！？!?;；\n]", _article_text(article)):
        last_bank = None
        for clause in re.split(r"[、,]|一方|対して", sentence):
            mentions = sorted((match.start(), bank) for bank, pattern in _POLICY_BANK.items() for match in re.finditer(pattern, clause))
            for action in re.finditer(_POLICY_ACTION[number], clause):
                before_banks = [bank for pos, bank in mentions if pos <= action.start()]
                bank = before_banks[-1] if before_banks else mentions[0][1] if len(mentions) == 1 else last_bank
                if bank != node_id:
                    continue
                context = clause[max(0, action.start() - 28):action.end() + 36]
                # 実績を市場の予想と比べる「予想通り」は、見通しの話とは区別する。
                context = re.sub(r"予想(?:通り|どおり)|as expected|in line with expectations", "", context)
                if re.search(r"期待|観測|可能性|見通し|見込み|予想|予測|検討|示唆|慎重|前向き|織り込|促す|迫る|求め|なら|場合|したら|見送|据え置|維持|否定|未決定|決めず|せず|しない|していない|しておらず|必要ない|不要|\b(?:expect(?:s|ed|ing|ation|ations)?|bets?|hopes?|may|might|could|would|should|likely|signal(?:s|ed)?|consider(?:s|ed|ing)?|if|hold|unchanged|not)\b", context):
                    continue
                if re.search(r"決定(?!的)|決めた|実施|発表|(?:利上げ|利下げ|引き上げ|引き下げ)した|(?:引き上げ|引き下げ)た", context):
                    return True
                # 英語の公表見出しに多い「Fed cuts/raised rates」。期待や仮定は上で除外。
                if re.search(r"\b(?:cuts|cut|raised|raises|lowered|lowers|reduced|reduces)\b", action.group()):
                    return True
            if mentions:
                last_bank = mentions[-1][1]
    return False


def valid_news_tags(article, tags, graph):
    """元記事の語句・国・対象指標を確認できるタグを返す（入力は変更しない）。

    外国の統計に似た米国・日本のノードを代用しない。国内外両方への影響が
    元記事に明示される場合は、両方のタグを認める。国が省略された記事や
    AI投資・日本の輸入物価・中国経済は、対象と方向が明示された場合だけ
    返す。逆向きの入力はその明示的な方向へ直す。文章の意味の万能な検証ではない。
    """
    nodes = graph.get("nodes", []) if isinstance(graph, dict) else []
    by_id = {n["id"]: n for n in nodes if isinstance(n, dict) and n.get("id")}
    text = _article_text(article)
    countries = _countries(text)
    out, seen = [], set()
    for tag in tags or []:
        if not isinstance(tag, dict) or tag.get("node") not in by_id:
            continue
        node_id = tag["node"]
        direction = tag.get("dir")
        if isinstance(direction, bool) or direction not in ("up", "down", 1, -1, None):
            continue
        node = by_id[node_id]
        words = _STRICT_WORDS.get(node_id, tuple(node.get("kw", [])) + _MORE_WORDS.get(node_id, ()))
        direct = bool(node_id in _DIRECT and re.search(_DIRECT[node_id], text))
        if not direct and not _has(text, words):
            continue
        region = _REGION.get(node_id)
        if region and countries:
            if region not in countries and not direct:
                continue
            # 複数国の文章で、米国という単語と別の国の物価をつなぎ合わせない。
            if node_id in ("us_cpi", "jp_cpi", "us_economy", "jp_economy") and countries - {region} and not direct:
                continue
        if node_id in _POLICY_BANK and not _policy_change_confirmed(article, node_id, direction):
            continue
        if node_id in _SEMANTIC_ANCHORS:
            confirmed = _semantic_direction(article, node_id)
            if confirmed is None:
                continue
            tag = dict(tag)
            if direction is not None:
                direction = (1 if confirmed == "up" else -1) if isinstance(direction, int) else confirmed
                tag["dir"] = direction
        key = (node_id, direction)
        if key not in seen:
            seen.add(key)
            out.append(dict(tag))
    return out


def _text_company_keys(text):
    keys = _company_keys(text)
    # 証券会社の短い呼び方。「野村総合研究所」などを野村HDと混同しない。
    if re.search(r"野村(?=は|が|の|も|では|、|\s|[0-9]|$)", text):
        keys.add("nomura")
    return keys


def _text_sentences(text):
    start = 0
    for match in re.finditer(r"[。！？!?]+|\.(?=\s+[A-Z]|\s*$)", text):
        # 英語の国名略記等のピリオドを、文末として切らない。
        if match.group() == "." and re.search(r"\b(?:u\.s|u\.k|mr|mrs|dr|inc|co|ltd|corp)\.$", text[:match.end()], re.I):
            continue
        yield text[start:match.end()]
        start = match.end()
    if start < len(text):
        yield text[start:]


def clean_news_text(article, text):
    """元見出し/配信要約にない既知の別主体が混入した文を外す。

    言い換えや事実の訂正はしない。自社の別表記や、固有名を新しく足さない
    金利・株価などの一般的な波及見通しは残す。未知の社名・国名や、数字・
    因果・時制を含む文章のすべての正しさを保証する処理ではない。
    """
    original = str(text or "")
    evidence = _article_text(article)
    companies = _text_company_keys(evidence)
    countries = _countries(evidence)
    kept = []
    for sentence in _text_sentences(original):
        normalized = _norm(sentence)
        if _text_company_keys(normalized) - companies:
            continue
        if _countries(normalized) - countries:
            continue
        kept.append(sentence)
    return "".join(kept).strip()
