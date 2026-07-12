# SETUP_WITH_AI — AI エージェントに環境構築を任せる

このリポジトリを **AI コーディングエージェント(Claude Code など)に渡して、
CutFlow の実行環境を自動でセットアップさせる**ための指示書です。

## 使い方(人間向け)

クローン後、エージェントにこう言うだけ:

> **「`SETUP_WITH_AI.md` を読んで、その手順どおりに CutFlow のセットアップをして。
> 大きなダウンロードやインストールの前は必ず確認して。」**

エージェントが無い場合は、このファイル全体をそのまま AI(Claude 等)に貼り付けても
同じ手順を案内させられます。手で最短導入したい場合は
[docs/getting-started.md](docs/getting-started.md) の「1. セットアップ」を参照。

---

## エージェントへの指示(この節を実行する)

あなたは CutFlow の環境をセットアップするエージェントです。以下を **順に・冪等に**
実行してください。**各ステップは「まず検査 → 足りなければ導入」**。既に満たされている
項目は再実行しないこと。

### セットアップの骨格 — `doctor --json` を背骨にする

このセットアップは **`node src/cli.ts doctor --json` の出力を機械可読に読み、
落ちている項目を下の「remediation 表」に従って直し、緑になるまで繰り返す**
収束ループです。ステップ1〜6は「直し方(導入・設定)の手順書」、
ステップ7が「ループそのもの」です。まず全体像:

1. `node src/cli.ts doctor --json --no-ai` を実行し、標準出力の JSON を解析する
   (`--no-ai` は環境が緑になるまでネットワークを省く高速パス)。
2. `report.checks[]` を走査する。各要素の `name` を **remediation 表(§ステップ7)** に引き、
   `status` が `"error"`(必須)/ `"warn"` の項目に、その表の「直し方」を適用する。
   **重い/破壊的な操作(モデル DL・`brew`/`apt install`・`.env`/`config.yaml` 編集)の前は必ず確認を取る**。
3. 直したら `doctor --json --no-ai` を**再実行**して差分を確認する。`report.exitCode` が `0`
   (= 必須チェックが全て `ok`)になるまで 2–3 を繰り返す。
4. 必須が緑になったら、AI を使うなら最後に一度だけ `node src/cli.ts doctor --json`
   (`--no-ai` 無し=AI 到達性も見る)を実行し、`report.ai` を remediation 表の `ai:*` 行で直す。
5. `warn`(encoder / whisper.bin / whisper.model / ai)は **exit 0 を妨げない任意項目**。
   ユーザーが「文字起こしは使わない」「まず LLM 無しで試す」等と言った範囲では**残してよい**
   (残した理由を完了報告に書く)。緑=required が全て ok = `exitCode: 0`。

**判定の唯一の真実は `doctor` の `exitCode`(と `checks[].status`)であり、あなたの主観ではない。**
各修正の効果は必ず doctor 再実行で確認する(握りつぶさない)。

### 大原則(必ず守る)

- **破壊的・重い副作用の前は要約して確認を取る**: 1.5GB のモデルダウンロード、
  `brew install` / `apt install`、`.env` への書き込み、`config.yaml` の編集。
- **ユーザーの収録データ・編集ファイル・承認レコードには一切触れない**。これは環境構築だけ。
  次を**絶対に実行/書き込みしない**: `approve` / `unapprove` / `render` / `plan` / `plan --force`
  / `run` などの生成・承認・レンダー系コマンド、`cutplan.json` 等の編集ファイル、`approvals.json`
  (承認レコード=第3カテゴリ)、中間生成物・キャッシュ。**承認と render は人間の行為**であり、
  `cutplan.approved: true` を書くだけでは render は通らない(実ゲートは `approvals.json` の hash 束縛レコード)。
  境界の正典は `AGENTS_CONTRACT.md` **§5 The approval boundary**。セットアップで書き換えてよいのは
  環境系ファイル(`.env` / `config.yaml`)と、導入するツール・モデルだけ。
- **各コマンドの出力を読み、失敗したら止まって原因を説明する**。握りつぶさない。
- 最後に**検証コマンドが緑になること**まで見届ける。

### ステップ 1 — プラットフォーム判定

`uname`(mac/Linux)または OS 情報から `darwin` / `linux` / `windows` を判定し、
以下の分岐に使う。**macOS 以外では次の 2 点をユーザーに明示する**:

- 画面 OCR(`frames --ocr` / plan の OCR)は **Apple Vision 依存で使えない**
  (自動でスキップされるので他機能は動く)。
- 既定のビデオエンコーダ `videotoolbox` は **macOS 専用**。非 mac では
  **ステップ 6 で `config.yaml` を `libx264` に寄せる**(これをやらないと初手
  `editor` の proxy 生成で ffmpeg エラーになる)。

### ステップ 2 — Node.js(必須・≥ 23.6)

```sh
node --version
```

- `v23.6.0` 未満 なら **停止**して案内: CutFlow は TypeScript を type-stripping で
  直接実行するため **Node 23.6 以上が必須**。`nvm install 23 && nvm use 23`(nvm)
  や公式インストーラを提案する。**古い Node のまま先へ進まない**(TS 構文エラーで
  中盤まで気づけないため)。
- 満たしていれば次へ。

### ステップ 3 — 外部バイナリ(ffmpeg / whisper.cpp)

```sh
ffmpeg -version        # 無ければ導入
whisper-cli --help     # 無ければ導入(config.yaml の whisper.bin 既定 = whisper-cli)
```

- **macOS**: `brew install ffmpeg whisper-cpp`(実行前に確認)。
- **Linux**: `ffmpeg` はディストロのパッケージ(例 `apt install ffmpeg`)。
  `whisper.cpp` はパッケージが無ければ公式手順でビルドし、生成される CLI を
  PATH に置くか `config.yaml` の `whisper.bin` を実バイナリ名に合わせる。
- **Windows**: ffmpeg / whisper.cpp を導入し PATH を通す(WSL2 推奨)。
- `ffmpeg -encoders` を確認し、非 mac なら **`libx264` が使えること**を保証する
  (ステップ 6 で使う)。

### ステップ 4 — whisper モデル(文字起こしに必要・≈1.5GB)

`config.yaml` の `whisper.model`(既定 `~/Models/whisper/ggml-large-v3-turbo-q5_0.bin`)の
実在を確認:

```sh
ls -lh ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
```

無ければ **ダウンロード容量(≈1.5GB)を伝えて確認**してから:

```sh
mkdir -p ~/Models/whisper
curl -L -o ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

- **「文字起こし(`transcribe`)は使わず、GUI でカット編集だけしたい」場合はスキップ可**
  と伝える(その場合 `plan`/`transcribe` は使えないが editor/render は動く)。
- パスを変えたいユーザーには `config.yaml` の `whisper.model` を案内。

### ステップ 5 — 依存インストール

```sh
npm install
```

ネイティブビルドは無いので通常すぐ終わる。失敗したらエラーを読んで報告。

### ステップ 6 — AI provider の設定(意味カット `plan` に必要)

`plan` / `remeta` / `plan-shorts` などは LLM を使う。ユーザーにどれを使うか聞く:

| provider | 前提 | 設定 |
|---|---|---|
| **claude-code**(既定) | `claude` CLI 導入 + ログイン済み | `claude --version` と認証を確認。API キー不要 |
| **anthropic** | `ANTHROPIC_API_KEY` | `.env` にキー、`config.yaml` の `ai.provider: anthropic` と `ai.model` |
| **openai** | `OPENAI_API_KEY` | `.env` にキー、`config.yaml` の `ai.provider: openai` と `ai.model` |
| **codex**(実験的) | Codex CLI 認証 | `ai.provider: codex` |

- **API provider を選んだら** `.env`(`.env.example` を雛形に)へキーを書き、
  `config.yaml` の `ai.provider` / `ai.model` を編集する。**編集前に差分を要約して確認。**
- **文字起こし・無音検出・レンダーは LLM 不要**。「まず LLM 無しで試す」も選べると伝える。

**このステップで同時にやる — 非 mac のエンコーダ既定**: プラットフォームが
macOS 以外なら、`config.yaml` の `preview.videoEncoder` を **`libx264`** にする
(既定の `videotoolbox` は非 mac の ffmpeg に存在せず初手で失敗するため)。**編集前に確認。**

### ステップ 7 — 検証(`doctor` が緑になるまで回す)

環境全体は **`doctor`** が1コマンドで検査する(読み取り専用。収録フォルダ不要・config.yaml だけ読む)。
これがこのセットアップの**合否判定**であり、緑=必須チェックが全て `ok`(`exitCode: 0`)。

```sh
node src/cli.ts doctor --json --no-ai   # 環境(node/ffmpeg/ffprobe/config/encoder/whisper)を JSON で
```

標準出力は純 JSON(`DoctorReport`)。次を読む:

- `report.exitCode` … `0` なら必須は緑、`1` なら必須欠落あり。
- `report.checks[]` … `{name, status, required, detail}` の配列。`status` が `"error"`(必須)/`"warn"` の
  `name` を下の表に引いて直す。`detail` に具体(見つからないパス・非対応の理由)が入る。
- `report.ai` … 配列(profile ごと)か `{skipped}`。`--no-ai` の間は `{skipped:"--no-ai"}`。
  AI を使うなら required 緑のあと `--no-ai` を外して再実行し、この配列を `ai:*` 行で直す。

#### remediation 表(`checks[].name` → 直し方)

| name | required | この status が出たら | 直し方(**重い/破壊的操作は事前確認**) |
|---|---|---|---|
| `node` | ✅ | `error` | Node が 23.6 未満(型ストリッピング要件)。`nvm install 23 && nvm use 23` か公式インストーラで **23.6+** に上げる。古い Node のまま先へ進めない(TS 構文エラーで中盤まで気づけない)。**ステップ2の詳細**。 |
| `ffmpeg` | ✅ | `error` | PATH に `ffmpeg` が無い。mac: `brew install ffmpeg`。Linux: `apt install ffmpeg`(等ディストロのパッケージ)。Windows: 導入して PATH を通す。**ステップ3**。 |
| `ffprobe` | ✅ | `error` | 通常 `ffmpeg` と同梱。`ffmpeg` を入れれば解消する。別配布の環境では ffprobe を PATH に置く。**ステップ3**。 |
| `config` | ✅ | `error` | `config.yaml` の**ロード/パース失敗**。`detail` に例外メッセージが入るので、それに従って YAML を直す(インデント・重複キー・型)。壊した覚えが無ければ `git status` で差分を確認し、素の `config.yaml` に戻す。 |
| `encoder` | — | `warn` | 有効エンコーダが `ffmpeg -encoders` に無い。**非 mac は A2 により未設定なら自動で `libx264`** になるので通常出ない。出た場合: `config.yaml` の `preview.videoEncoder` を、その環境の `ffmpeg` が持つエンコーダ(`ffmpeg -encoders` で確認。非 mac は `libx264`)に合わせる。**編集前に差分を確認**。**ステップ6**。 |
| `whisper.bin` | — | `warn` | `config.yaml` の `whisper.bin`(既定 `whisper-cli`)が PATH に無い。文字起こしを使うなら mac: `brew install whisper-cpp`、Linux: パッケージ or 公式手順でビルドし、CLI 名を `whisper.bin` に合わせる。**使わない(GUI カット編集だけ)ならこの warn は残してよい**。**ステップ3**。 |
| `whisper.model` | — | `warn` | `config.yaml` の `whisper.model`(既定 `~/Models/whisper/ggml-large-v3-turbo-q5_0.bin`)が不在。文字起こしを使うなら **DL 容量 ≈1.5GB を伝えて確認**してからステップ4の `curl` で取得。**使わないなら残してよい**。**ステップ4**。 |
| `ai:<profile>` | — | `warn`/`error`(表示は warn 扱い) | `report.ai[]` の各 profile。`checks.config` NG=`config.yaml` の `ai:` 設定不備、`checks.credential` NG=キー未設定/未ログイン(`claude-code` なら `claude` 未ログイン、`anthropic`/`openai` なら `.env` のキー欠落)、`checks.text/structured/image` NG=provider 未到達。直し方は**ステップ6**の provider 表。**まず LLM 無しで試すなら残してよい**。 |

#### ループの終了条件

- **必須が緑**: `report.exitCode === 0`(= `node`/`ffmpeg`/`ffprobe`/`config` が全て `ok`)。ここで **editor は動く**。
- **任意項目**: `encoder`/`whisper.*`/`ai:*` の warn は、ユーザーの利用意図(文字起こし・LLM を使うか)に応じて直すか残すか決める。
  残す場合は完了報告に「◯◯は未導入(理由)」と明記する。
- 直すたびに `doctor --json`(または `--no-ai`)を**再実行**して差分を確認する。**主観で「直ったはず」と判断しない**。

### ステップ 8 — スモークテスト(任意・推奨)

ユーザーに収録動画があれば、それを使って**壊さない範囲**で疎通を見せる:

```sh
# 収録フォルダ(中に動画1本)を用意してもらい、GUI で開くだけ(全編 keep・非破壊)
node src/cli.ts editor <収録フォルダ>
```

- 初回は `proxy.mp4` 生成に数十秒、**初 render は headless Chrome を自動 DL(数分)**
  する旨を先に伝える(沈黙時間で不安にさせない)。
- 動画がまだ無ければ、スマホや画面録画の短いクリップ1本でも `plain` レイアウトで
  そのまま開ける、と案内する(OBS は必須ではない)。

### 完了報告

最後に以下を1つのメッセージで:

1. `doctor` の最終状態(`exitCode` と、各 `check` の ✓ / ⚠ / 未導入 を理由付きで)。
2. 選んだ AI provider と、非 mac なら加えた `libx264` 設定。
3. 次の一歩(`editor <dir>` で開く → 編集 → 承認 → `render`)。詳細は
   [docs/getting-started.md](docs/getting-started.md)。
4. **承認と render はユーザーの操作である**ことの明示。

---

## トラブル時の早見(エージェント・人間共通)

- `コマンド 'claude' が見つかりません` → provider が `claude-code` だが CLI 未導入/未ログイン。
  `claude` を入れてログインするか、`config.yaml` を `anthropic`/`openai`/`codex` に。
- `whisper モデルが見つかりません` → ステップ 4 のパス/DL を確認(`config.yaml` `whisper.model`)。
- 非 mac で proxy/preview が ffmpeg エラー → `config.yaml` `preview.videoEncoder: libx264`。
- TS 構文エラーで即死 → Node が 23.6 未満(ステップ 2)。
- `マイクトラックが見つかりません` → `config.yaml` `ingest.micTrack`/`systemTrack` を収録に合わせる。

より詳しい運用は [docs/usage.md](docs/usage.md) を参照。
