# 素材(B-roll)の中身を AI が知る手段 — 設計

*2026-07-07 / 診断レビュー「Next テーマ A」項目の設計。実装は別担当。*

> 元ネタ: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`
> テーマ A「AI の知覚強化(目・耳)」/ 項目「**素材(B-roll)の中身を AI が知る手段が無い**」=
> severity **major** / effort **M**。
> 現状「AI が得られるのは `materials/` のファイル名だけ。尺超過や不適切配置に気づけない」。

---

## 背景とギャップ

素材(B-roll・スライド・オープニング/エンディング・挿入クリップ・BGM)は収録フォルダの
`materials/` に置かれ、`overlays.json` の `overlays[].file`(全画面/部分配置)・`inserts[].file`
(インサート)・`bgm.json` の `tracks[].file` から**相対パス**で参照される。

現状 AI が素材について知れるのは:
- `describe --json` の `overlays.materials[].file` / `.exists`(参照先のファイル名と存在有無)
- `inserts[].durationSec`(**編集者が書いた**挿入尺。素材の実尺ではない)

つまり **素材の中身(実尺・解像度・音声の有無・見た目・画面内テキスト・素材音声の発話)は
一切不可視**。結果として AI は:
- **尺超過に気づけない**: `inserts[].durationSec` に素材の実尺より長い値を書いても検出できない
  (実尺を超えると最後のフレームで固まる — `src/types.ts` の `inserts` コメント)。
- **不適切配置に気づけない**: 縦長スライドを横 rect に `cover` で置いて端が切れる、音声付き素材を
  `volume:0` の想定で全画面配置してしまう、等を「見て」判断できない。
- **棚卸しできない**: `materials/` にあるのに一度も参照されていない素材(消し忘れ)や、逆に
  参照されているのに `materials/` に無い素材(dangling)を機械的に洗い出せない。

この設計のゴールは、**既存の知覚トライアド(describe = 要約 / frames = 見た目 / OCR = 画面文字)と
整合する形で、操作エージェント(Claude Code)向けに素材の中身を露出する**こと。

## スコープ

**やること(今回)**
- 素材メタの安価な取得(ffprobe 一発): 尺・解像度・fps・音声有無・codec・種別。
- opt-in の重い知覚: 代表フレーム PNG(見た目)・フレーム OCR(画面文字)・素材音声の文字起こし。
- 参照のクロスリンク(どの overlay/insert/bgm が指すか)+ 未使用/dangling の検出。
- 上記を**新コマンド `materials <dir>`** として露出。既存の出力(transcript.json 等)は 1 バイトも
  変えない。

**やらないこと(明示的にスコープ外)**
- **素材メタを `plan` / `remeta` / `plan-shorts` の LLM 入力に流し込むこと**(論点6)。これは Next の
  別項目「カット判断ループに目耳を接続」。今回は**操作エージェント向けの露出まで**で、
  `src/stages/plan.ts` と `config.yaml` の `plan.perception` は一切触らない。
- 素材メタを使った自動編集・自動アサーション(尺超過を自動修正する等)。今回は「AI が読める形に
  する能力」まで。
- `describe`(散文 / `--json`)の出力変更(論点1で理由を述べる)。

---

## 論点と決定

### 論点1:露出の形 → **決定: 新コマンド `materials <dir>`。`describe` は触らない**

比較:

| 案 | 中身 | 長所 | 短所 |
|---|---|---|---|
| **(A) 新コマンド `materials`(採用)** | 素材一覧+メタを stdout に要約し、機械可読な `materials.probe/index.json` を書く | 既存出力にゼロ影響(未使用時バイト等価が自然に成立)。frames と同じ「知覚コマンド=stdout 要約 + サイドカー」の型に乗る。棚卸し(全ファイル)も検証(参照中)も1コマンドで賄える | 新コマンド・新生成物の登録が要る |
| (B) `describe --json` の `overlays.materials[]` に `durationSec`/`hasAudio` を足す | AI が既に見る場所に相乗り | **`describe --json` は現状 外部プロセスを一切呼ばない純 fs 読み(高速・決定論)**。ffprobe を素材数ぶん呼ぶと遅くなり ffmpeg 依存が混ざる。散文 `describe` は golden test でバイト固定=触れない。参照中の素材しか載らず**棚卸し用途を満たせない**。重い層(frame/OCR/文字起こし)は describe に載る筋が悪い | — |

**決定と理由**
- **(A) 採用**。frames が「時刻→絵」を撮る知覚コマンドなのと対称に、`materials` は「素材→中身」を
  読む知覚コマンド。既存の知覚トライアドに**並列世界を作らず自然に足せる**。
- **(B) 却下**。`describe --json` の「外部依存ゼロ・純粋・決定論」という性質を壊すのは高くつく。
  素材知覚は本質的に ffmpeg/whisper/Vision という重い外部プロセスを伴うので、意図的に別コマンドへ
  隔離するのが正しい。describe は 1 バイトも触らない(golden test・`test/schema.test.ts` を動かさない)。

**露出の二経路(frames と同じ思想)**:
- **stdout**: 素材ごとに 1 行の要約(種別・尺・解像度・音声有無・参照先・取得済み層)。AI がファイルを
  開かずに全体像を掴める。
- **`materials.probe/index.json`**: 機械可読な完全な集約。AI が `Read` する。同時に**キャッシュ**でも
  ある(論点5)。OCR/文字起こしの全文は per-material サイドカーに逃がし、index.json には**プレビュー
  (先頭数行)+件数+サイドカーパス**だけ載せて肥大を防ぐ(frames の stdout 抜粋 + `.ocr.json`
  サイドカーと同じ二段構え)。

**中間生成物としての置き場所** → `materials.probe/` **1ディレクトリに集約**(root を汚さない)。
`materials/` 自体は人間の素材置き場(`fileRole` は `"other"`)なので**絶対に生成物ディレクトリに
しない**。よって別名の生成ディレクトリ `materials.probe/` を作り、`src/lib/files.ts` の
`GENERATED_DIRS` に 1 行追加する。中身:
- `index.json` … 集約 + フィンガープリントキャッシュ(下記)
- `<slug>.png` … 代表フレーム(`--frames`。動画のみ)
- `<slug>.ocr.json` … フレーム OCR(`--ocr`)
- `<slug>.transcribe.json` … 素材音声の文字起こし(`--transcribe`)

`frames/` が実行ごとに全消しの「使い捨て」なのに対し、`materials.probe/` は `render.chunks/` と同じ
**キャッシュ型ディレクトリ**(差分更新・ディレクトリごと削除すれば全再生成に戻る)。分類は同じ
「generated(手編集しない)」。

`<slug>` は相対パス由来の衝突を避けるため**パス全体を安全化**(`materials/slide-01.png` →
`materials__slide-01.png`)する。同一 stem 別拡張子(`a.mp4` と `a.png`)や `materials/` 直下以外の
参照でも衝突しない。

### 論点2:対象範囲 → **決定: `materials/` 内の全ファイル ∪ 参照集合。参照をクロスリンクし未使用/dangling を明示**

2つの用途:
- **棚卸し**: `materials/` にあるが未使用のファイル(消し忘れ)を洗う → `materials/` 全走査が要る。
- **検証**: 使用中素材(overlays/inserts/bgm から参照)の尺・配置が妥当か → 参照集合が要る。

**決定**: 既定で **`materials/` の実在ファイル(present 集合)** と **参照集合(overlays[].file ∪
inserts[].file ∪ bgm.tracks[].file)** の**和集合**を対象にし、各素材に:
- `references[]`(どの overlay/insert/bgm が指すか。要素に `@id` があれば併記 — `describe --json` の
  `MaterialEntry.id` と同じ発想でアドレス可能に)
- `used`(参照が1つ以上あるか)
- `present`(`materials/` 等に実在するか)

を付ける。これで**1回の実行で棚卸しと検証の両方**を賄う。派生する検出:
- `used:false, present:true` … **未使用素材**(棚卸し対象。stdout で「未使用」印)。
- `used:true, present:false` … **dangling 参照**(overlays 等が指すのにファイルが無い。`describe` の
  `exists:false` と同じ事故を、素材側から捕捉)。

**メディア判定**: `.DS_Store` / `*.bak` 等の非メディアを probe して無駄なエラーを出さないよう、
既知のメディア拡張子(video/image/audio)で事前フィルタしてから probe。それ以外は
`kind:"unknown"` として一覧には出すが probe しない(棚卸しの網羅性は保ちつつ無駄を避ける)。

**参照パスの基準**: overlays/inserts/bgm の `file` は**収録フォルダ直下からの相対パス**なので、
参照集合は `materials/` 外(root の `bgm.mp3` 等)も指しうる。走査は「`materials/` 実在ファイル」+
「参照集合の相対パス(materials/ 外も含む)」の和で行う。

### 論点3:取得する情報の階層とフラグ → **決定: 既定=ffprobe だけ。`--frames`/`--ocr`/`--transcribe` で opt-in(`--all` は3つ全部)**

| 層 | 取得内容 | コスト | 既定 | フラグ |
|---|---|---|---|---|
| (a) probe | 尺・width/height・fps・hasAudio・videoCodec・audioCodec・kind・fileSize | ffprobe 一発(~数十ms/本) | **常に** | — |
| (b) frame | 代表フレーム PNG(動画のみ。画像は自身が代表) | ffmpeg still 1枚/本 | opt-in | `--frames` |
| (c) ocr | 代表フレーム(動画)/ 画像自身(画像)を Apple Vision OCR | Vision 1回/本(macOS 依存) | opt-in | `--ocr` |
| (d) transcribe | 音声付き素材を whisper で文字起こし | whisper 1回/本(重い) | opt-in | `--transcribe` |

- **既定は (a) だけ**(尺・音声有無・解像度)。診断が挙げる「尺超過・不適切配置に気づけない」の
  核はこの安価な層で大半が解ける。frames の `--ocr` が既定オフなのと同じ思想。
- **フラグは直交・加算的**(frames の `--ocr`/`--full-res` と同じ)。`--ocr` は動画に対しては内部で
  代表フレーム抽出を含意する(OCR には PNG が要る)。画像に対しては画像自身を OCR。
  `--transcribe` は独立。`--all` = `--frames --ocr --transcribe`。
- **優雅な劣化(必須)**: `--ocr` は macOS/Apple Vision 非対応環境では `runOcr` が null を返し
  警告のみ(既存 `src/lib/ocr.ts` の劣化をそのまま流用)。`--transcribe` は whisper モデルが無ければ
  警告してスキップ(その素材の transcribe 層だけ欠落し、他の出力は成功で返す)。**どの opt-in 層の
  失敗も probe 層の出力を壊さない**。

### 論点4:代表フレームの選び方 → **決定: 動画は中点1枚。画像は自身。出力先は `materials.probe/`(frames/ とは分離)**

- **動画**: 尺の**中点1枚**(`durationSec/2`)。理由: 決定論・安価・「その素材の代表的な絵」を1枚で
  掴める。複数枚(`--frames N`)は将来の任意拡張として名前だけ残すが、既定は1枚(過剰にしない)。
  抽出は `ffmpeg -ss <mid> -i <material> -frames:v 1 <out>.png`(`screenStill.ts` のパターンを
  クロップ無しに一般化)。
- **画像**: ファイル自身が代表フレーム。PNG を複製せず、`frame.file` に**元の相対パス**を記録し、
  OCR も元画像を直接読む(無駄なコピーを作らない)。
- **出力先**: `materials.probe/<slug>.png`。**`frames/` には混ぜない**。`frames/` は本編/ショートの
  自己確認(実行ごと全消し)で、素材フレームはキャッシュ対象=寿命が違う。混ぜると `frames` の
  全消しループが素材フレームまで巻き込む/古さ判定が濁る。分離が正しい。
- **OCR の座標系**: `runOcr(imagePath, region, opts)` の `region` に**その素材フレームの画素寸法**を
  渡す。`toOcrResult` は box を `region` 出力px(= region 自身)へ写像する(恒等)ので、素材 box は
  **素材フレームのピクセル座標**で表現される(本編 screenRegion 座標ではない)。これは素材の中身を
  読む用途に対して自然(素材内のどこに文字があるか)。index/サイドカーにその旨を記す。

### 論点5:キャッシュ/陳腐化 → **決定: 素材ごとに mtime+size フィンガープリント。層ごとに再計算を省く**

- **キー**: 素材ファイルの `{ mtimeMs, size }`(`proxyCache.ts` の `source:{file,mtimeMs,size}` に倣う。
  素材は大きな動画もありうるので**内容ハッシュではなく mtime+size**。内容ハッシュが安いのは数KBの
  JSON だけ — `framesIndex.ts` はその理由でハッシュ、`proxyCache.ts` は大きな raw なので mtime+size。
  素材は後者側)。
- **判定**: `materials.probe/index.json` に前回の各素材のフィンガープリントと取得済み層を記録。
  再実行時、素材のフィンガープリントが不変**かつ**要求層が既に存在すれば**再計算をスキップして
  再利用**。素材が変わった(差し替え・再エンコード)ら、要求された層だけ撮り直す。**重い層
  (OCR / whisper)ほどキャッシュ価値が高い**のでここが効く。
- **`validate`/`describe` への陳腐化警告の配線は行わない**(スコープ外・byte-equal 維持)。frames の
  stale-PNG 警告は「frames を経由せず古い PNG を Read する事故」対策だが、素材メタは probe が安価で
  いつでも撮り直せるうえ、`validate`/`describe` に手を入れると golden/pin テストに波及する。素材の
  陳腐化は `materials` コマンド自身が上記フィンガープリントで面倒を見る(コマンドを再実行すれば
  変わった素材だけ更新される)。この判断は明示的に doc に残す。

### 論点6:plan LLM への接続 → **決定: 明示的にスコープ外。plan.ts / plan.perception は触らない**

診断は本項目を**操作エージェントが素材を知る手段**として位置づけている。カット判断 LLM 自身への
接続(`config.yaml` の `plan.perception` に素材メタを足す)は Next の別項目「カット判断ループに
目耳を接続」の領分。今回はそこに踏み込まない(`src/stages/plan.ts`・`config.yaml` の
`plan.perception` を 1 バイトも触らない)。`materials.probe/index.json` は将来 `{{perception}}` に
足す素材として自然に流用できる形にはしておく(機械可読・安定構造)が、配線は今回しない。

---

## スキーマ / インターフェース案

### CLI(`src/cli.ts` に `materials` コマンド追加)
```
node src/cli.ts materials <dir>                 # ffprobe だけ(尺・解像度・音声有無)
node src/cli.ts materials <dir> --frames         # + 代表フレーム PNG
node src/cli.ts materials <dir> --ocr            # + フレーム/画像 OCR(--frames を含意)
node src/cli.ts materials <dir> --transcribe     # + 音声付き素材の文字起こし
node src/cli.ts materials <dir> --all            # = --frames --ocr --transcribe
```
`--frames`/`--ocr`/`--transcribe` は直交する加算オプション。既定(フラグ無し)は probe のみ。

### 出力(`materials.probe/` 内・キャッシュ型=差分更新)
`materials.probe/index.json`(機械可読な集約 + キャッシュ):
```jsonc
{
  "schemaVersion": 1,
  "capturedAt": "2026-07-07T...Z",
  "materials": [
    {
      "file": "materials/opening.mp4",   // 収録フォルダ直下からの相対パス
      "present": true,
      "kind": "video",                    // "video" | "image" | "audio" | "unknown"
      "fingerprint": { "mtimeMs": 1720000000000, "size": 273336 },
      "probe": {
        "durationSec": 4.02,
        "width": 1920, "height": 1080, "fps": 30,
        "hasAudio": true,
        "videoCodec": "h264", "audioCodec": "aac"
      },
      "references": [                      // 使用箇所(@id があれば併記)
        { "as": "overlay", "id": "mat_ab12cd", "start": 0, "end": 4 },
        { "as": "insert", "id": "ins_ff01aa", "at": 12.5, "durationSec": 4 }
      ],
      "used": true,
      // ---- opt-in 層(撮ったときだけキーが出る)----
      "frame": { "file": "materials.probe/materials__opening.mp4.png", "atSec": 2.01,
                 "width": 1920, "height": 1080 },
      "ocr": { "file": "materials.probe/materials__opening.mp4.ocr.json",
               "coordSpace": "material-frame-px", "lineCount": 12,
               "preview": ["const foo = bar", "npm run build"] },
      "transcribe": { "file": "materials.probe/materials__opening.mp4.transcribe.json",
                      "segmentCount": 5, "preview": "ようこそ。今日は…" }
    },
    { "file": "materials/slide-01.png", "present": true, "kind": "image",
      "fingerprint": { "mtimeMs": ..., "size": 4940204 },
      "probe": { "width": 3840, "height": 2160, "hasAudio": false, "videoCodec": "png" },
      "references": [], "used": false },              // ← 未使用素材(棚卸し)
    { "file": "materials/ghost.mp4", "present": false, "used": true,
      "references": [{ "as": "overlay", "id": "mat_9911zz", "start": 30, "end": 34 }] }
      // ← dangling(参照されているが materials/ に無い)
  ]
}
```
per-material サイドカー(全文):
- `materials.probe/<slug>.ocr.json` … `src/lib/ocr.ts` の `OcrResult`(`text` / `lines[]{text,confidence,box}`)。
  `box` は**素材フレームのピクセル座標**(`image:{w,h}` を併記)。
- `materials.probe/<slug>.transcribe.json` … whisper の segments(`{start,end,text}[]` + `text` 連結)。
  素材ファイル内秒(頭 = 0)。

stdout(要約・frames の 1 行 echo と同じノリ):
```
materials/opening.mp4   video  4.0s 1920x1080 30fps 音声あり   [overlay mat_ab12cd, insert ins_ff01aa]
materials/slide-01.png  image  3840x2160                        未使用 ⚠
materials/ghost.mp4      (⚠ 参照されているが materials/ に無い: overlay mat_9911zz)
```

### 型(新規 `src/lib/materials.ts` にローカル定義。`src/types.ts` は触らない)
```ts
export type MaterialKind = "video" | "image" | "audio" | "unknown";
export interface MaterialProbe {
  durationSec?: number; width?: number; height?: number; fps?: number;
  hasAudio: boolean; videoCodec?: string; audioCodec?: string;
}
export interface MaterialRef { as: "overlay" | "insert" | "bgm"; id?: string;
  start?: number; end?: number; at?: number; durationSec?: number; }
export interface MaterialEntry {
  file: string; present: boolean; kind: MaterialKind;
  fingerprint?: { mtimeMs: number; size: number };
  probe?: MaterialProbe; references: MaterialRef[]; used: boolean;
  frame?: { file: string; atSec: number; width: number; height: number };
  ocr?: { file: string; coordSpace: string; lineCount: number; preview: string[] };
  transcribe?: { file: string; segmentCount: number; preview: string };
}
export interface MaterialsIndex { schemaVersion: number; capturedAt: string; materials: MaterialEntry[]; }
```
> TS 制約(Node 23 type stripping): enum・namespace・パラメータプロパティ不可。フィールドは明示宣言。

### ffprobe 拡張(`src/lib/ffmpeg.ts`)
`ProbeStream` に `codec_name?` と(任意で per-stream)`duration?` を**追加のみ**(既存 `probe()`
呼び出し元にゼロ影響)。素材メタの要約は `format.duration`(コンテナ尺)+ ストリームの `codec_name` /
`codec_type` から組み立てる純関数 `summarizeProbe(result): MaterialProbe` を新設(単体テスト対象)。
```ts
export interface ProbeStream {
  index: number; codec_type: "video" | "audio" | string;
  codec_name?: string;          // 追加
  width?: number; height?: number; avg_frame_rate?: string; duration?: string; // duration 追加
}
```

### config
**追加不要**。OCR は既存 `cfg.ocr.languages`、文字起こしは既存 `cfg.whisper.{bin,model,language}` を
再利用する。素材文字起こしに語単位タイムスタンプは不要なので `-oj`(`-ojf` ではない)で呼ぶ。

---

## 5点セット等への波及

スキーマ(編集可能ファイルの型)は**変えない**ので `schemas/*.schema.json` / `examples/*.max.json` /
`test/schema.test.ts` / `src/stages/validate.ts` は**対象外**。触るのは:

- **`src/lib/files.ts`**: `GENERATED_DIRS` に `"materials.probe"` を追加(素材知覚の生成物を
  「手編集しない generated」に分類)。→ これに連動して次の 2 つの pin を追随:
- **`CLAUDE.md`**: (1)「中間生成物は編集しない」一覧に `materials.probe/`(と中の index.json/PNG/
  ocr.json/transcribe.json)を追記。(2)「動画の中身を知る方法(AI の知覚)」に `materials` コマンドを
  追記。(3)「コマンド」節に `materials <dir>` を追記。
- **`AGENTS_CONTRACT.md`**: §4「Files you must NOT write」の generated dirs に `materials.probe/`、§10
  Commands 表に `materials <dir>` を追記(**`test/agentsMd.test.ts` が編集ファイル一覧・
  GENERATED_FILES・コマンド名を pin しているので、files.ts と同時に更新しないと `npm test` が落ちる**)。
- **`docs/usage.md`**: `materials` コマンドの節(フラグ・出力・キャッシュ・座標系)を新設。
- **`config.yaml`**: 追記なし(既存 ocr/whisper を再利用)。

---

## タスク分解(1 タスク = 1 コミット・小さく直列)

### タスク1:ffprobe 拡張 + probe 要約(純関数)
- **触るファイル**: `src/lib/ffmpeg.ts`、`test/ffmpeg.test.ts`(新規 or 拡張)。
- **中身**: `ProbeStream` に `codec_name?`/`duration?` を**追加のみ**。`summarizeProbe(ProbeResult):
  MaterialProbe` を新設(video/audio/image を種別判定し尺・寸法・fps・codec・hasAudio を出す純関数)。
- **テスト**: `summarizeProbe` を fixture の ffprobe JSON(音声付き動画・無音動画・画像・音声のみ)で
  固定。実 ffprobe は呼ばない(外部依存をテストに持ち込まない)。`parseFps` は既存流用。
- **壊してはいけない**: 既存 `probe()` の呼び出し元(`ingest` 等)。フィールドは**追加のみ**で
  戻り値の既存キーは不変。

### タスク2:素材列挙・参照解決・キャッシュキー(純関数中心)
- **触るファイル**: `src/lib/materials.ts`(新規)、`test/materials.test.ts`(新規)。
- **中身**: (i) 参照集合の構築(overlays[].file ∪ inserts[].file ∪ bgm.tracks[].file、各要素の
  `@id`/時刻を `MaterialRef` に)。(ii) `materials/` 実在ファイル ∪ 参照集合の和で対象決定、present/
  used/dangling 判定。(iii) `<slug>` 生成(相対パス安全化)。(iv) mtime+size フィンガープリント比較
  (`proxyCache` 流用の等値判定)。(v) 注入された probe 結果から `MaterialsIndex` を組み立てる関数。
- **テスト**: 参照解決(未使用・dangling・複数参照)・slug 衝突回避・フィンガープリント等値・index
  組み立てを、**注入した probe 結果**で単体固定(実 ffprobe/ffmpeg 非依存)。
- **壊してはいけない**: 新規ファイルのみ・未参照=既存挙動ゼロ影響。

### タスク3:`materials` コマンド(probe だけ)を配線 + 生成物登録
- **触るファイル**: `src/stages/materials.ts`(新規・オーケストレータ)、`src/cli.ts`(コマンド定義)、
  `src/lib/files.ts`(`GENERATED_DIRS += "materials.probe"`)。
- **中身**: タスク1/2 を束ね、既定(probe のみ)で `materials.probe/index.json` を書き、stdout に
  要約を出す。キャッシュ再利用(不変素材の probe をスキップ)を通す。
- **テスト**: `fileRole("materials.probe/index.json") === "generated"` の単体追加。**主検証は bench
  実データ**(下記)。
- **壊してはいけない**: 他パスの `fileRole` 分類・既存コマンド。`materials/` は依然 `"other"`。

### タスク4:`--frames`(代表フレーム抽出)
- **触るファイル**: `src/lib/materials.ts`(フレーム抽出)、`src/lib/ffmpeg.ts` or `screenStill.ts`
  (クロップ無し still 引数ビルダの純関数を追加/一般化)、`src/stages/materials.ts`(配線)、`src/cli.ts`。
- **中身**: 動画は中点 still を `materials.probe/<slug>.png` へ。画像は自身のパスを `frame.file` に記録
  (複製しない)。キャッシュ(不変素材のフレームは再抽出しない)。
- **テスト**: still 引数ビルダ(`-ss` 値・`-frames:v 1`)の純関数固定。bench 動画で PNG が出て
  中点フレームらしいことを目視(補助)。
- **壊してはいけない**: `--frames` 未指定時は PNG を書かない・呼ばない。

### タスク5:`--ocr`(フレーム/画像 OCR)
- **触るファイル**: `src/lib/materials.ts`、`src/stages/materials.ts`、`src/cli.ts`。
- **中身**: 動画は代表フレーム(--frames 含意)を、画像は画像自身を `runOcr` に渡す(`region` =
  その画像の画素寸法 → box は素材ピクセル座標)。`materials.probe/<slug>.ocr.json` を書き、index に
  プレビュー+件数+パスを載せる。非対応環境は `runOcr` が null → 警告のみで probe 出力は成功。
- **テスト**: OCR の純関数(`toOcrResult`/座標)は既存 `test/ocr.test.ts` が担保。bench の
  `slide-01.png` を OCR してテキストが取れることを実測。
- **壊してはいけない**: `--ocr` 未指定時は OCR を一切呼ばない。macOS 以外での劣化。

### タスク6:`--transcribe`(素材音声の文字起こし)
- **触るファイル**: `src/lib/materials.ts`、`src/stages/materials.ts`、`src/cli.ts`。
  (whisper 呼び出しは `transcribe.ts` を**リファクタせず**、`extractAudio`(既存 ffmpeg.ts)+ 最小の
  `run(cfg.whisper.bin, [-oj ...])` を materials 側に持つ。transcribe.json 生成の byte-equal を守るため
  既存 `transcribe.ts` には触れない。)
- **中身**: `hasAudio` の素材だけ対象。`extractAudio(material, 0, tmpWav)` → whisper `-oj` → segments を
  `materials.probe/<slug>.transcribe.json` に。whisper モデル欠如は警告してスキップ。重いのでキャッシュ
  (不変素材は再文字起こししない)を確実に効かせる。
- **テスト**: bench の `short.mp4`(音声あり)を文字起こしし text が取れることを実測。無音素材
  (`slide-01.png`)は対象外になること。
- **壊してはいけない**: `--transcribe` 未指定時は whisper を呼ばない。`transcript.json`(本編)や
  `whisper-out.*` に一切触れない(素材の出力は `materials.probe/` 内だけ)。

### タスク7:ドキュメント同期
- **触るファイル**: `CLAUDE.md`(中間生成物一覧・知覚手段・コマンド一覧)、`AGENTS_CONTRACT.md`(§4・§10)、
  `docs/usage.md`(新節)。
- **テスト**: `npm test`(`test/agentsMd.test.ts` の pin が緑)。`validate` は無関係に通る。
- **壊してはいけない**: files.ts の分類と AGENTS_CONTRACT.md/CLAUDE.md 記述の一致(pin テスト)。

**実装順序(依存)**: T1(probe)→ T2(列挙・参照・キャッシュ)→ **T3(probe だけで end-to-end。
ここで診断の blocker=尺・音声・寸法は解消・出荷可能)** → T4(frame)→ T5(ocr, T4 に依存)→
T6(transcribe)→ T7(docs)。T4〜T6 は互いに独立の加算層。

---

## 実装子が先に読むコード(シンボル名)

- `src/lib/ffmpeg.ts` — `probe()`(ffprobe 呼び出し・`ProbeResult`/`ProbeStream`。拡張対象)、
  `extractAudio()`(素材音声 wav 抽出。T6 で流用)、`parseFps()`。
- `src/lib/screenStill.ts` — `screenStillArgs()`/`buildScreenStill()`(ffmpeg still の前例。T4 は
  クロップ無し版に一般化)。
- `src/lib/ocr.ts` — `runOcr(imagePath, region, opts)`・`toOcrResult`・`OcrResult`/`OcrLine`
  (T5 で流用。`region` に素材フレーム寸法を渡すと box が素材ピクセル座標になる)。優雅な劣化の作法。
- `src/stages/transcribe.ts` — whisper 呼び出しの前例(`run(cfg.whisper.bin,[-oj/-ojf,-osrt,-of,...])`・
  JSON パース)。**流用のみ・リファクタしない**(byte-equal 厳守)。
- `src/stages/describe.ts` — `loadDescribeInputs`(overlays/inserts/bgm の読み方)・`MaterialEntry`
  (`overlays.materials[]` の既存射影・`exists` 判定の前例)・`InsertEntry`。参照集合の作り方の手本。
- `src/lib/files.ts` — `GENERATED_DIRS`・`fileRole`(`materials.probe` 追加箇所)。
- `src/lib/proxyCache.ts` — `ProxyCacheKey`/`buildProxyCacheKey`/`proxyCacheKeyEquals`
  (mtime+size フィンガープリントの手本。素材キャッシュはこれに倣う)。
- `src/lib/framesIndex.ts` — index.json + フィンガープリントの二役の前例(ただし素材は内容ハッシュ
  ではなく mtime+size を採る点が違う)。
- `src/types.ts` — `overlays[]`(`file`/`rect`/`fit`/`volume`)・`inserts[]`(`at`/`durationSec`/`file`)・
  `bgm.tracks[]`(`file`)・`@id` 各要素。参照集合とクロスリンクの対象。
- `src/cli.ts` — frames コマンド定義(オプション追加・action・shot の echo)。`materials` はこの
  型に倣って足す。
- bench: `~/Movies/cutflow/2026-07-02-whisper-bench/materials/`(opening.mp4/outro.mp4/short.mp4/
  short-2.mp4/slide-01.png/favicon.png/mp3 2本)・同フォルダの `overlays.json`/`bgm.json`。

---

## 実測検証(bench 収録)

対象: `~/Movies/cutflow/2026-07-02-whisper-bench`(materials/ に動画4・画像2・mp3 2本)。
中立 cwd から絶対パスで走らせる(`MEMORY.md` llm-command-verify-neutral-cwd に倣い repo 直下の
文脈汚染を避ける)。

1. **probe だけ(T3)**:
   ```
   node src/cli.ts materials <bench>
   ```
   → stdout に各素材の種別・尺・解像度・fps・音声有無。`opening.mp4`/`outro.mp4`/`short.mp4`(動画・
   多くは音声あり)、`slide-01.png`/`favicon.png`(画像・尺/音声なし)、mp3 2本(audio)。
   `materials.probe/index.json` を Read し、`overlays.json`/`bgm.json` の参照とクロスリンクされ、
   未使用素材(参照ゼロ)・dangling(あれば)が印されることを確認。`ffprobe` 実尺と手編集の
   `inserts[].durationSec` の乖離が読み取れることを確認(尺超過検出の要)。

2. **`--frames`(T4)**:
   ```
   node src/cli.ts materials <bench> --frames
   ```
   → `materials.probe/materials__opening.mp4.png` 等が動画本数ぶん出る。画像は複製されず
   `frame.file` が元パスを指す。中点フレームらしいことを目視(補助)。

3. **`--ocr`(T5)**:
   ```
   node src/cli.ts materials <bench> --ocr
   ```
   → `slide-01.png`(スライド=文字が主役)の `.ocr.json` にスライド内テキストが取れる。動画は代表
   フレームの OCR。box が素材ピクセル座標であることを `image:{w,h}` と突き合わせて確認。

4. **`--transcribe`(T6)**:
   ```
   node src/cli.ts materials <bench> --transcribe
   ```
   → 音声付き素材(`short.mp4` 等)の `.transcribe.json` に発話テキスト。`slide-01.png` は
   hasAudio=false で対象外。

5. **キャッシュ(T3〜T6)**: 2 回目実行が、変更のない素材の probe/frame/ocr/transcribe を再計算せず
   高速に返す(特に `--transcribe`)。1 本を `touch` で mtime を変える or 差し替えると、その素材だけ
   撮り直される。

6. **既存不変(最重要)**:
   - `materials` を一度も実行しなければ既存出力は 1 バイトも変わらない(新コマンド・新生成物のみ)。
   - `describe`(散文 / `--json`)・`transcript.json`・`whisper-out.*` は不変。
   - `npm run typecheck` と `npm test`(既存 + 追加純関数 + agentsMd/files の pin)が緑。
   - `--ocr`/`--transcribe` を非対応・モデル欠如環境で実行しても probe 層の出力は成功で返る(劣化)。

「素材の中身を AI が知れる」と言える条件 = **手順1で尺・音声・解像度と参照/未使用が index に出る**こと
(blocker 解消)。手順2〜4 は見た目・画面文字・素材発話の opt-in 上乗せ。
