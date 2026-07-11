# 見本動画スタイル抽出コマンド設計

*2026-07-11 / 進捗記録用*

対象: 見本動画を cutflow に取り込み、編集スタイルを分析して次回の AI 編集へ渡せる
`reference-analyze` 系コマンドを作る。

---

## 0. 目的

見本動画から「完成映像として観測できる編集スタイル」を抽出し、個人化された AI 動画編集の
入力にする。

ここで目指すのは、見本動画を完全な `cutplan.json` / `overlays.json` に逆変換することではない。
完成動画だけでは、削られた NG、元の間、未使用素材、編集者の判断理由が失われているため、
元素材時間軸の編集判断を完全復元できない。

本機能の第一目標は、次のような `reference.profile.json` を生成すること。

```json
{
  "schemaVersion": 1,
  "source": "sample.mp4",
  "durationSec": 120.0,
  "cutDensity": {
    "sceneChangesPerMin": 18.0,
    "avgShotSec": 2.4
  },
  "captions": {
    "coverageRatio": 0.82,
    "avgDisplaySec": 1.6,
    "positionHint": "bottom-center",
    "styleNotes": ["bold", "high contrast", "keyword emphasis"]
  },
  "audio": {
    "integratedLufs": -14.2,
    "silenceCount": 12,
    "bgmLikely": true
  },
  "structure": [
    { "name": "hook", "start": 0, "end": 4 },
    { "name": "main", "start": 4, "end": 105 },
    { "name": "cta", "start": 105, "end": 120 }
  ]
}
```

この profile は直接レンダーする編集データではなく、`plan` / `editor-ai` / 将来の
style retrieval に渡す参照情報として使う。

---

## 1. 現状で使える部品

既存実装には、見本動画分析に流用できる部品が既にある。

- `ingest --layout plain`
  - 通常動画を `screenRegion=全フレーム` の recording として取り込める。
- `transcribe`
  - 発話・テロップ候補の時間軸を作れる。
- `detect`
  - 無音、間、テンポの手掛かりを `cuts.auto.json` に出せる。
- `frames --every ... --ocr --full-res`
  - 代表フレームと画面内テキストを取れる。
- `av`
  - scene score、freeze、loudness、true peak、silence、motion strip を取れる。
- `src/lib/perception.ts`
  - 音特徴、OCR、システム音声を LLM 入力へ整形する既存パターンがある。
- `src/lib/vlmObservation.ts`
  - limited VLM observation の型、安全制約、画像上限の設計がある。

したがって、第一段階では新しい認識エンジンを作るより、既存の観測を束ねる
orchestrator を作るのが最小で強い。

---

## 2. 現時点の弱いポイント

### 2.1 完全な編集判断は復元できない

完成動画だけでは、元素材のどこを削ったかが分からない。`cutplan.json` の本来の値は
source seconds だが、見本動画にあるのは完成後の output seconds だけ。

解消方針:

- 見本動画だけの場合は `style profile` として扱う。
- 元素材 + 完成動画のペアがある場合だけ、将来 `reference-align` で source/output 対応を推定する。

### 2.2 テロップの正確なスタイル抽出が弱い

OCR で文字と位置は取れるが、フォント名、縁取り、影、アニメーション、強調語の色までは
安定して取れない。

解消方針:

- P0 では OCR box と出現頻度から `positionHint` / `coverageRatio` / `avgDisplaySec` を出す。
- P1 で VLM に代表フレームを渡し、`styleNotes` として人間向けの自然言語特徴を抽出する。
- P2 で画像処理による色・縁取り・サイズ推定を追加する。

### 2.3 BGM / SE / 音楽構造の抽出が弱い

現状の `av` は loudness や silence は取れるが、BGM の曲調、SE 種類、意図的な音ハメは分からない。

解消方針:

- P0 は LUFS、silence、音量変化、発話外の継続音から `bgmLikely` 程度に留める。
- P1 で音量エンベロープと scene score の同時変化を見て、盛り上げ区間を推定する。
- P2 で音響分類 provider を optional にする。

### 2.4 構成理解がまだ粗い

hook / main / CTA / intro / ending / eye-catch の分割は、決定論だけでは難しい。

解消方針:

- P0 は固定ヒューリスティックで冒頭/終盤/高密度区間を候補化する。
- P1 で transcript + OCR + motion/sound summary を LLM に渡し、構成ラベルを推定する。
- ラベルは自動編集の絶対判断には使わず、profile の補助情報として扱う。

### 2.5 分析結果を AI 編集へ流す経路がない

`learn` は AI 生成結果と人間の仕上げからルール案を作るが、見本動画 profile を
`plan` や `editor-ai` に渡す設計はまだない。

解消方針:

- P0 は `reference.profile.json` を生成するだけ。
- P1 で `channel rules` への要約生成、または `plan` の prompt context へ opt-in 注入する。
- P2 で style retrieval と組み合わせる。

---

## 3. コマンド案

### 3.1 最小コマンド

```bash
node src/cli.ts reference-analyze <dir>
```

`<dir>` は見本動画を1本含むフォルダ。動画ファイルは既存 `findSource()` と同じ規則で探す。

実行内容:

1. `manifest.json` がなければ `ingest(..., "plain")`
2. `transcript.json` がなければ `transcribe`
3. `cuts.auto.json` がなければ `detect`
4. 全編 keep の一時分析用 cutplan をメモリ上で作る、または `reference.probe/analysis.cutplan.json` に生成
5. `av` 相当の motion/sound report を作る
6. 一定間隔の frames + OCR を作る
7. `reference.probe/profile.json` を書く

P0 では既存の編集ファイルを上書きしない。見本動画分析の生成物は `reference.probe/` 配下に閉じる。

### 3.2 オプション案

```bash
node src/cli.ts reference-analyze <dir> --every 1 --ocr --vlm --json
```

- `--every <sec>`: フレーム/モーション集計の間隔。
- `--ocr`: OCR を有効化。macOS/Apple Vision が無い場合は警告して続行。
- `--vlm`: 代表フレームを vision route に投げ、見た目の style notes を追加。
- `--range <a-b>`: 長尺見本の一部だけを分析。
- `--json`: profile を stdout に出す。

---

## 4. 生成物

`reference.probe/` 配下に置く。これは generated artifact として扱い、人間が直接編集する
正本にはしない。

```text
reference.probe/
  profile.json
  motion.json
  sound.json
  frames/
  ocr.json
  vlm.json
  summary.md
```

各ファイルの役割:

- `profile.json`: 機械可読なスタイル profile。下流の正本。
- `motion.json`: scene score / freeze / cut density の根拠。
- `sound.json`: loudness / silence / audio envelope の根拠。
- `frames/`: 代表フレーム。VLM/OCR/人間確認用。
- `ocr.json`: テロップ/画面内文字の行、box、時刻。
- `vlm.json`: optional。代表フレームからの見た目要約。
- `summary.md`: 人間が読む分析結果。

---

## 5. 実装分解

### P0: 決定論的 profile

- `src/stages/referenceAnalyze.ts` を追加。
- `reference.probe/` へ生成物を閉じる。
- 見本動画を plain recording として ingest する。
- 全編 keep の分析 timeline を作る。
- 既存 `av` の motion/sound 収集ロジックを再利用または共通化する。
- `frames` / `screenStill` / `runOcr` を使って OCR summary を作る。
- `reference.profile.json` ではなく `reference.probe/profile.json` を正本にする。
- テストでは小さい fixture を使い、profile の schemaVersion と主要集計だけ固定する。

完了条件:

- `node src/cli.ts reference-analyze <dir>` が plain 動画フォルダで通る。
- 既存編集ファイルを上書きしない。
- `npm test` と `npm run typecheck` が通る。

### P1: LLM/VLM による構成・見た目要約

- `--vlm` を追加。
- 代表フレームの選び方を決める。
  - 冒頭
  - scene score が高い箇所
  - OCR が多い箇所
  - 終盤
- VLM には座標や編集 JSON を直接書かせない。
- 返すのは `styleNotes` / `structure` / `uncertainties` のみ。
- 失敗時は deterministic profile だけで成功扱いにする。

完了条件:

- VLM 無効時と有効時の出力差分が profile の optional field に閉じる。
- VLM の出力 validation がある。

### P2: AI 編集への接続

- `plan` / `editor-ai` に `--style-reference <profile>` を追加する。
- profile をそのまま巨大 prompt に貼らず、圧縮 summary を作って渡す。
- `learn` と接続し、見本 profile + 人間修正から channel rules 案を作る。
- 複数 profile を retrieval できるようにする。

完了条件:

- style reference を指定したときだけ AI prompt に入る。
- 未指定時は既存挙動とバイト等価。
- AI が profile を根拠に編集しても、最終適用は既存 `validate` / `apply` 境界を通る。

### P3: 元素材 + 完成動画の alignment

- `reference-align <rawDir> <finishedDir>` を別コマンドとして検討する。
- 音声 fingerprint / transcript / visual hash で完成動画の区間が元素材のどこ由来か推定する。
- 成功した範囲だけ `cutplan` 風の training examples にする。
- 不確実な区間は必ず `confidence` を持たせる。

完了条件:

- 見本動画単体の profile と、素材ペア alignment を明確に分ける。
- confidence が低い推定を自動編集の正本にしない。

---

## 6. 不変条件

1. **見本動画単体から source-time の編集判断を復元したと偽らない。**

2. **`reference.probe/` は generated。**
   `cutplan.json` / `transcript.json` / `overlays.json` などの手編集ファイルを勝手に上書きしない。

3. **P0 は決定論を優先する。**
   VLM/LLM は optional。失敗しても profile 生成の主要部分は通る。

4. **全時刻の軸を明示する。**
   見本動画単体では source seconds と output seconds は同一として扱えるが、profile には
   `axis: "reference-output"` を入れる。

5. **profile は編集命令ではなく参照情報。**
   下流 AI は profile を使って提案してよいが、適用は既存の検査境界を通す。

6. **既存の録画編集 workflow を壊さない。**
   `reference-analyze` は新規 opt-in コマンド。既存 `run` / `plan` / `render` の挙動を変えない。

---

## 7. 進捗ログ

### 2026-07-11

- 目的を「見本動画の完全逆変換」ではなく「style profile 抽出」と定義。
- 既存の `ingest --layout plain` / `transcribe` / `detect` / `frames --ocr` / `av` を再利用する方針に決定。
- P0 は `reference.probe/profile.json` 生成に限定。
- P1 以降で VLM 要約、AI 編集への注入、素材ペア alignment を扱う方針に分離。

---

## 8. 未決事項

- `reference-analyze` が `transcript.json` / `cuts.auto.json` を recording root に生成してよいか。
  - 案A: 既存 workflow と揃えるため root に生成する。
  - 案B: 見本分析を完全に `reference.probe/` に閉じる。
  - 現時点の推奨は案A。ただし既存ファイルがある場合は上書きしない。
- OCR sampling の既定間隔。
  - 長尺動画では `--every 1` は重い。既定は 2-5 秒程度が現実的。
- profile schema を `schemas/reference-profile.schema.json` として固定するか。
  - P0 実装時に追加するのが望ましい。
- VLM の representative frame 選定。
  - scene score 上位だけだと派手な切替に偏る。冒頭/中盤/終盤/OCR多めを混ぜる。
- `learn` との接続形式。
  - rules.suggested.md に落とすか、profile summary を直接 prompt context にするかは分けて検討する。

---

## 9. 調査結果: 編集判断データ抽出と自動編集への接続

### 9.1 結論

見本動画から直接取り出せるのは、`cutplan.json` 相当の source-time 編集判断ではなく、
完成映像上で観測できる編集傾向である。したがって、本機能で扱う「編集判断データ」は
次の2段に分けるのが現実的。

1. 見本動画から `reference-output` 軸の観測値を抽出する。
2. 観測値を `style policy` として、自分の収録の候補区間に対する判断基準へ変換する。

つまり `reference.profile.json` は「この時刻を切る」という命令ではなく、
「このくらいのテンポ・字幕密度・構成・音量感を好む」という方針データとして扱う。
自分の動画では、既存の `detect` が作る候補区間、`transcript.json`、`perception`、
`plan` / `editor-ai` の安全境界を使って、その方針を適用する。

### 9.2 抽出できる信号と使う仕組み

| 領域 | 抽出する値 | 現実的な実装 | 自動編集での使い方 |
|---|---|---|---|
| カット密度 | scene changes/min、平均ショット長、scene score 分布、freeze 数 | 既存 `av` の `scdet` / `freezedetect`。必要なら PySceneDetect を optional provider | `plan` に「短め/長めに残す」「無音後の切り詰めを強める」などの方針として渡す |
| テンポ | 無音数、無音長、発話密度、画面変化密度 | `detect` の silence、`av` の motion、transcript duration | `detect` の候補区間を LLM が選ぶときの重み付けにする |
| 音量 | integrated LUFS、true peak、音量エンベロープ、盛り上がり区間 | 既存 `av` の `ebur128` / `astats` / `silencedetect` | BGM/SE の有無推定、盛り上げ区間、ショート候補抽出の補助にする |
| テロップ | OCR coverage、平均表示秒、表示位置、box 分布、行数、文字量 | 既存 `frames --ocr --full-res` / `runOcr`。Apple Vision 非対応時は劣化 | `overlays.captionTracks` の初期案、字幕密度、位置、強調方針に反映 |
| 見た目 | 太字、高コントラスト、座布団、キーワード強調、画面占有感 | P1 の VLM 代表フレーム要約。座標やフォント名は信用しすぎない | `styleNotes` として prompt に圧縮注入。直接 JSON は書かせない |
| 構成 | hook、intro、main、CTA、ending、密度の高い区間 | transcript + OCR + motion/sound summary を LLM に渡す | 冒頭の残し方、章立て、終盤 CTA の扱いに使う |
| 素材対応 | finished 区間が raw のどこに由来するか | 見本単体では不可。raw + finished ペアで audio fingerprint / transcript / visual hash alignment | P3 の `reference-align` で confidence 付き training examples にする |

P0 では FFmpeg 系の決定論的な観測だけで十分価値がある。VLM は「見た目の言語化」には
役立つが、テロップの正確な座標、フォント名、縁取り、アニメーション、編集 JSON の生成を
任せるには不安定なので、P1 でも補助情報に限定する。

### 9.3 自分の動画編集を自動化する流れ

推奨する実行モデルは次の通り。

```text
reference video
  -> reference-analyze
  -> reference.probe/profile.json
  -> compact style summary
  -> plan/editor-ai prompt context
  -> ApplyPatch / validate / review / human approval
```

`profile.json` をそのまま巨大 prompt に貼るのではなく、編集判断に効く項目だけを
圧縮して渡す。

例:

```json
{
  "axis": "reference-output",
  "cutPolicy": {
    "targetAvgShotSec": 2.4,
    "cutAggressiveness": "medium-high",
    "pauseToleranceSec": 0.35
  },
  "captionPolicy": {
    "coverageRatio": 0.82,
    "positionHint": "bottom-center",
    "density": "high",
    "styleNotes": ["bold", "high contrast", "keyword emphasis"]
  },
  "structurePolicy": {
    "hookSec": 4,
    "ctaLikely": true,
    "notes": ["冒頭は説明より結果を先に見せる"]
  }
}
```

この summary を `plan --style-reference <profile>` や `editor-ai` の opt-in context として渡す。
既存 `plan` は LLM に時刻を生成させず、候補区間の番号選択だけをさせる設計なので、
style reference との相性がよい。style reference は「候補区間の選び方」に効かせ、
最終的な編集値は既存の `buildCutplan` / `apply` / `validate` 境界を通す。

### 9.4 実装方針の現実解

P0 は「既存部品を束ねる orchestrator」として実装するのが最小で強い。

- `src/stages/referenceAnalyze.ts` を追加する。
- `ingest(..., "plain")` で見本動画を通常動画として取り込む。
- root の `manifest.json` / `transcript.json` / `cuts.auto.json` は既存 workflow に揃えて
  「無ければ生成、既存は上書きしない」とするのが実装コスト上は現実的。
- `av` は現状 `cutplan.json` を読むため、P0 では全編 keep の分析用 cutplan を
  一時的にメモリで扱えるよう共通化するか、`reference.probe/analysis.cutplan.json` を使う。
- `frames` は現状 root の編集 snapshot を読むため、P0 で完全に `reference.probe/` に閉じるには
  `renderFrames` を snapshot 注入可能にする必要がある。
- まずは `reference.probe/profile.json`、`motion.json`、`sound.json`、`ocr.json`、`summary.md`
  を生成する。

`reference.probe/` は generated artifact として扱うため、実装時には
`src/lib/files.ts` の `GENERATED_DIRS` と `AGENTS_CONTRACT.md` の生成物一覧へ追加する。
この更新を忘れると、設計上は generated なのにファイル分類上は `other` になる。

### 9.5 P2 で必要な接続点

`plan` への接続:

- CLI に `--style-reference <profile>` を追加する。
- `profile.json` を検証し、`renderStyleReferenceBlock(profile)` のような短い prompt block にする。
- `{{rules}}{{perception}}` と同じ opt-in ブロックとして挿入する。
- 未指定時は prompt が既存とバイト等価になるようにする。

`editor-ai` への接続:

- `AiProposeRequest` に optional な style reference 指定を追加する。
- `buildEditorAiPrompt` で project projection と retrieval results に加えて style summary を渡す。
- AI には style reference を根拠にしてよいが、編集対象は既存どおり `cutplan` /
  `transcript` / `overlays` / `bgm` / `shorts` に限定する。
- 生成 patch は必ず `planApply` / `applyEdits` / `validate` を通す。

`learn` への接続:

- `learn` は現在「前回の AI 生成」と「人間の仕上げ」から rules suggestion を作る。
- ここに reference profile summary を追加すると、
  「見本に寄せたい傾向」と「実際に人間が直した傾向」を両方見た channel rules 案を作れる。
- ただし `rules.suggested.md` は下書きのままにし、`rules.md` への採用は人間が行う。

### 9.6 P3: raw + finished ペアがある場合

見本動画単体では source-time の編集判断は復元できないが、元素材と完成動画のペアがある場合は
次の推定が可能になる。

- 音声 fingerprint / cross-correlation で finished 区間を raw 上に対応付ける。
- transcript の文列一致で発話区間を対応付ける。
- 代表フレームの perceptual hash / CLIP embedding で画面対応を補助する。
- 対応できた区間だけ `confidence` 付きで training examples にする。

ただし alignment は誤対応が起きるので、低 confidence の推定を自動編集の正本にしない。
`reference-align` は `reference-analyze` とは別コマンドにし、見本単体の style profile と
素材ペア由来の training example を明確に分ける。

### 9.7 参考資料

- FFmpeg Filters Documentation: https://ffmpeg.org/ffmpeg-filters.html
- PySceneDetect Detectors: https://www.scenedetect.com/docs/latest/api/detectors.html
- OpenAI Images and vision: https://developers.openai.com/api/docs/guides/images-vision
- WhisperX: https://github.com/m-bain/whisperX
