# koto-sodai-auto

江東区の粗大ごみインターネット受付を半自動化するリポジトリです。

## Codex で始める

リポジトリを clone したら、
ルートで `codex` を起動するだけで構いません。

```bash
git clone https://github.com/nakano-tomofumi/koto-sodai-auto.git
cd koto-sodai-auto
codex
```

起動した Codex には、まず次のように伝えてください。

```text
このリポジトリの初期セットアップから予約実行まで進めてください。
必要なら依存関係のインストール、Playwright のセットアップ、ブラウザ smoke test、.env の準備、品目マスタ更新、予約実行まで行ってください。
```

Codex は、必要に応じて `npm install`、
`npx playwright install chromium`、
`node test-browser.js`、
`node update-items.js`、
`node reserve-koto-sodai.js`
を進めます。

ユーザーが入力する必要があるものは次です。

- `.env` 用の個人情報
- 排出品目名
- 数量
- メール認証 URL
- 曖昧な候補が出た場合の選択

`.env`、debug artifacts、trace、screenshots、session files、
`reservation-result.json` は commit しないでください。

## セットアップ

```bash
npm install
env PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright install chromium
cp .env.example .env
```

`.env` に個人情報を設定してください。
`.env` は Git に含めません。

`KOTO_BUILDING` は建物名と部屋番号を連結した文字列で問題ありません。
たとえば `3-101` のような表記は `3号棟 / 101号室` として扱います。

## 品目解決テスト

予約フローの前に、入力された品目を正式なマスタ品目へ解決できます。

```bash
npm run resolve-item -- "オフィスチェアのような椅子"
```

これは Codex wrapper 側で行う前処理の確認用です。
予約スクリプト本体は、正式品目名の完全一致だけを受け付けます。
Codex は `reserve-koto-sodai.js` を起動する前に、
ユーザーの入力を正式品目へ解決してください。
`resolve-item.js` は、その wrapper 側の判断を手元で試すためのローカル用ハーネスです。

## ブラウザ設定

Playwright の同梱 Chromium や Chrome for Testing が macOS で落ちる場合は、
まず別のブラウザや headless への切り替えを試してください。

設定例:

```env
KOTO_BROWSER_CHANNEL=chromium
HEADLESS=true
```

予約フローの前に、
ブラウザ起動だけを確認します。

```bash
node test-browser.js
```

選べる値:

* `chrome`
* `msedge`
* `chromium`
* `firefox`
* `webkit`

## macOS でのブラウザ起動対策

起動時に `EXC_CRASH(SIGABRT)` や `abort() called` が出て、
AppKit / HIServices / `_RegisterApplication` 付近で落ちる場合は、
予約サイトではなくブラウザ起動の問題として扱います。

確認コマンド:

```bash
node test-browser.js
```

起動確認で最初に成功した組み合わせを使ってください。

macOS での推奨設定:

```env
KOTO_BROWSER_CHANNEL=chromium
HEADLESS=true
```

Playwright から headed Chrome を起動すると
macOS 環境によっては落ちることがあります。
その場合は headless で進め、
スクリーンショット、HTML スナップショット、Playwright trace を使って確認してください。

## 実行

通常実行:

```bash
node reserve-koto-sodai.js
```

ドライラン:

```bash
node reserve-koto-sodai.js --dry-run
```

## 実行時の流れ

1. CLI で品目名を入力
2. CLI で数量を入力
3. ブラウザでメールアドレス登録画面まで進行
4. 認証メールを受信後、CLI に認証 URL を貼り付け
5. 品目検索、申込者情報入力、収集日選択へ進行
6. 最終確認画面を検証
7. 問題がなければ予約確定

判断が曖昧な場合、候補が複数ある場合、CAPTCHA や予期しない画面が出た場合は停止します。

## 出力

成功時または停止時に `reservation-result.json` を出力します。

## 注意

- 既定の収集場所は `集合住宅の粗大ごみ置き場` です
- `KOTO_BUILDING` の末尾に `3-101` のような表記がある場合、
  前半を `号棟`、後半を `号室` として分解します
- 最終確認画面の検証に失敗した場合は確定しません
- macOS では `KOTO_BROWSER_CHANNEL=chromium` と `HEADLESS=true` を推奨します
- `HEADLESS=false` は headed mode の検証用です
- headed Chrome がクラッシュする場合は、
  予約サイトではなくブラウザ起動問題として扱います

## デバッグ

失敗時に保存される Playwright trace は次で確認できます。

```bash
npx playwright show-trace debug/traces/trace.zip
```

`debug/` には実行ごとの保存物も残ります。

- `debug/run-YYYYMMDD-HHMMSS/` に主要ステップごとの
  `screenshot`, `HTML`, `title`, `URL`, `visible text`, `controls` が保存されます
- `debug/error-YYYYMMDD-HHMMSS/` に失敗時の同種の情報が保存されます
- まず `title`, `URL`, `visible text`, `controls` を見てから、
  必要なら `screenshot` と `HTML` を確認してください
- デバッグ成果物には個人情報が含まれる可能性があります
- `reservation-result.json` はコミットしないでください

品目マスタは `data/koto-items.json` に置きます。
これは江東区公式PDFから生成した正式品目一覧です。
`item-catalog.json` は予約サイト側のカテゴリ誘導用の補助データとして残します。

このスクリプトは Codex wrapper から、
`data/koto-items.json` に存在する正式品目名を受け取る前提です。
ユーザー入力の意味解釈は wrapper 側で行い、
`reserve-koto-sodai.js` には確定済みの品目名を渡してください。
スクリプト本体はサイト操作に専念します。
`resolve-item.js` は wrapper 側の事前解決結果を手元で確認するための補助テストです。

`.env` は絶対にコミットしないでください。
`.env`、`reservation-result.json`、`debug/` 配下の成果物、trace、
スクリーンショット、local session cache には個人情報が含まれる可能性があります。

`.env.example` の内容は次のとおりです。

```env
KOTO_NAME=山田太郎
KOTO_NAME_KANA=ヤマダタロウ
KOTO_POSTAL_CODE=1350000
KOTO_ADDRESS=東京都江東区...
KOTO_BUILDING=サンプルマンション101
# 建物表記には号棟と部屋番号を含められます。たとえば:
# 3-101 -> 3号棟 / 101号室
# 1-1203 -> 1号棟 / 1203号室
KOTO_PHONE=0312345678
KOTO_EMAIL=example@example.com
KOTO_DEFAULT_DISPOSAL_LOCATION=集合住宅の粗大ごみ置き場
HEADLESS=true
KOTO_BROWSER_CHANNEL=chromium
```

wrapper から渡す場合は `KOTO_RESOLVED_ITEMS_JSON` を使えます。複数品目も渡せます。各要素は `canonicalName` と `quantity` を持つ JSON 配列にしてください。`canonicalName` は `data/koto-items.json` の `item_name` と完全一致させてください。`category` を任意で入れると予約サイト側の選択が安定します。

```bash
KOTO_RESOLVED_ITEMS_JSON='[{"canonicalName":"いす（健康いす、ソファーを除く）","category":"家具・寝具・建具","quantity":1},{"canonicalName":"ペット用品（ペット小屋を除く）","category":"その他","quantity":1}]' node reserve-koto-sodai.js
```
