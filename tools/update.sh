#!/bin/zsh
# ニュースを集めて、Claude で読み解き、data/latest.json を作り直す
# 使い方: zsh tools/update.sh        （AI なしで試すときは zsh tools/update.sh --no-ai）
set -e
cd "${0:A:h}/.."
PY=/opt/homebrew/bin/python3
$PY -X utf8 tools/collect.py
$PY -X utf8 tools/analyze.py "$@"
