"""Mac の定時実行（launchd）から呼ぶ自動更新。

最新のコードにそろえ → ニュースを集め → Claude で読み解き → data/ だけをコミットして GitHub に送る。
GitHub Pages がそれを配信するので、iPhone のアプリに反映される。
動かす場所は ~/Library/Application Support/keizai-app/repo（手で作業する Documents の写しとは別。
こちらは毎回 GitHub の最新にそろえるので、手で直さない）。
"""
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GIT = shutil.which("git", path="/opt/homebrew/bin:/usr/bin") or "git"
PY = sys.executable


def run(*cmd, check=True):
    print("$", " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=ROOT, check=check, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})


def main():
    print(f"=== {datetime.now():%Y-%m-%d %H:%M:%S} 自動更新を始める", flush=True)
    # 前回の途中で止まった取り込みがあれば片付けてから、GitHub の最新にそろえる
    run(GIT, "rebase", "--abort", check=False)
    run(GIT, "fetch", "-q", "origin")
    run(GIT, "reset", "-q", "--hard", "origin/main")
    if run(PY, "-X", "utf8", "tools/collect.py", check=False).returncode != 0:
        print("ニュースを集められなかったので終える", flush=True)
        return 1
    if run(PY, "-X", "utf8", "tools/analyze.py", check=False).returncode != 0:
        print("読み解きに失敗したので、公開中の版をそのまま残す", flush=True)
        return 2
    run(GIT, "add", "data")
    if run(GIT, "diff", "--cached", "--quiet", check=False).returncode == 0:
        print("変化なし", flush=True)
        return 0
    run(GIT, "commit", "-q", "-m", f"データ更新 {datetime.now():%Y-%m-%d %H:%M}")
    for _ in range(3):
        if run(GIT, "push", "-q", "origin", "HEAD:main", check=False).returncode == 0:
            print("公開した", flush=True)
            return 0
        # 手元の作業から先に送られていたら、その上に今回のデータを載せ直す（データは今回のものを優先）
        run(GIT, "pull", "-q", "--rebase", "-X", "theirs", "origin", "main", check=False)
    print("送れなかった", flush=True)
    return 3


if __name__ == "__main__":
    sys.exit(main())
