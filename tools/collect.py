"""ニュース・識者の発信・相場を集めて _work/raw/collected.json に保存する。

使い方: /opt/homebrew/bin/python3 -X utf8 tools/collect.py
外部ライブラリは使わない（標準ライブラリだけ）。
"""
import csv
import html
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "_work" / "raw" / "collected.json"
JST = timezone(timedelta(hours=9))
UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
    "Accept-Language": "ja,en;q=0.8",
}
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "rss1": "http://purl.org/rss/1.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "media": "http://search.yahoo.com/mrss/",
    "yt": "http://www.youtube.com/xml/schemas/2015",
}
NEWS_HOURS = 36
EXPERT_DAYS = 7
# 株価の銘柄ページなど、ニュースではない見出し
JUNK = re.compile(r"Stock Price|Price Quote|Spot Rate|株価・株式情報|\| Stock|Latest News -")


def fetch(url, timeout=25, tries=2):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


def gnews_url(q):
    return "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": q, "hl": "ja", "gl": "JP", "ceid": "JP:ja"})


def clean(text, limit=300):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def parse_time(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except Exception:  # noqa: BLE001
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:  # noqa: BLE001
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=JST)
    return d.astimezone(JST)


def text_of(el, *paths):
    for p in paths:
        x = el.find(p, NS)
        if x is not None and (x.text or "").strip():
            return x.text.strip()
    return ""


def parse_feed(data):
    """RSS 2.0 / RSS 1.0(RDF) / Atom をまとめて読む。"""
    root = ET.fromstring(data)
    items = []
    for it in root.iter("item"):
        src = it.find("source")
        items.append({
            "title": text_of(it, "title"),
            "link": text_of(it, "link"),
            "time": parse_time(text_of(it, "pubDate", "dc:date")),
            "summary": clean(text_of(it, "description")),
            "publisher": (src.text or "").strip() if src is not None else "",
        })
    for it in root.iter("{%s}item" % NS["rss1"]):
        items.append({
            "title": text_of(it, "rss1:title"),
            "link": text_of(it, "rss1:link"),
            "time": parse_time(text_of(it, "dc:date")),
            "summary": clean(text_of(it, "rss1:description")),
            "publisher": "",
        })
    for it in root.iter("{%s}entry" % NS["atom"]):
        link = it.find("atom:link", NS)
        items.append({
            "title": text_of(it, "atom:title"),
            "link": link.get("href", "") if link is not None else "",
            "time": parse_time(text_of(it, "atom:published", "atom:updated")),
            "summary": clean(text_of(it, "media:group/media:description", "atom:summary"), 400),
            "publisher": "",
        })
    return items


def split_publisher(title, publisher):
    """Googleニュースの「見出し - 媒体名」を分ける。"""
    if publisher and title.endswith(" - " + publisher):
        return title[: -len(publisher) - 3].strip(), publisher
    m = re.match(r"^(.*) - ([^-]{2,30})$", title)
    if m and not publisher:
        return m.group(1).strip(), m.group(2).strip()
    return title, publisher


# 見出しの前後に付く、媒体名・コーナー名・写真ページの印など（記事の中身ではないもの）
TITLE_PREFIX = re.compile(r"^(写真ギャラリー\d+枚め|【?写真】?|動画)\s*[｜|]\s*")
TITLE_HASHTAG = re.compile(r"\s+#\S.*$")


def clean_title(title):
    t = TITLE_PREFIX.sub("", title.strip())
    t = TITLE_HASHTAG.sub("", t)
    # 「見出し | コーナー | 媒体名」「見出し｜媒体名」の後ろ側を落とす（短いものだけ）
    while True:
        m = re.match(r"^(.*\S)\s*[|｜]\s*([^|｜]{1,24})$", t)
        if not m or len(m.group(1)) < 12:
            break
        t = m.group(1)
    # 「見出し - コーナー名」（ダイヤモンドなど）
    m = re.match(r"^(.{12,}?)\s+[\-－]\s+([^\s\-－]{2,20})$", t)
    if m:
        t = m.group(1)
    return t.strip()


def norm(title):
    return re.sub(r"[\s　、。,.・「」『』【】（）()!?！？:：\-－—…]", "", title)[:40]


def feed_url(f):
    if f["type"] == "gnews":
        return gnews_url(f["q"])
    if f["type"] == "youtube":
        return "https://www.youtube.com/feeds/videos.xml?channel_id=" + f["channel"]
    return f["url"]


def collect_news(cfg, now, log):
    out, seen = [], set()
    for src in cfg["news"]:
        try:
            items = parse_feed(fetch(feed_url(src)))
        except Exception as e:  # noqa: BLE001
            log.append(f"NG ニュース {src['name']}: {type(e).__name__}")
            continue
        n = 0
        google = src["type"] == "gnews" or "news.google.com" in feed_url(src)
        pub_only = re.compile(src["pub"]) if src.get("pub") else None
        # 新しい順に、媒体ごとの上限まで（1つの媒体に偏りすぎないように）
        items.sort(key=lambda it: it["time"].isoformat() if it["time"] else "", reverse=True)
        for it in items:
            if n >= src.get("max", 40):
                break
            title, pub = split_publisher(it["title"], it["publisher"]) if google else (it["title"], "")
            if pub_only and not pub_only.search(pub or ""):
                continue
            title = clean_title(title)
            if not title or JUNK.search(title) or JUNK.search(it["title"]):
                continue
            if it["time"] and now - it["time"] > timedelta(hours=NEWS_HOURS):
                continue
            key = norm(title)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "title": title,
                "link": it["link"],
                "source": pub or src["name"],
                "feed": src["id"],
                "group": src.get("group", ""),
                "lang": src.get("lang", "ja"),
                "time": it["time"].isoformat() if it["time"] else None,
                # Googleニュース経由の要約は見出しの繰り返しなので使わない
                "summary": "" if google else it["summary"][:200],
            })
            n += 1
        log.append(f"OK ニュース {src['name']}: {n}件")
    out.sort(key=lambda x: x["time"] or "", reverse=True)
    return out


# YouTube の公式の配信（RSS）は 2026-10 時点で止まっている。動画一覧のページを機械で読むのは
# 利用規約で禁じられているので、公式の YouTube Data API（無料・キーが要る）があるときだけ使う。
YT_KEY_FILE = Path.home() / "Library" / "Application Support" / "keizai-app" / "youtube_api_key"


def youtube_key():
    k = os.environ.get("KEIZAI_YT_KEY", "").strip()
    if not k and YT_KEY_FILE.exists():
        k = YT_KEY_FILE.read_text(encoding="utf-8").strip()
    return k


def youtube_items(channel, key):
    """チャンネルの新しい動画（アップロード一覧）を YouTube Data API で取る。1回1ユニット。"""
    url = "https://www.googleapis.com/youtube/v3/playlistItems?" + urllib.parse.urlencode({
        "part": "snippet", "maxResults": 8, "playlistId": "UU" + channel[2:], "key": key})
    data = json.loads(fetch(url))
    items = []
    for it in data.get("items", []):
        sn = it.get("snippet", {})
        vid = sn.get("resourceId", {}).get("videoId")
        if not vid:
            continue
        items.append({"title": sn.get("title", ""), "link": f"https://www.youtube.com/watch?v={vid}", "channel": sn.get("channelTitle", ""),
                      "time": parse_time(sn.get("publishedAt")), "summary": clean(sn.get("description", ""), 400),
                      "publisher": ""})
    return items


def collect_experts(cfg, now, log):
    out, seen = [], set()
    yt_key = youtube_key()
    yt_skipped = []
    for ex in cfg["experts"]:
        got = []
        for f in ex["feeds"]:
            try:
                if f["type"] == "youtube":
                    if not yt_key:
                        yt_skipped.append(ex["name"])
                        continue
                    items = youtube_items(f["channel"], yt_key)
                else:
                    items = parse_feed(fetch(feed_url(f)))
            except Exception as e:  # noqa: BLE001
                log.append(f"NG 識者 {ex['name']}: {type(e).__name__}")
                continue
            for it in items:
                title, pub = split_publisher(it["title"], it["publisher"]) if f["type"] == "gnews" else (it["title"], "")
                title = clean_title(title)
                if not title or (it["time"] and now - it["time"] > timedelta(days=EXPERT_DAYS)):
                    continue
                # 名前で探した記事は、見出しに名字があるものだけ（本文に名前が出るだけの別人の記事を除く）
                if f["type"] == "gnews" and ex.get("key") and ex["key"] not in title:
                    continue
                key = norm(title)
                if key in seen:
                    continue
                seen.add(key)
                kind = {"youtube": "動画", "gnews": "記事"}.get(f["type"], f.get("kind", "投稿"))
                got.append({
                    "expert": ex["id"],
                    "title": title,
                    "link": it["link"],
                    "source": pub or ex["name"],
                    "kind": kind,
                    "time": it["time"].isoformat() if it["time"] else None,
                    # 動画の説明欄は宣伝文の前までにする
                    "summary": "" if f["type"] == "gnews" else re.split(r"[━▼■]|https?://", it["summary"])[0].strip()[:400],
                })
        if not got and any(f["type"] == "youtube" for f in ex["feeds"]) and not yt_key:
            continue
        got.sort(key=lambda x: x["time"] or "", reverse=True)
        out.extend(got[:ex.get("max", 6)])
        chan = next((i.get("channel") for i in locals().get("items", []) if i.get("channel")), "")
        # YouTube はチャンネル名も記録する（チャンネルIDの取り違えに気づけるように）
        log.append(f"OK 識者 {ex['name']}: {len(got[:ex.get('max', 6)])}件" + (f"（チャンネル名：{chan}）" if chan else ""))
    if yt_skipped:
        log.append(f"-- YouTube はキー未設定のため取らない（{'・'.join(yt_skipped)}）")
    return out


MONTHS = {m: i for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July", "August",
                                      "September", "October", "November", "December"], 1)}


def calendar(now, log):
    """これからの大きな予定（公式の日程ページから）。date は結果が出る日（現地）。"""
    events = []
    year = now.year
    # FRB（FOMC）。2日目の午後2時（米東部）に結果。日本時間では翌日の朝
    try:
        page = fetch("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm").decode("utf-8", "replace")
        for y in (year, year + 1):
            i = page.find(f"{y} FOMC Meetings")
            if i < 0:
                continue
            j = page.find(f"{y - 1} FOMC Meetings", i)
            seg = page[i:j if j > i else i + 20000]
            for mon, days in re.findall(r'fomc-meeting__month[^>]*>\s*<strong>([^<]+)</strong>.*?fomc-meeting__date[^>]*>([^<]+)<', seg, re.S):
                m = re.match(r"(\d+)(?:-(\d+))?", days.strip())
                mon1 = mon.split("/")[-1].strip()
                if not m or mon1 not in MONTHS:
                    continue
                d = int(m.group(2) or m.group(1))
                # 結果は米東部の2日目午後2時＝日本時間の次の日の朝。日付は日本時間に直す
                us_day = date(y, MONTHS[mon1], d)
                jp_day = us_day + timedelta(days=1)
                events.append({"date": jp_day.isoformat(), "name": "FOMC（米国の金融政策の決定）",
                               "note": f"結果は日本時間の朝3〜4時ごろ（米国では{us_day.month}/{us_day.day}）" + ("。経済見通しの公表あり" if "*" in days else ""),
                               "nodes": ["fed", "usdjpy", "us_stocks", "ust10"], "source": "FRB"})
        log.append("OK 予定 FOMC")
    except Exception as e:  # noqa: BLE001
        log.append(f"NG 予定 FOMC: {type(e).__name__}")
    # 日銀の金融政策決定会合。2日目の昼ごろに結果
    try:
        page = fetch("https://www.boj.or.jp/mopo/mpmsche_minu/index.htm").decode("utf-8", "replace")
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", page))
        for y in (year, year + 1):
            i = text.find(f"{y}年 金融政策決定会合")
            if i < 0:
                continue
            j = text.find("年 金融政策決定会合", i + 10)
            seg = text[i:j if j > i else len(text)]
            for mo, d1, d2 in re.findall(r"(\d{1,2})月\s?(\d{1,2})日（.）・(\d{1,2})日（.）", seg):
                events.append({"date": f"{y:04d}-{int(mo):02d}-{int(d2):02d}", "name": "日銀の金融政策決定会合",
                               "note": "結果は2日目の昼ごろ。終わったあと総裁会見", "nodes": ["boj", "usdjpy", "jgb10", "banks"],
                               "source": "日本銀行"})
        log.append("OK 予定 日銀")
    except Exception as e:  # noqa: BLE001
        log.append(f"NG 予定 日銀: {type(e).__name__}")
    # 日本の GDP（内閣府の公表予定）
    try:
        page = fetch("https://www.esri.cao.go.jp/jp/sna/kouhyou/kouhyou_top.html").decode("utf-8", "replace")
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", page))
        for q, kind, y, mo, d in re.findall(r"(\d{4}年\d{1,2}-\d{1,2}月期)（(\d次速報)） (\d{4})（[^）]+）年(\d{1,2})月(\d{1,2})日", text):
            events.append({"date": f"{int(y):04d}-{int(mo):02d}-{int(d):02d}", "name": f"日本のGDP（{q}・{kind}）",
                           "note": "朝8時50分に公表", "nodes": ["jp_economy", "consumption"], "source": "内閣府"})
        log.append("OK 予定 GDP")
    except Exception as e:  # noqa: BLE001
        log.append(f"NG 予定 GDP: {type(e).__name__}")
    # 結果が出たあとも1日は残す（「結果が出ました」として、シナリオと照らせるように）
    today = (now.date() - timedelta(days=1)).isoformat()
    until = (now.date() + timedelta(days=45)).isoformat()
    seen, out = set(), []
    for e in sorted(events, key=lambda x: x["date"]):
        k = (e["date"], e["name"])
        if today <= e["date"] <= until and k not in seen:
            seen.add(k)
            out.append(e)
    return out


def series_tail(points, days=35):
    pts = [p for p in points if p[1] is not None][-days:]
    return [{"d": d, "v": round(v, 3)} for d, v in pts]


def markets(log):
    res = {}
    today = datetime.now(JST).date()
    start = (today - timedelta(days=50)).isoformat()
    # ドル円（欧州中央銀行の参考レート。土日祝は更新なし）
    try:
        d = json.loads(fetch(f"https://api.frankfurter.app/{start}..?from=USD&to=JPY"))
        pts = sorted((k, v["JPY"]) for k, v in d["rates"].items())
        res["usdjpy"] = {"name": "ドル円", "unit": "円", "source": "欧州中央銀行（frankfurter.app）", "series": series_tail(pts)}
        log.append("OK 相場 ドル円")
    except Exception as e:  # noqa: BLE001
        log.append(f"NG 相場 ドル円: {type(e).__name__}")
    # 日本の10年国債（財務省 国債金利情報）
    try:
        pts = []
        for url in ("https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv",
                    "https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv"):
            try:
                raw = fetch(url, timeout=40).decode("shift_jis", "replace")
            except Exception:  # noqa: BLE001
                continue
            rows = list(csv.reader(io.StringIO(raw)))
            head = next((r for r in rows if r and r[0] == "基準日"), None)
            if not head or "10年" not in head:
                continue
            col = head.index("10年")
            for r in rows:
                m = re.match(r"^([RHS])(\d+)\.(\d+)\.(\d+)$", r[0]) if r else None
                if m:
                    era = {"R": 2018, "H": 1988, "S": 1925}[m.group(1)]
                    dt = f"{era + int(m.group(2)):04d}-{int(m.group(3)):02d}-{int(m.group(4)):02d}"
                elif r and re.match(r"^\d{4}/\d{1,2}/\d{1,2}$", r[0]):
                    y, mo, da = r[0].split("/")
                    dt = f"{int(y):04d}-{int(mo):02d}-{int(da):02d}"
                else:
                    continue
                try:
                    pts.append((dt, float(r[col])))
                except (ValueError, IndexError):
                    pass
        if pts:
            pts = sorted(dict(pts).items())
            res["jgb10"] = {"name": "日本の10年国債利回り", "unit": "%", "source": "財務省 国債金利情報", "series": series_tail(pts)}
            log.append("OK 相場 日本10年債")
        else:
            log.append("NG 相場 日本10年債: 読み取れず")
    except Exception as e:  # noqa: BLE001
        log.append(f"NG 相場 日本10年債: {type(e).__name__}")
    # 米国の10年国債（米財務省）
    try:
        pts = []
        for y in sorted({today.year, (today - timedelta(days=50)).year}):
            raw = fetch("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/"
                        f"{y}/all?type=daily_treasury_yield_curve&field_tdr_date_value={y}&page&_format=csv", timeout=40).decode()
            rows = list(csv.DictReader(io.StringIO(raw)))
            for r in rows:
                mo, da, yy = r["Date"].split("/")
                try:
                    pts.append((f"{yy}-{mo}-{da}", float(r["10 Yr"])))
                except (ValueError, KeyError):
                    pass
        pts.sort()
        res["ust10"] = {"name": "米国の10年国債利回り", "unit": "%", "source": "米財務省", "series": series_tail(pts)}
        log.append("OK 相場 米10年債")
    except Exception as e:  # noqa: BLE001
        log.append(f"NG 相場 米10年債: {type(e).__name__}")
    return res


def main():
    cfg = json.loads((ROOT / "tools" / "sources.json").read_text(encoding="utf-8"))
    now = datetime.now(JST)
    log = []
    data = {
        "collected": now.isoformat(timespec="seconds"),
        "news": collect_news(cfg, now, log),
        "experts": collect_experts(cfg, now, log),
        "markets": markets(log),
        "calendar": calendar(now, log),
        "log": log,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n".join(log))
    print(f"ニュース {len(data['news'])}件 / 識者 {len(data['experts'])}件 / 相場 {len(data['markets'])}種 / 予定 {len(data['calendar'])}件 → {OUT}")
    return 0 if data["news"] else 1


if __name__ == "__main__":
    sys.exit(main())
