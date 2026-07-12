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

### 大原則(必ず守る)

- **破壊的・重い副作用の前は要約して確認を取る**: 1.5GB のモデルダウンロード、
  `brew install` / `apt install`、`.env` への書き込み、`config.yaml` の編集。
- **ユーザーの収録データ・編集ファイルには一切触れない**。これは環境構築だけ。
  `approve` / `render` / `plan --force` などは**絶対に実行しない**(承認は人間の仕事。
  詳細は `AGENTS_CONTRACT.md` の承認境界)。
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

### ステップ 7 — 検証(緑になるまで)

```sh
# AI provider の疎通(text / structured / image)
node src/cli.ts ai doctor
```

- `ai doctor` が通れば LLM 経路は OK。落ちたらメッセージに従って provider/キー/認証を直す。
- ここまでで **ffmpeg・whisper・モデル・Node・provider** が揃ったことを、ステップ 2–6 の
  検査結果として**チェックリスト形式で要約**してユーザーに提示する。
  > 補足: 環境全体を一括検査する `cutflow doctor` はロードマップ上の施策
  > (`docs/reviews/2026-07-12-adoption-onboarding-diagnosis.md` §4.1)。存在すれば
  > `node src/cli.ts doctor` を優先して使い、無ければ上記の個別検査で代替する。

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

1. 各前提の ✓ / ⚠ / 未導入(理由付き)。
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
