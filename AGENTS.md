# 経済のつながり の開発ルール

- 2026-10-28 に Claude Code で作り始めた個人用の PWA。ユーザーの依頼：「日経新聞や SNS で経済・金融について発信している詳しい人などから情報を集め、アプリ一つでわかるようにしたい。ニュースを読むだけでなく、○○の影響で今後こうなるかも、△△と□□はここに影響する、のように紐づいて学べる。情報収集もでき、世の中の動きをリアルに学べる」。
- Claude と Codex が交互に作業する。共通の引き継ぎフォルダ（~/Documents/04_開発・Claude/Claude_Codex_引き継ぎ/）の運用ルールに従い、自分の notes にメモを残す。相手のメモは上書きしない。
- 作業用のスクリプト・検証画像・集めた生データは `_work/` へ（公開しない）。
- 中心は `data/graph.json`（つながり図）。項目や関係を足すときは、`sign`（同じ向き 1／逆向き -1）、`strength`（3 強い／2 ふつう／1 条件しだい）、`lag`、`why`（「上がる場合」の向きで書く）をそろえ、`node _work/check_graph.mjs` を通す。新しい項目は `js/graph.js` の `PLACE`（図の位置）にも足す。
- AI の読み解きは `tools/analyze.py`。事実を作らない・見通しは「〜かもしれない」・売買をすすめない・識者は本人の見方として読めるものだけ、を守らせている。
- 記事本文は取り込まない（見出し・リンク・AI の要約だけ）。日経平均の公式 CSV は転載禁止なので使わない。
- UI：グレー／チャコール基調、Noto Sans JP、下のナビはガラス風。スマホのプルダウンは使わず、画面内のボタン（チップ）で選ぶ。ボタンの中にボタンを入れない（`chip(..., { span: true })`）。
- 表示はすべて `esc()` を通し、外部リンクは https だけ（`safeUrl`）。CSP は index.html。
- **公開（2026-10-28 本人指示「公開して自動更新」）**：https://hedficr-cyber.github.io/keizai-tsunagari/ （リポジトリ Hedficr-cyber/keizai-tsunagari、main をそのまま配信、`.nojekyll` あり）。push はこのフォルダの credential.helper（gh）で AI のシェルから通る。コミットの名前は Hedficr-cyber の noreply（個人のメールを公開しない）。
- **自動更新**：Mac の launchd が 7:00・12:00・18:00 に `~/Library/Application Support/keizai-app/repo/tools/auto_update.py` を動かし、`data/` をコミットして push する。そのため **このフォルダで作業する前に必ず `git pull`**（公開側のデータが先に進んでいる）。runtime の写しは毎回 reset されるので、そちらは直さない。
- 画面の部品は Service Worker が手元に保存する。js/css/index.html を変えたら `sw.js` の `CACHE` と `js/versions.js`・`CHANGELOG.md` の版を上げる。
