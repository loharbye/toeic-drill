# TOEIC 毎日ドリル（第1段階）

TOEIC L&R で 930 点以上を取るための、毎日 5〜10 分の練習アプリ。速さより **精度** と **語彙の定着** を重視。

## 第1段階でできること

- 1日のセッション：語彙 10問 → Part 5 12問 → ミス復習（上限 15問）
- Part 5：回答 → 確信度（確実 / 迷った / 勘）→ 解説・引っかけポイント → 不正解ならミス原因を選ぶ
- ミス復習：不正解・迷った・勘の問題を 1日後 → 3日後 → 7日後に再出題。3回連続「確実」で正解すると復習から外れる
- 語彙：3形式（意味 / 空欄 / 言い換え）。正解ごとに 1 → 3 → 7 → 14 → 30日後へ、不正解なら 1日後に戻る
- 途中で閉じても続きから再開（日付が変わったらその日の新しいセッションになる）
- ホームに「今月の実施日数」とカレンダー（連続日数は表示しない）
- 設定：1日の問題数、記録の書き出し・読み込み（JSON）、全消去
- PWA：ホーム画面に追加でき、オフラインでも動く

## ファイル構成

```
index.html             画面の土台
css/style.css          スタイル（ダークモード対応）
js/app.js              アプリ本体
sw.js                  オフライン用 Service Worker
manifest.webmanifest   PWA 設定
data/part5.json        Part 5 問題（現在 60問：文法36・語彙24）
data/vocab.json        語彙（現在 100語）
icons/                 アプリアイコン
tools/check_data.py    問題データの形式チェック
tools/make_icons.py    アイコン生成
```

## 手元で動かす

`fetch` でデータを読むので、ファイルを直接開くのではなくローカルサーバーで開く。

```sh
cd ~/toeic-drill
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

## GitHub Pages で公開する

1. GitHub で新しいリポジトリを作る（例：`toeic-drill`、Public）
2. このフォルダを push する
   ```sh
   cd ~/toeic-drill
   git init && git add . && git commit -m "第1段階"
   git branch -M main
   git remote add origin https://github.com/<ユーザー名>/toeic-drill.git
   git push -u origin main
   ```
3. リポジトリの **Settings → Pages** で、Source を「Deploy from a branch」、Branch を `main` / `/ (root)` にして保存
4. 数分後に `https://<ユーザー名>.github.io/toeic-drill/` で開ける

### スマホのホーム画面に追加

- iPhone（Safari）：共有ボタン → 「ホーム画面に追加」
- Android（Chrome）：メニュー → 「ホーム画面に追加」／「アプリをインストール」

## 更新するとき

- ファイルを変更したら、`sw.js` の `CACHE_VERSION` を上げる（例：`v1` → `v2`）。
  スマホ側では、アプリを開いたときに裏で更新され、**次に開いたときから**新しい版になる。

## 問題を追加するとき

1. `data/part5.json` / `data/vocab.json` に追記する（id は連番で重複させない）
2. チェックを実行する
   ```sh
   python3 tools/check_data.py --balance   # 形式チェック＋Part 5 の正解位置を A〜D に均等化
   ```
3. 正解が1つに決まるかは、Claude Code に別途レビューを依頼する
4. `sw.js` の `CACHE_VERSION` を上げて push

語彙データの補足フィールド（仕様書の形式に追加したもの）:

- `pos`：品詞（verb / noun / adjective / adverb）。誤答の選択肢を同じ品詞からとるために使う
- `distractors`：空欄問題の誤答（文に当てはまらない語を3つ以上）。ないときは同じ品詞の語から自動で選ぶ
- `related`：意味が紛らわしい語。誤答の選択肢に出さない
- 例文 `example` には、見出し語を**そのままの形で**含める（空欄・言い換え問題で使う）

学習記録の各回答には、仕様書の項目に加えて `stage`（vocab / main / review）と、語彙なら `mode` を保存している。

## 記録について

- 記録はブラウザの localStorage に保存される。端末やブラウザを変えると引き継がれないので、設定画面の「書き出す」「読み込む」で移す。
- 1日あたり約 30件の回答記録がたまる。1年で約 1〜2MB の見込み（localStorage の上限はおおむね 5MB）。
