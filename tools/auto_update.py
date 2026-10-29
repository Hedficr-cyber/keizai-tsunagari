"""Mac の定時実行（launchd）から呼ぶ自動更新。毎時動く（眠っていた分は、起きたときに1回）。

最新のコードにそろえ → ニュースを集め（10秒ほど・利用枠は使わない）→ 読み解くかを決める
→ Claude で読み解き → （1日1回）答え合わせ → （週末）週のまとめ
→ data/ だけをコミットして GitHub に送る。GitHub Pages がそれを配信するので、iPhone のアプリに反映される。
動かす場所は ~/Library/Application Support/keizai-app/repo（手で作業する Documents の写しとは別。
こちらは毎回 GitHub の最新にそろえるので、手で直さない）。
"""
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GIT = shutil.which("git", path="/opt/homebrew/bin:/usr/bin") or "git"
PY = sys.executable
RAW = ROOT / "_work" / "raw"
# 前回の読み解きに使った見出し（新しく入った本数を数えるため。_work は Git の外なので reset でも消えない）
SEEN = RAW / "analyzed_titles.json"
# 読み解く目安：前回から3時間たったら必ず。2時間以上たって新しい見出しが80本以上なら早めに。夜中は6時間あける
EVERY_HOURS, EARLY_HOURS, EARLY_NEW, NIGHT_HOURS = 3, 2, 80, 6


def log(msg):
    # 時刻を付けておく（途中で Mac が眠ると、どこで止まったかがわかる）
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def run(*cmd, check=True):
    log("$ " + " ".join(cmd))
    return subprocess.run(cmd, cwd=ROOT, check=check, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})


def norm_titles():
    sys.path.insert(0, str(ROOT / "tools"))
    from collect import norm  # 集めるときと同じ方法で見出しをそろえる
    raw = json.loads((RAW / "collected.json").read_text(encoding="utf-8"))
    return {norm(n["title"]) for n in raw["news"]}


def should_analyze():
    """読み解く（Claude の利用枠を使う）かどうか。理由も返す。"""
    if os.environ.get("KEIZAI_FORCE") == "1":
        return True, "指定があったので読み解く"
    try:
        latest = json.loads((ROOT / "data" / "latest.json").read_text(encoding="utf-8"))
        age = (datetime.now().astimezone() - datetime.fromisoformat(latest["updated"])).total_seconds() / 3600
    except (OSError, ValueError, KeyError):
        return True, "前回の読み解きが見つからない"
    try:
        new = len(norm_titles() - set(json.loads(SEEN.read_text(encoding="utf-8"))))
    except (OSError, ValueError):
        new = None
    hour = datetime.now().hour
    need = NIGHT_HOURS if hour < 6 else EVERY_HOURS
    head = f"前回から{age:.1f}時間・新しい見出し{'?' if new is None else new}本"
    if age >= need:
        return True, f"{head}：{need}時間たったので読み解く"
    if hour >= 6 and age >= EARLY_HOURS and new is not None and new >= EARLY_NEW:
        return True, f"{head}：新しいニュースが多いので読み解く"
    return False, f"{head}：まだ読み解かない"


def main():
    print(f"=== {datetime.now():%Y-%m-%d %H:%M:%S} 自動更新を始める", flush=True)
    # 前回の途中で止まった取り込みがあれば片付けてから、GitHub の最新にそろえる
    run(GIT, "rebase", "--abort", check=False)
    run(GIT, "fetch", "-q", "origin")
    run(GIT, "reset", "-q", "--hard", "origin/main")
    if run(PY, "-X", "utf8", "tools/collect.py", check=False).returncode != 0:
        log("ニュースを集められなかったので終える")
        return 1
    go, why = should_analyze()
    log(why)
    if not go:
        return 0
    if run(PY, "-X", "utf8", "tools/analyze.py", check=False).returncode != 0:
        log("読み解きに失敗したので、公開中の版をそのまま残す")
        return 2
    SEEN.write_text(json.dumps(sorted(norm_titles()), ensure_ascii=False), encoding="utf-8")
    # 答え合わせ（1日1回）と週のまとめ（土日に1回）。失敗しても今日の読み解きは公開する
    run(PY, "-X", "utf8", "tools/analyze.py", "--review", check=False)
    run(PY, "-X", "utf8", "tools/analyze.py", "--weekly", check=False)
    run(GIT, "add", "data")
    if run(GIT, "diff", "--cached", "--quiet", check=False).returncode == 0:
        log("変化なし")
        return 0
    run(GIT, "commit", "-q", "-m", f"データ更新 {datetime.now():%Y-%m-%d %H:%M}")
    for _ in range(3):
        if run(GIT, "push", "-q", "origin", "HEAD:main", check=False).returncode == 0:
            log("公開した")
            return 0
        # 手元の作業から先に送られていたら、その上に今回のデータを載せ直す（データは今回のものを優先）
        run(GIT, "pull", "-q", "--rebase", "-X", "theirs", "origin", "main", check=False)
    log("送れなかった")
    return 3


if __name__ == "__main__":
    sys.exit(main())
