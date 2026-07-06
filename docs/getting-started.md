# cutflow をはじめて使う人へ

OBS で録った1本の動画を、文字起こし → カット案 → **人間の承認** →
最終レンダーまで通す一連の流れを、**このページだけ読めば一通り動かせる**
ようにまとめたガイドです。

- コマンドで動かす人 → [1. セットアップ](#1-セットアップ最初の1回だけ) →
  [2. クイックスタート](#2-クイックスタート最短の流れ) →
  [4. コマンド一覧](#4-ユーザーが起動するコマンド一覧)
- GUI で編集したい人 → [6. GUI エディタ](#6-gui-エディタの起動と使い方)
- AI(Claude Code)に編集させる人 → [7. AI に編集させるときの仕様](#7-ai-claude-code-に編集させるときの仕様)

---

## 0. これは何をするツールか

**収録1本 = 1フォルダ**(例: `~/Movies/cutflow/2026-07-02-my-recording/`)。
その中に置いた raw 動画(OBS 出力)を入力に、以下を順に作ります。

```
OBS収録 (raw.mp4/mkv)
  │
  ├─ ingest      映像解析・マイク音声抽出        → manifest.json
  ├─ transcribe  whisper.cpp で文字起こし        → transcript.json / .srt
  ├─ detect      無音検出(決定的・LLM不使用)    → cuts.auto.json
  ├─ plan        LLMで意味カット・章立て          → cutplan.json / chapters.json / meta.json
  │
  ├─ ★ 人間が preview / GUI で確認 → cutplan を修正 → 承認(approved: true)
  │
  └─ render      Remotion で合成                  → cut.mp4(中間)→ final.mp4
```

大事な考え方が3つあります。

1. **自動処理は最初の1回(`run`)だけ。以降は人間が JSON を育てる。**
   「全部 AI 任せ」ではなく、AI のカット案を叩き台に人間が仕上げるツールです。
2. **編集するのはコードではなく、収録フォルダ内の JSON。** 動画ファイル自体は
   触りません。
3. **時刻はすべて「元収録(raw)の秒」で書く。** カット後の秒への換算はツールが
   自動でやるので、頭の中で引き算しないこと。

---

## 1. セットアップ(最初の1回だけ)

必要なもの: macOS / Node.js 23.6+ / Homebrew

```sh
brew install ffmpeg whisper-cpp
mkdir -p ~/Models/whisper
curl -L -o ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
npm install
```

- 文字起こし・無音検出は**完全ローカル(無料)**。
- LLM を使うのは `plan`(意味カット・章立て)だけ。**デフォルトは `claude` CLI**
  (Claude Code のサブスクで動く / API キー不要)。従量課金 API を使う場合は
  `.env` に `ANTHROPIC_API_KEY` を置き、`config.yaml` の `llm.backend: api` と
  `llm.model` を設定します。
- 設定はすべて [`config.yaml`](../config.yaml)(収録レイアウト・無音判定の閾値・
  whisper モデル・LLM バックエンド・ワイプ/字幕サイズ・音量など)。コードに
  ハードコードされた設定はありません。
- OBS 側の収録設定は [recording-guide.md](recording-guide.md) を参照
  (**キャンバス 3840×1080・左に画面/右にカメラを並べる「拡張キャンバス方式」**が前提)。

---

## 2. クイックスタート(最短の流れ)

```sh
# 収録フォルダを用意(OBS の出力 mkv/mp4/mov を1本入れる)
#   ~/Movies/cutflow/2026-07-02-my-recording/xxxx.mkv

# ① 承認ゲートまで一括実行(ingest → transcribe → detect → plan)
node src/cli.ts run ~/Movies/cutflow/2026-07-02-my-recording

# ② 確認&編集(どちらか)
node src/cli.ts editor  ~/Movies/cutflow/2026-07-02-my-recording   # GUI(推奨)
node src/cli.ts preview ~/Movies/cutflow/2026-07-02-my-recording   # 軽い確認動画だけ

# ③ 問題なければ cutplan.json の "approved" を true に(GUI なら「承認済み」チェック)

# ④ 最終レンダー
node src/cli.ts render ~/Movies/cutflow/2026-07-02-my-recording
```

> `node src/cli.ts <cmd>` は `npm run cutflow -- <cmd>` でも同じです。
> エディタは `npm run editor -- <dir>` でも起動できます。

---

## 3. どのファイルが何を決めるか

編集対象は収録フォルダ内のこの5つ。**時刻は全部「元収録の秒」。**

| ファイル | 決めるもの |
|---|---|
| `cutplan.json` | **どこを残すか**。`segments[]` の `action: "keep"/"cut"`(keep は時系列順・重なり禁止)。`approved` の承認フラグもここ |
| `transcript.json` | **テロップ**の文言・表示時間。`track`(トラック番号)/ `pos`(`{x,y}` 出力px)/ `style`(`fontSizePx`・`color`・`outlineColor`(`"none"`で縁なし)・`fontFamily`・`fontWeight`・`background`(座布団))は省略可で個別上書き |
| `overlays.json` | **演出**。`overlays`(素材の全画面表示)/ `inserts`(インサート編集)/ `wipeFull`(ワイプ全画面)/ `hideCaption` / `layerOrder`(重なり順)/ `captionTracks`(トラックの標準位置・スタイル) |
| `chapters.json` | YouTube 概要欄チャプター(`start`/`title`)。**動画には描画されない** |
| `meta.json` | タイトル案・概要欄の下書き。**動画に影響なし** |

**触ってはいけない中間生成物**(再実行で上書きされる):
`manifest.json` / `cuts.auto.json` / `plan.raw.txt` / `render.props.json` /
`whisper-out.*` / `cut.mp4` / `preview.mp4` / `proxy.mp4` / `frames/*.png`。
`backups/`(上書き前の退避)と `.editor-draft.json`(GUI の未保存編集の自動退避)も触らない。

素材(B-roll 等)は `materials/` に置いて相対パスで参照。BGM は収録フォルダ直下の
`bgm.mp3`(置くだけで自動ループ・終端フェード・発話中ダッキング付きで合成)。

---

## 4. ユーザーが起動するコマンド一覧

すべて `node src/cli.ts <コマンド> <収録フォルダ>` の形。

| コマンド | 何をするか | 使う場面 |
|---|---|---|
| `run <dir>` | ingest→transcribe→detect→plan を一括実行(承認ゲートまで) | **収録直後の1回だけ**。2回目以降は `--force` 必須(実行前に `backups/` へ退避) |
| `ingest <dir>` | 映像解析・マイク音声抽出 → manifest.json | config を変えて部分的にやり直すとき |
| `transcribe <dir>` | whisper で文字起こし → transcript.json / .srt | 再実行はテロップ手編集を上書き(既存は backups/ へ退避) |
| `detect <dir>` | 無音検出 → cuts.auto.json(決定的・LLM不使用) | `detect.silenceDb` 調整後など |
| `plan <dir>` | LLM で意味カット・章立て・タイトル案 | プロンプト改良後など。**上書き注意**(2回目以降は `--force` 必須) |
| `remeta <dir>` | 章立て・タイトル案・概要欄だけ作り直す(**cutplan は触らない**) | カットを手編集済みで、概要欄/章だけ再生成したいとき |
| `preview <dir>` | keep 区間を繋いだ確認用の軽い動画 → preview.mp4 | カットのテンポ確認。`approved` false でも動く |
| `editor <dir>` | GUI エディタをブラウザで起動 | カット・テロップ・演出を視覚的に編集(→ [6章](#6-gui-エディタの起動と使い方)) |
| `validate <dir>` | 編集した JSON の整合性検査(エラーで exit 1) | **JSON を編集したら毎回** |
| `describe <dir>` | タイムラインのテキスト要約(元秒⇔出力秒対応) | 全 JSON を読む前の把握 |
| `frames <dir> --t 90,2:30` | 指定時刻を**最終合成の見た目**で PNG 出力 | テロップ位置・ワイプ被りの目視確認(主に AI 用) |
| `render <dir>` | 最終レンダー → cut.mp4 → final.mp4 | **`approved: true` が必須**(承認ゲート) |

再実行ガード: 生成物が既にある状態で `plan` / `run` を再実行するには `--force` が
必要で、その際も手編集ファイル一式が `backups/<日時>/` へ自動退避されます
(**自分の判断で `--force` を付けない**)。

---

## 5. 人間が編集する場合の仕様

正しい使い方は「**`run` は1回だけ → 以降 ③編集 ↔ ④確認 を往復 → 承認 → render**」。

```
① 収録 → ~/Movies/cutflow/<日付-内容>/ に動画を置く
② node src/cli.ts run <dir>          自動部分を一括(ここまでで承認ゲート手前)
③ 編集タイム(3章の表のファイルを直す) ── GUI か JSON 直接編集
④ preview か GUI で確認 → 気に入らなければ ③④ を往復
⑤ cutplan.json の "approved" を true に(= 承認)
⑥ node src/cli.ts render <dir>        final.mp4 完成
   → テロップだけ直したくなったら transcript.json を編集して ⑥ だけ再実行(速い)
⑦ meta.json / chapters.json を YouTube 投稿に使う
```

編集手段は2つ。どちらを使ってもよく、混在もできます(GUI 起動中に JSON を
直接編集すると、保存された変更はホットリロードで GUI に反映されます)。

- **GUI エディタ**(→ [6章](#6-gui-エディタの起動と使い方)):カット境界のドラッグ、
  テロップの配置・スタイル、素材の挿入、承認、プレビュー生成・レンダーまで完結。
- **JSON 直接編集**:3章の表のファイルをエディタで直接書き換える。
  編集後は **`validate` を必ず実行**。

### 人間が特に気をつけること

- **承認は人間の仕事。** preview か GUI で確認して初めて `approved: true` にする。
- **⚠️ `plan` / `run` を再実行するとカットとタイトル/章立てが上書きされる。**
  手編集を始めたら再実行しない。概要欄・章だけ作り直したいなら `remeta` を使う
  (cutplan は触らない)。
- **収録ゲインが低すぎると発話が無音カットされる**ことがある。OBS のメーターで
  普通に喋って黄色ゾーン(-20〜-10dB)を目安に。最終音量は自動で -14 LUFS に
  正規化されるので、収録音量の多少のばらつきは気にしなくてよい。

---

## 6. GUI エディタの起動と使い方

### 起動

```sh
node src/cli.ts editor ~/Movies/cutflow/2026-07-02-my-recording
# または:  npm run editor -- ~/Movies/cutflow/2026-07-02-my-recording
```

- 起動すると `http://127.0.0.1:4310` を案内するので、ブラウザで開く
  (ポートは環境変数 `PORT` で変更可)。**終了は Ctrl+C**。
- 初回に**軽量プロキシ `proxy.mp4`**(元収録を縮小したもの)を1回だけ生成します
  (数十秒)。プレビューはこのプロキシを **keep 区間に従って飛び飛び再生**するので、
  **カット境界を編集してもファイル再生成なしで即反映**されます(本物の NLE と同じ方式)。

### 画面の構成

- **上・左** … タブパネル(「素材」/「テロップ」/「プロパティ」)
- **上・右** … プレビュー。**最終レンダーと同じ合成**(画面クロップ+ワイプ+
  テロップ+素材)を再生する
- **下** … タイムライン(クリップ・素材・テロップの各トラック)
- **ヘッダー** … 「承認済み」チェック / 「プレビュー生成」/「レンダー」

### 主な操作

| やりたいこと | 操作 |
|---|---|
| カットを詰める/戻す | タイムラインのクリップをドラッグで移動、端をつまんでトリム |
| クリップ/素材/テロップを消す | 選択して **Delete** |
| テロップの文言を直す | 「テロップ」タブで一覧から選んでその場で編集 |
| テロップの位置を動かす | プレビュー上で直接ドラッグ、または「プロパティ」タブの `pos` |
| テロップの色・サイズ・フォント・座布団 | 「プロパティ」タブ |
| 素材(B-roll)を入れる | 「素材」タブで「素材を読み込む…」→ タイムラインへドラッグ(**素材トラック=配置 / 映像トラック=インサート**)。ダブルクリックでも配置 |
| 素材の位置・サイズを変える | 部分配置(rect あり)なら**プレビュー上で枠をドラッグして移動・四隅/辺のハンドルでリサイズ**(その素材が再生ヘッド上にあるとき)。全画面のときは「プロパティ」タブのプリセット(左上/中央 等)で枠を作ってから微調整。数値直打ちも同タブ |
| タイムラインの吸着(マグネット) | クリップの移動・左右トリムで隣のクリップ境界・再生ヘッド・0/末尾に吸い付く。ツールバーの磁石ボタンで ON/OFF、**ドラッグ中に ⌘/Ctrl を押すと一時反転**(OFF でも吸着 / ON でも自由移動) |
| トラックの重なり順を変える | トラックのラベルを上下にドラッグ |
| 保存 | **⌘S**(正のデータ=JSON への書き込みは手動保存だけが行う) |
| 元に戻す | **⌘Z** |

- **プレビューの音量・ループ・トラックミュート・レイヤーの目トグルは
  「見え方/聞こえ方」だけの調整で、書き出しには影響しません。**
- 未保存のまま閉じる/リロードするとブラウザが確認を出し、クラッシュ時の保険として
  `.editor-draft.json` に自動退避されます(次回起動時に復元するか選べる)。

### ヘッダーの3つのコントロール

- **「承認済み」チェック** … `cutplan.json` の `approved` を切り替える。
  render の実行に必須。
- **「プレビュー生成」** … `preview.mp4` を作る軽い確認動画。テロップ・演出は
  焼き込まない。`approved` 不要。
- **「レンダー」** … 完成品 `final.mp4` を作る。フル解像度でクロップ+ワイプ+
  テロップ+素材+BGM を合成。**「承認済み」にチェックが無いと押せない**
  (サーバー側でも承認ゲートで弾かれる)。完了すると Finder で開く。

いずれのボタンも、未保存の編集があれば**自動保存してから**走ります。重い処理
(プレビュー生成/レンダー)は同時に1つだけ。

---

## 7. AI(Claude Code)に編集させるときの仕様

このリポジトリで Claude Code に「動画を編集して」と頼むと、AI は**コードではなく
収録フォルダの JSON を編集**します。AI が守る決まり:

- **編集 = `cutplan.json` / `transcript.json` / `overlays.json` / `chapters.json` /
  `meta.json` の編集。** 動画ファイルは触らない。時刻は元収録の秒。
- **編集したら必ず `node src/cli.ts validate <dir>` を実行**し、エラーを直してから進む
  (preview/render で数分かけて気づく壊れ方を数ミリ秒で検出できる)。
- **`plan` と `run` は再実行禁止**(手編集が LLM 生成物で上書きされる)。カットを
  保ったまま章立て・タイトル・概要だけ作り直すときは `remeta`。**自分の判断で
  `--force` を付けない。**
- **`approved` を自分で true にしない**(承認は人間の仕事)。
- 中間生成物・`backups/`・`.editor-draft.json` は編集しない。

### AI が動画の中身を「見る」方法

Read で JSON を全部読む前に、まずこれらで把握します。

- `transcript.json` … 何をいつ喋っているか(内容把握と時刻特定の主ソース)
- `cutplan.json` … どこが残り/切られたか(`reason` 付き)
- `node src/cli.ts describe <dir>` … タイムライン要約(元秒⇔出力秒の対応付き)
- `node src/cli.ts frames <dir> --t 90,2:30.5` … 指定時刻を**最終合成と同じ見た目**で
  `frames/*.png` に出し、Read で画像を見てテロップ位置・ワイプ被りを自己確認
  (`--captions` で全テロップ1件1枚、`--every 10` でカット後を10秒間隔サンプル)
  - `frames/` の古い PNG は実行のたびに全削除される。**JSON を編集したら撮り直す**
    (古い PNG を見ると編集前の絵を見ることになる)
  - ベースはプロキシのアップスケールなので、位置・被りの確認には十分だが、
    **画面内の細かい文字の可読性はこの画像では判断できない**(最終判断は人間が
    preview/render で行う)

### AI の基本ループ

```
JSON 編集 → validate → describe か frames で自己確認 → 人間には preview / GUI で見てもらう
```

---

## 8. 困ったときは

- **`whisper モデルが見つかりません`** → [1章](#1-セットアップ最初の1回だけ)のモデル
  ダウンロードをやり直す(パスは `config.yaml` の `whisper.model`)。
- **`マイクトラックが見つかりません`** → `config.yaml` の `ingest.micTrack` /
  `systemTrack`(OBS のトラック番号、1始まり)を収録に合わせる。
- **`approved が false です` で render が止まる** → 承認ゲート。preview/GUI で確認して
  `approved: true` にする。
- **手編集が消えた** → `backups/<日時>/` から収録フォルダ直下へコピーで復元。
- **render が「切りすぎ」** → 発話が無音カットされている可能性。`config.yaml` の
  `detect.silenceDb` を下げて `detect`→ cutplan を作り直すか、cutplan を手で直す。
- **見た目(ワイプ/字幕サイズ/テロップ既定の色・フォント)を変えたい** →
  GUI エディタの設定画面(ヘッダーの「設定」/ ⌘,)。実体は `config.yaml` の
  `render` セクション。デザインそのものは `remotion/Main.tsx`。
  `npx remotion studio` でレイアウト確認。

より詳しい運用は [usage.md](usage.md)(人間が調整しながら使うワークフロー)を
参照してください。
