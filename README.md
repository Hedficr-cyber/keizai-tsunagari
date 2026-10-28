# 経済のつながり

経済・金融・ビジネスのニュースと、識者の発信を集めて、「何が起きたか」だけでなく「それが何につながり、この先どうなるかもしれないか」を学ぶ個人用アプリ（PWA）。

- 公開版：https://hedficr-cyber.github.io/keizai-tsunagari/ （iPhone の Safari で開き、共有 →「ホーム画面に追加」）
- リポジトリ：https://github.com/Hedficr-cyber/keizai-tsunagari

## 画面

| 画面 | できること |
|---|---|
| 今日 | 今日の一言、相場（ドル円・日米の10年金利）、いま動いているもの、今日のテーマ（つながり・今後こうなるかも・次の注目・識者の見方・関連ニュース） |
| ニュース | AI が選んだ経済ニュース。分野で絞り込み、タップで要点・この先・そこから広がる影響 |
| つながり | 31項目・66本の因果をまとめた図。項目をタップで仕組み・つながり・今日のニュース。「もしも〜なら」で起点と向きを選ぶと、影響が1段目→2段目→3段目と広がる（逆向きの力がぶつかる所は「綱引き」） |
| 識者 | 後藤達也さんの note、エコノミストの記事・コメント、PIVOT などの動画から、その人の見方を AI が短くまとめる |
| 学ぶ | つながりクイズ（図から自動で出題）、今日のニュースのクイズ、用語と仕組み |

## データの流れ

1. `tools/collect.py` … RSS（日経の見出しは Google ニュース経由、NHK、東洋経済、ダイヤモンド、ITmedia、日銀）、識者（note・Google ニュースの名前検索・YouTube）、相場（欧州中央銀行のドル円、財務省の国債金利、米財務省の国債金利）を集めて `_work/raw/collected.json` へ。
2. `tools/analyze.py` … Mac に入っている Claude Code（デスクトップアプリの claude コマンド）を1回呼び、テーマ・つながり・見通し・識者の見方・クイズを作って `data/latest.json` へ。日ごとの控えは `data/archive/`。
3. アプリは `data/graph.json`（つながり図。手で整えた基本の因果）と `data/latest.json` を読むだけ。

手で更新するときは `zsh tools/update.sh`。1回およそ2分、Claude の利用枠を少し使う。

## 自動更新

- Mac の launchd（`~/Library/LaunchAgents/jp.hedficr.keizai-tsunagari.update.plist`）が、毎日 7:00・12:00・18:00 に `tools/auto_update.py` を動かす。Mac が眠っていた時刻の分は、起きたときに1回まとめて動く。
- 動かす場所は `~/Library/Application Support/keizai-app/repo`（GitHub の写し。毎回 GitHub の最新にそろえるので、手で直さない）。記録は `~/Library/Logs/keizai-app/update.log`。
- 流れ：最新のコードにそろえる → 集める → 読み解く → `data/` だけをコミットして push → GitHub Pages が1分ほどで反映。
- 読み解きに失敗した回は、公開中の版をそのまま残す。
- 止めるとき：`launchctl bootout gui/$(id -u)/jp.hedficr.keizai-tsunagari.update`。今すぐ1回動かすとき：`launchctl kickstart gui/$(id -u)/jp.hedficr.keizai-tsunagari.update`。

## 集める元を変える

`tools/sources.json` に1行足す。`rss`（URL）、`gnews`（Google ニュースの検索語）、`youtube`（チャンネルID）。

## 手元で開く

`/opt/homebrew/bin/python3 -X utf8 _work/devserver.py 8790` → http://localhost:8790/

## 気をつけていること

- 記事の本文は取り込まない。見出し・媒体名・リンクと、AI が自分の言葉で書いた要点だけを持つ。
- 見通しは「〜かもしれない」で書かせ、売買のすすめはしない。
- 日経平均の数値データ（日経の公式 CSV）は転載禁止なので使っていない。
- X（旧Twitter）は有料 API が必要なため、いまは取り込んでいない。
