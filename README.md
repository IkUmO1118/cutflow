# CutFlow

撮影後の編集をエディタ起点で進める、ローカルファーストな動画パイプライン。

手元の動画1本(スマホで撮った縦動画・画面録画・カメラ動画、または OBS 収録)から、
文字起こし → カット案の生成 → **人間の承認** → 最終レンダーまでを CLI で行います。
まず試すだけなら OBS も特別な収録設定も要りません(→ [すぐに触ってみる](#すぐに触ってみるサンプル))。
文字起こしと無音検出は完全ローカル(無料)。LLM を使うのは意味的な
カット判断・章立てのみで、Claude Code のサブスク(`claude` CLI)、
Codex CLI、従量課金 API のいずれでも動きます。
LLM に渡るのは**文字起こしテキスト**(と任意の `brief.md`)だけで、映像・音声・
画面は PC 内に留まります(→ [プライバシー](docs/getting-started.md#データはどこへ行くかプライバシー))。

## パイプライン

```
OBS収録 (raw.mkv)
  │
  ├─ ingest      映像解析・マイク音声抽出          → manifest.json
  ├─ transcribe  whisper.cpp で文字起こし          → transcript.json / .srt
  ├─ detect      無音検出(ffmpeg・決定的)         → cuts.auto.json
  ├─ plan        LLMで意味カット・章立て           → cutplan.json / chapters.json / meta.json
  ├─ preview     カット結果の確認用動画            → preview.mp4
  │
  ├─ ★ 人間が preview を見て cutplan.json を修正・承認(承認ゲート)
  │
  └─ render      Remotion で合成                   → cut.mp4(中間)/ final.mp4
```

各ステージは JSON を読んで JSON を書くだけなので、単独で再実行できます。

## セットアップ

> **セットアップを AI エージェントに任せる場合**: このリポジトリを Claude Code などの
> AI コーディングエージェントに渡しているなら、[SETUP_WITH_AI.md](SETUP_WITH_AI.md) を
> 読ませるだけで、環境チェック(`doctor`)が緑になるまで自動でセットアップさせられます
> (エージェントは環境構築だけを行い、承認・render・収録データには触れません)。
> 手で進める場合は以下。

必要なもの: macOS / Node.js 23.6+ / Homebrew

```sh
brew install ffmpeg whisper-cpp
mkdir -p ~/Models/whisper
curl -L -o ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
npm install
npm link      # `cutflow` コマンドをどこからでも使えるようにする(任意・推奨)
```

> whisper モデルはまず軽い `base`(≈150MB)で即試し、本番で `large-v3-turbo` に上げる
> 2段運用ができます(切替は `config.yaml` の `whisper.model` 1行)。手順は
> [docs/getting-started.md](docs/getting-started.md#whisper-モデルは2段で選ぶまず小さく試す--本番で精度を上げる) を参照。

インストール後、環境が揃っているかは1コマンドで確認できます:

```sh
cutflow doctor
```

### コマンドの2つの入口

`npm link` すると `cutflow <コマンド>` がどこからでも打てます(収録フォルダ側で
作業しているときもリポジトリへ `cd` しなくてよく、Node のバージョン不足も
人間可読なメッセージで弾かれるので、**人間はこちらを使う**のがおすすめ)。

リンクしていなくても、リポジトリのルートから同じことができます:

```sh
cutflow doctor            # npm link 済み(推奨)
node src/cli.ts doctor    # リンク不要。リポジトリのルートから
```

以下このリポジトリのドキュメントは、リンク前提を置かないため
`node src/cli.ts …` で書いています。`cutflow …` と読み替えて構いません
(CLI が出すヒントも、実際に使った入口に合わせて書き分けます)。

必須(Node / ffmpeg / ffprobe / config)が欠けていれば exit 1、収録・AI 系(whisper・
モデル・エンコーダ・AI provider)の不足は warn(exit 0)で一覧表示されます。`--json` を
付けると機械可読な `DoctorReport` を標準出力に出せます(エージェント委任時のループに使う)。
詳細は [docs/usage.md の「環境プリフライト(doctor)」](docs/usage.md) を参照。

> **Linux で試す / mac が無い場合は Docker で再現環境を作れます。** リポジトリ直下で
> `docker build -t cutflow .` → `docker run --rm cutflow doctor --no-ai` を叩くと、
> 必須チェック(Node / ffmpeg / ffprobe / config)が緑になった Linux 環境をそのまま
> 確認できます(whisper は同梱しないので warn=想定内)。収録フォルダは
> `-v ~/Movies/cutflow:/recordings` でマウントして編集します。初回 `render` 時のみ
> Remotion が headless Chrome を自動取得します(数分)。

> **既定の AI provider `claude-code` は `claude` CLI(Claude Code)の
> インストールと認証(ログイン)が前提です。** 未導入だと `plan` 段で
> `コマンド 'claude' が見つかりません` で止まります。Claude Code を入れて
> `claude` にログインしておくか、Codex CLI / 従量課金 API に切り替えてください
> (→ [設定](#設定) の「AI provider」)。文字起こし・無音検出・レンダーは
> LLM 不要です。

> **まず動かすだけなら OBS は不要です。** スマホの縦動画・QuickTime 等の画面録画・
> カメラ動画を1本、収録フォルダに入れて `editor` で開けば、そのまま **plain レイアウト**
> (カメラワイプ無し・収録の実寸のまま)で編集できます。手元に動画がまだ無くても、
> [すぐに触ってみる](#すぐに触ってみるサンプル)の同梱サンプルで `editor`→`render` を
> 体験できます。OBS で画面+カメラを同時に録って右下ワイプを合成する
> 「拡張キャンバス方式」は発展的な使い方で、
> [発展: OBS 拡張キャンバス方式](#発展-obs-拡張キャンバス方式画面カメラ)にまとめました。

## 使い方

### すぐに触ってみる(サンプル)

OBS も whisper モデルのダウンロードも無しで、`editor`→`render` を最短で体験できます。
`ffmpeg` で数秒のサンプル動画を合成し、編集可能な収録フォルダ(`examples/sample/`)を
用意します。

```sh
npm run sample        # = bash scripts/make-sample.sh
```

実行後に表示される3コマンド(`editor` / `approve` / `render`)をそのまま叩けば、
自動カット済みのサンプルが `examples/sample/final.mp4` として書き出されます
(初回 `render` は Remotion が headless Chrome を取得するため数分かかります)。
片付けは `rm -rf examples/sample`。詳細は
[docs/getting-started.md の「サンプルで試す」](docs/getting-started.md#22-サンプルで試すobswhisper-不要)。

収録1本 = 1フォルダ(中に mkv/mp4/mov を1本)。

```sh
# まずエディタで開く(自動カットなし。動画は全編 keep のまま)
node src/cli.ts editor ~/Movies/cutflow/2026-07-02-my-recording

# OBS 拡張キャンバス(画面+カメラ横並び)として開く場合
node src/cli.ts editor ~/Movies/cutflow/2026-07-02-my-recording --layout obs-canvas

# 自動カット案までまとめて作る上級/バッチ用
node src/cli.ts run ~/Movies/cutflow/2026-07-02-my-recording

# ステージ個別実行
node src/cli.ts ingest     <dir>
node src/cli.ts transcribe <dir>
node src/cli.ts detect     <dir>
node src/cli.ts plan       <dir>
node src/cli.ts remeta     <dir>   # 章立て・タイトル案・概要欄だけ作り直す(カットは触らない)
node src/cli.ts editor     <dir>   # GUI エディタをブラウザで開く(カット・テロップ・演出を編集)
node src/cli.ts preview    <dir>   # カット結果の確認用動画(承認前に見る)
node src/cli.ts validate   <dir>   # 編集した JSON の整合性チェック(手編集・AI編集の後に)
node src/cli.ts describe   <dir>   # タイムラインのテキスト要約(元秒⇔カット後秒の対応付き)
node src/cli.ts frames     <dir> --t 90,2:30  # 指定時刻を最終合成の見た目で frames/*.png に
node src/cli.ts render     <dir>   # 承認後の最終レンダー(要 approved: true)
```

編集は GUI エディタ(`editor`)でも、収録フォルダ内の JSON 直接編集でも行えます。
GUI はブラウザ上でカット境界のドラッグ・テロップの配置・素材の挿入・承認・
プレビュー生成・レンダーまで完結でき、外部(手編集や AI)による JSON の変更は
ホットリロードで反映されます。AI コマンドは「提案だけ」で終わらず、差分確認
→ 適用 → 保存 → 必要ならフレーム確認までを 1 回の workflow として扱います。
手順の詳細は [docs/guides/tools-and-ops.md](docs/guides/tools-and-ops.md)(索引は
[docs/usage.md](docs/usage.md))を参照してください。

**AI エージェントに編集させる(MCP)**: Claude Desktop / Claude Code / Cursor など
MCP 対応ホストから、この収録フォルダを直接編集させられます。`node src/cli.ts mcp <dir>`
を1エントリ登録するだけで、read + 承認スコープ外の安全編集の tool
(`describe` / `validate` / `frames` / `apply` / `id-stamp` 等)が露出します
(承認・`render`・`plan` は露出しません=**設計上、承認できません**)。
ホスト別の copy-paste 設定と、承認を人間だけの行為に固定する
`.claude/settings.json` の deny テンプレ(`docs/examples/claude-settings-deny.json`)は
[docs/guides/ai-agents.md の「MCP サーバ」](docs/guides/ai-agents.md) を参照してください。

新規取り込みの既定レイアウトは通常動画(`plain`)です。OBS の 3840x1080
拡張キャンバス(左=画面、右=カメラ)としてワイプを使う場合は、
`editor` / `ingest` / `run` に `--layout obs-canvas` を付けてください。

render は2段構成です。まず ffmpeg が keep 区間をフル解像度のまま結合して
`cut.mp4` を作り(音声はマイクと**システム音声(OBS トラック2)の自動ミックス**を
ツーパスの loudnorm で **-14 LUFS に自動正規化**)、
次に Remotion がその上に「画面クロップ+右下ワイプ+字幕+章カード」を
合成して `final.mp4` を出力します。収録フォルダに `bgm.mp3` を置けば
**BGM も自動で合成**されます(ループ+終端フェードアウト+**発話中の自動
ダッキング**)。
ワイプの大きさ・字幕サイズ・目標音量・BGM音量は config.yaml の `render`
セクションで変更できます。初回実行時は Remotion が headless Chrome を
自動ダウンロードします(数分)。

**人間がテロップやカットを調整しながら使う手順は [docs/usage.md](docs/usage.md)
(概要+目的別索引)を参照してください。目的別ガイドは [docs/guides/](docs/guides/):
どのJSONを直すと何が変わるかは usage.md、plan 再実行の注意点は
[cut-planning.md](docs/guides/cut-planning.md)、Remotion Studio の使い方は
[captions-layout.md](docs/guides/captions-layout.md)。**

## 発展: OBS 拡張キャンバス方式(画面+カメラ)

画面とカメラを同時に録って**右下ワイプ**として合成したい場合は、OBS の
**キャンバスを 3840x1080** にして左半分に画面・右半分にカメラを並べる
「拡張キャンバス方式」で収録します。これは plain より手間のかかる**発展的な**
使い方で、必須ではありません。OBS の初期設定(約30分)と撮影チェックリストは
[docs/recording-guide.md](docs/recording-guide.md) を参照してください。

拡張キャンバスの収録は、取り込み時に `--layout obs-canvas` を付けます:

```sh
node src/cli.ts editor <dir> --layout obs-canvas
node src/cli.ts ingest <dir> --layout obs-canvas
node src/cli.ts run    <dir> --layout obs-canvas
```

`--layout auto` でも 3840x1080 のような超横長素材は obs-canvas と判定されます
(既定は plain)。plain との違い(ワイプの有無・出力解像度・使える演出)は
[docs/getting-started.md](docs/getting-started.md#通常動画スマホカメラ画面録画の場合) を参照。

plan は LLM に「残す候補区間」の番号リストを渡し、番号単位で
カット判断させます(理由付き)。結果の `cutplan.json` を確認・編集して
`approved` を `true` にすると render に進めます。収録フォルダに
`brief.md`(企画ブリーフのコピー)を置いておくと、その「見せ場リスト」が
誤カット防止の材料として LLM に渡ります。プロンプトは
[prompts/plan.md](prompts/plan.md) で自由に調整できます。標準 `config.yaml` は
`plan.perception.audio/ocr` を明示オンにしており、`plan` / `remeta` / `run` は
実行時に今回の知覚状態を表示します。古い config で `plan.perception` が無い場合は、
互換のため知覚はオフのまま動作し、その旨を警告します。

## 設定

すべて [config.yaml](config.yaml) で変更できます(収録レイアウト、無音判定の
閾値、whisper モデル、AI provider 等)。コード側にハードコードされた
設定はありません。

AI provider:

- `claude-code`(デフォルト): `claude` CLI をサブプロセス実行。API キー不要
- `codex`: `codex exec` を read-only で実行。Codex CLI 認証が必要(実験的)
- `anthropic`: Anthropic API。`.env` または環境変数に `ANTHROPIC_API_KEY`、
  `ai.model` にモデル名を指定
- `openai`: OpenAI API。`.env` または環境変数に `OPENAI_API_KEY`、
  `ai.model` にモデル名を指定

旧設定 `llm.backend: claude-cli | api` は互換のため読み続けます。新規設定では
`ai.provider` を使ってください。

## スコープ(できること / 意図的に持たないこと)

CutFlow は「OBS の画面収録+カメラ → YouTube」という**単一ワークフローに特化**した
オピニオネイテッドな道具です。汎用 NLE(Premiere / Final Cut)の代替ではなく、
その前段の「一次編集を自動化して人が仕上げる」層を担います。

**できること**: 無音検出+LLM 意味カット / 多トラック・テロップ(位置・色・
フォント・座布団)/ 素材オーバーレイ(全画面・PiP)/ インサート編集 / ワイプ
全画面+遷移 / ズーム / ディップ・トゥ・ブラック / 簡易カラー調整(明るさ・
コントラスト・彩度の全編一律3値)/ BGM(区間配置・発話ダッキング・フェード)/
章立て / サムネイル / ショート(縦・複数プロファイル)/ マイク+システム音声
ミックス+-14 LUFS 自動正規化 / ノイズ除去。

**意図的に持たない機能**(欠落ではなく設計上の割り切り):

- 任意区間の速度変更 / タイムリマップ
- トランジション集(クロスディゾルブ等。現状は dip-to-black とワイプ遷移のみ)
- カラーグレーディング(カーブ / ホイール / LUT。現状は全編一律の3値のみ)
- マスク / クロマキー / 高度な合成(現状は矩形配置まで)
- クリップ単位の音量エンベロープ・オーディオエフェクト(EQ / コンプ / ゲート)
- モーション・キーフレーム / タイトルアニメ / MOGRT
- マルチカム(2分割キャンバスを超える)/ ネストシーケンス / 調整レイヤー
- 書き出しプリセット・フォーマット選択(mp4 固定パイプライン)

これらの不在は、対象ジャンル(画面デモ+解説)で使わないか、「JSON 駆動+
ローカル AI 編集」という設計の不変条件と引き合わないためです。採用/延期/却下の
判断根拠は [docs/next-features-design.md](docs/next-features-design.md) を参照。

## 開発状況

- [x] ingest / transcribe / detect(検証済み: 16秒素材の文字起こしが
      Apple M5 で約1秒)
- [x] plan(LLM 意味カット・章立て・タイトル案。合成音声テストで
      言い直し・脱線の検出を確認済み)
- [x] preview(カット結果の低解像度確認動画。検証済み)
- [x] render(Remotion 合成: ワイプ+字幕+章カード。マイク+システム音声の
      ミックス、BGM の発話ダッキング。合成素材でレイアウト・タイムライン変換とも
      検証済み)
- [x] validate / describe / frames(編集ファイルの整合性検査、タイムラインの
      テキスト要約、指定フレームの目視確認用 PNG 出力。AI が編集→検証→自己確認を
      CLI で完結できる)
- [x] remeta(cutplan を触らず章立て・タイトル案・概要欄だけを再生成)
- [x] editor(ブラウザ GUI: カット・テロップ・演出の編集、承認、プレビュー生成・
      レンダー、外部変更のホットリロード)

## License

MIT
