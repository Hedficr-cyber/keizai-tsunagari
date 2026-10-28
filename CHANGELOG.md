# 版の履歴

## v0.2.0（2026-10-28）
- GitHub Pages で公開（https://hedficr-cyber.github.io/keizai-tsunagari/）。
- 自動更新：Mac の launchd が毎日 7:00・12:00・18:00 に tools/auto_update.py を動かし、data/ だけをコミットして公開版を更新する。
- AI の読み解きに失敗した回は、前の版を消さずに残す。

## v0.1.0（2026-10-28）
- 最初の試作。今日・ニュース・つながり・識者・学ぶの5画面。
- つながり図（31項目・66本の因果）と「もしも〜なら」の波及シミュレーション。
- ニュース・識者・相場の自動収集（tools/collect.py）と、Claude による読み解き（tools/analyze.py）。
