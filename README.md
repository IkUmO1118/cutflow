# cutflow

撮影後の編集を自動化する、ローカルファーストな動画パイプライン。

OBS で録りっぱなしにした素材(画面+カメラ+マイク)から、文字起こし →
カット案の生成 → **人間の承認** → 最終レンダーまでを CLI で行います。
文字起こしと無音検出は完全ローカル(無料)。LLM を使うのは意味的な
カット判断・章立てのみで、Claude Code のサブスク(`claude` CLI)でも
従量課金 API でも動きます。

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

必要なもの: macOS / Node.js 23.6+ / Homebrew

```sh
brew install ffmpeg whisper-cpp
mkdir -p ~/Models/whisper
curl -L -o ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
npm install
```

収録方法(OBS の設定)は [docs/recording-guide.md](docs/recording-guide.md) を
参照してください。**キャンバスを 3840x1080 にして左に画面・右にカメラを並べる
「拡張キャンバス方式」を前提**にしています。

## 使い方

収録1本 = 1フォルダ(中に mkv/mp4/mov を1本)。

```sh
# まとめて実行(承認ゲートまで)
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
ホットリロードで反映されます。手順の詳細は [docs/usage.md](docs/usage.md) を
参照してください。

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

**人間がテロップやカットを調整しながら使う手順(どのJSONを直すと何が
変わるか、plan 再実行の注意点、Remotion Studio の使い方)は
[docs/usage.md](docs/usage.md) を参照してください。**

plan は LLM に「残す候補区間」の番号リストを渡し、番号単位で
カット判断させます(理由付き)。結果の `cutplan.json` を確認・編集して
`approved` を `true` にすると render に進めます。収録フォルダに
`brief.md`(企画ブリーフのコピー)を置いておくと、その「見せ場リスト」が
誤カット防止の材料として LLM に渡ります。プロンプトは
[prompts/plan.md](prompts/plan.md) で自由に調整できます。

## 設定

すべて [config.yaml](config.yaml) で変更できます(収録レイアウト、無音判定の
閾値、whisper モデル、LLM バックエンド等)。コード側にハードコードされた
設定はありません。

LLM バックエンド:

- `claude-cli`(デフォルト): `claude` CLI をサブプロセス実行。API キー不要
- `api`: 従量課金 API。`.env` に `ANTHROPIC_API_KEY` を設定し、
  `llm.model` にモデル名を指定

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
