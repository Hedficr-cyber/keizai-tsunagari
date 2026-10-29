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
import time
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
# 起床直後などの一時的な通信失敗だけを、30秒後・さらに60秒後に再試行する。
# 各通信にも時間制限を付け、接続できないまま次の定時実行を塞がない。
NETWORK_RETRY_DELAYS = (30, 60)
GIT_NETWORK_TIMEOUT = 45


def log(msg):
    # 時刻を付けておく（途中で Mac が眠ると、どこで止まったかがわかる）
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def run(*cmd, check=True, capture_output=False, timeout=None):
    log("$ " + " ".join(cmd))
    return subprocess.run(cmd, cwd=ROOT, check=check, capture_output=capture_output,
                          text=True, timeout=timeout,
                          env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})


def git_failure(result):
    """競合・一時通信障害・それ以外を分ける。認証失敗は再試行しない。"""
    message = f"{result.stdout or ''}\n{result.stderr or ''}".casefold()
    permanent = ("authentication failed", "could not read username", "could not read password",
                 "terminal prompts disabled", "permission denied", "access denied",
                 "repository not found", "invalid username or password", "error: 401",
                 "error: 403", "error: 404", "ssl certificate problem")
    if any(part in message for part in permanent):
        return "other"
    if any(part in message for part in ("non-fast-forward", "fetch first", "tip of your current branch is behind")):
        return "conflict"
    transient = ("could not resolve host", "could not resolve proxy", "failed to connect",
                 "couldn't connect", "timed out", "timeout", "connection reset",
                 "connection refused", "connection closed", "remote end hung up",
                 "early eof", "ssl_connect", "tls connection was non-properly terminated",
                 "http/2 stream", "error: 500", "error: 502", "error: 503", "error: 504",
                 "http 500", "http 502", "http 503", "http 504", "bad gateway",
                 "service unavailable")
    return "network" if any(part in message for part in transient) else "other"


def git_network(*args):
    """Git通信だけを限定再試行する。読み解きやデータ生成へは戻らない。"""
    for attempt in range(len(NETWORK_RETRY_DELAYS) + 1):
        try:
            result = run(GIT, *args, check=False, capture_output=True, timeout=GIT_NETWORK_TIMEOUT)
        except subprocess.TimeoutExpired:
            result = subprocess.CompletedProcess((GIT, *args), 124, "", "Git connection timed out")
        except OSError as exc:
            log(f"Gitを実行できなかった（{type(exc).__name__}）")
            return subprocess.CompletedProcess((GIT, *args), 127, "", "Git could not be started")
        if result.returncode == 0:
            return result
        kind = git_failure(result)
        if kind != "network" or attempt == len(NETWORK_RETRY_DELAYS):
            log(f"Git {args[0]} に失敗（{'通信エラー' if kind == 'network' else '競合' if kind == 'conflict' else '認証・権限またはその他のエラー'}、終了コード{result.returncode}）")
            return result
        delay = NETWORK_RETRY_DELAYS[attempt]
        log(f"Git {args[0]} の一時的な通信エラー。{delay}秒後に再試行（{attempt + 1}/{len(NETWORK_RETRY_DELAYS)}）")
        time.sleep(delay)


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
    run(GIT, "rebase", "--abort", check=False, capture_output=True)
    if git_network("fetch", "-q", "origin").returncode != 0:
        log("最新コードを取り込めなかったので、収集・読み解きはせず終える。公開中の版はそのまま残す")
        return 4
    if run(GIT, "reset", "-q", "--hard", "origin/main", check=False).returncode != 0:
        log("最新コードにそろえられなかったので終える")
        return 4
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
    for attempt in range(3):
        pushed = git_network("push", "-q", "origin", "HEAD:main")
        if pushed.returncode == 0:
            log("公開した")
            return 0
        if git_failure(pushed) != "conflict" or attempt == 2:
            break
        # 手元の作業から先に送られていたら、その上に今回のデータを載せ直す（データは今回のものを優先）
        if git_network("pull", "-q", "--rebase", "-X", "theirs", "origin", "main").returncode != 0:
            break
    log("送れなかった。公開中の版はそのまま残し、次の定時実行で改めて更新する")
    return 3


if __name__ == "__main__":
    sys.exit(main())
