# AI の耳を強化する(システム音声の文字起こし・トラック帰属・keep 内の間)設計

- 対象: NLE 診断レビュー Theme A / Next「非言語音・システム音声の文字起こし・話者分離・keep 内の間」(severity major / effort M)
- 診断: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md`(読むだけ。**このファイルは触らない**)
- 前提規約: `CLAUDE.md`(全編集は平文 JSON / 時刻は元収録の秒 / 既定オフ・未使用時バイト等価が鉄則 / ローカルファースト・決定論・依存を増やさない)
- 手本にする既存設計: `docs/plans/2026-07-07-plan-eyes-ears-design.md`(`plan.perception` の opt-in / 不在時バイト等価パターン)と `whisper.wordTimestamps`(`-oj`/`-ojf` 切替でバイト等価を守る規律)

---

## 0. 問題の一行要約

文字起こしは **micWav のみ**。最終出力に mix される**システム音声**(デモ音・
再生動画・TTS。`render.systemAudio.mix` で既に「聞こえる」)は文字起こしされず
AI から**不可視**。非言語音(笑い・間・SFX)も話者分離も keep 内の間の位置も
取れていない。「AI の耳」を micWav 一本足から、**トラック単位で分けて聴ける耳**へ
広げる。

既に判明している構造(再調査済み):

- `ingest`(`src/stages/ingest.ts`)は `systemStream` の**存在を検出するだけ**で
  wav 抽出も文字起こしもしない。`micWav`(16kHz mono)だけを `extractAudio` する。
- `transcribe`(`src/stages/transcribe.ts`)は `manifest.audio.micWav` に対してだけ
  whisper を回し `transcript.json` を出す。
- `detect`(`src/stages/detect.ts`)→ `cuts.auto.json` の `silences[]` が唯一の
  「無音・間」の一次データ。**新規計測を足さずここから引ける。**
- `lib/perception.ts` は既に `silences` から区間内無音の**合計**(`silenceWithin`)と
  直前カット(`gapBefore`)を計算し `plan` に渡している(opt-in `plan.perception.audio`)。
- `render`/`preview` は `lib/loudness.ts` の `audioSourceOf` が `systemStream` を
  拾って **mix はする**(聞こえる)。が、その音声を**読める形にはしていない**。
- `describe`(`src/stages/describe.ts`)散文は golden(`test/fixtures/describe.golden.txt`)で
  バイト固定。`--json` は「トップレベル構造キーは常在・要素内任意フィールドは
  元ファイルに在るときだけ」(規則C)。

---

## 1. スコープ規律(最初に線を引く)

**やる**:

1. **システム音声の文字起こし**(opt-in)。`systemStream` があるとき wav 抽出 →
   whisper で第2トラックとして起こし、**描画しない知覚専用ファイル
   `transcript.system.json`** に書く。
2. **トラックベースの話者帰属**を「話者分離」の実体として正直に宣言する
   (mic=ホスト / system=アプリ・デモ・TTS)。音響 diarization はやらない。
3. **keep 内の間**を「合計秒」だけでなく**位置と長さ**として引けるようにする
   (既存 `silenceWithin` の差分。`cuts.auto.json` から。新規計測なし)。
4. これらを **describe(操作エージェント)と plan(カット判断 LLM)**の両経路へ、
   すべて既定オフ・不在時バイト等価で露出する。

**やらない(本 Feature の外・§9 で再検討トリガーを明記)**:

- **音響話者分離**(pyannote 等の話者埋め込みクラスタリング)= 重 ML・思想違反。
  1本のマイクに複数人が乗る収録の分離は Later。
- **非言語音の分類**(笑い・拍手・SFX の event tagging)= 決定論・dep-free で
  安定に取れない(§論点4)。Later。
- **区間音量(RMS/ラウドネス)計測** = detect に新規パスが要る(eyes-ears doc D2 で
  既に不採用)。本 Feature でも足さない。
- **画像マルチモーダル・エージェントループ化** = eyes-ears doc の管轄。触らない。
- **`plan-shorts` への知覚接続**・**`words[].confidence` の流用** = 別トラック。
- **編集ファイルとしての transcript.system.json**(手編集・GUI 露出・描画)。
  これは知覚専用の生成物であって編集対象ではない(§論点1)。

---

## 2. 決定サマリ(decisions.md 形式)

| # | 論点 | 決定 | 理由(要約) |
|---|---|---|---|
| D1 | システム音声の格納先 | **別ファイル `transcript.system.json`**(GENERATED カテゴリ・知覚専用・非描画)。`transcript.json`(EDITABLE・描画データ)には**混ぜない** | 役割分離が最重要。micWav transcript は `track`/`pos`/`style`/`words` を持つ**描画契約**で人間/GUI が編集する。system transcript は**読むだけ**で描画されない。同一配列に混ぜると (a) render がシステム発話をテロップ化してしまう事故、(b) `transcript.json` のバイト等価が壊れる、(c) `@id`/承認 hash/apply スキーマへ波及。別ファイルなら EDITABLE の契約を1バイトも動かさない |
| D2 | 抽出とトランスクライブの担当段 | **ingest が `audio/system.wav` を抽出**(raw ソースを持つのは ingest だけ)、**transcribe が第2回 whisper** を回して `transcript.system.json` を書く。両方 `whisper.systemAudio`(既定 false)でゲート | `micWav` と対称。`transcribe` は raw を持たず manifest 経由で wav を読むので、抽出は ingest に置くのが自然。whisper 実行は transcribe に集約 |
| D3 | 既定オフ・バイト等価の担保 | 新 config `whisper.systemAudio`(既定 false)。false のとき ingest は `system.wav` を作らず manifest に `systemWav` を**書かない**、transcribe は第2回 whisper を回さず `transcript.system.json` を**作らない** | `whisper.wordTimestamps` と同型の opt-in。off なら `manifest.json`/`transcript.json`/`whisper-out.*` が導入前と完全一致 |
| D4 | 話者分離の線引き | **トラックベース帰属**を「話者分離」とする。mic=`speaker: "host"` 相当 / system=`speaker: "system"` 相当。音響 diarization は**やらないと正直に宣言**(§論点2) | ローカル・決定論・追加依存ゼロで OBS の2トラック収録の実態(声 vs アプリ音)にちょうど一致する。honest-scoping 精神 |
| D5 | keep 内の間の表現 | 純関数 `pausesWithinKeeps(keeps, silences)` を `cuts.auto.json` から算出。**plan** へは既存 `SegmentAudioFeature` に「最長の間+その位置」を足す(集合 `silenceWithin` の差分=**どこに**があるか)。**describe** へは opt-in で per-keep の間リストを出す | 新規計測ゼロ。plan は既に総量を持つので差分は「位置」。describe は操作エージェントが「ここを詰める」判断をする材料 |
| D6 | 非言語音(笑い/SFX/強調) | **本 Feature では実装しない**(§論点4)。whisper 特殊トークンは既に `buildWords` で除去済みで日本語 large-v3 はほぼ出さない。ピーク検出は新規計測が必要 | dep-free で安定に取れないものを撃たない。過剰実装しない。Later + トリガーを明記 |
| D7 | plan への露出 | 既存 `renderPerceptionBlock` を **3ブロック**(audio / **systemSpeech** / ocr)へ拡張。systemSpeech は `plan.perception.systemSpeech`(既定 false)+ `transcript.system.json` 存在の**両方**が真のときだけ。区間へは overlap 帰属 | `plan.perception.ocr` の overlap 帰属パターン(`computeSegmentOcr`)を踏襲。不在時 `""` でバイト等価 |
| D8 | describe への露出 | system transcript は**ファイル存在**でゲート(既存収録は当該ファイルが無い→散文 golden も `--json` もバイト等価)。keep 内の間は新 config `describe.pauses`(既定 false)でゲート | describe には project 単位の opt-in が無いので、ファイル存在/新フラグで「未使用時バイト等価」を作る。golden を1バイトも動かさない |

**「話者分離をやらない」ことの明文化(D4 の詳細・honest-scoping)**:
本 Feature の「話者分離」は**収録トラックによる音源の分離**であって、1本の音声波形から
複数話者を聞き分ける**音響 diarization ではない**。OBS の2トラック収録では「人間の声」と
「アプリ/デモ/TTS の音」が**物理的に別トラック**に分かれて録れているので、トラックを
分けて文字起こしするだけで「誰(何)が喋ったか」の実用上の分離になる。1本のマイクに
複数のホストが乗る収録での話者ごとの分離は、pyannote 等の重い ML 依存を招き
ローカル・ソロ保守・決定論の思想に反するため**やらない**(§9 にトリガー)。

---

## 3. config スキーマ案(すべて既定オフ)

### 3.1 `src/lib/config.ts` の `Config`

```ts
whisper: {
  bin: string;
  model: string;
  language: string;
  wordTimestamps?: boolean;
  /** システム音声(ingest.systemTrack)も第2トラックとして文字起こしし、
   *  知覚専用の transcript.system.json を書くか。省略時 false(既存挙動と
   *  完全一致=system.wav も transcript.system.json も作らず manifest も不変)。
   *  render.systemAudio.mix(=出力に音を混ぜる)とは別軸で、こちらは
   *  「AI がその音を読めるようにする」= 描画はしない知覚専用。
   *  収録に systemStream が無ければ true でも自動で無視 */
  systemAudio?: boolean;
};

plan?: {
  perception?: {
    audio?: boolean;
    ocr?: boolean;
    ocrMaxSegments?: number;
    ocrMaxLines?: number;
    /** システム音声の発話(transcript.system.json)のうち各区間に重なるものを
     *  plan の知覚ブロックに添える。省略時 false。transcript.system.json が
     *  無ければ(= whisper.systemAudio 未使用)自動で劣化=ブロック省略 */
    systemSpeech?: boolean;
  };
};

/** describe(操作エージェント向け)の任意露出。省略可・全オフが既定。
 *  無いときは散文・--json ともに導入前とバイト等価 */
describe?: {
  /** keep 内に残った無音(間)の「位置と長さ」を describe に出す。省略時 false。
   *  cuts.auto.json の silences から算出(新規計測なし) */
  pauses?: boolean;
  /** 1区間あたり出す間の件数上限。省略時 DEFAULT_DESCRIBE_PAUSE_MAX(3) */
  pauseMax?: number;
  /** これ以上の長さの間だけ出す(秒)。省略時 DEFAULT_DESCRIBE_PAUSE_MIN_SEC(0.6) */
  pauseMinSec?: number;
};
```

追加する既定定数と解決純関数:

```ts
export const DEFAULT_DESCRIBE_PAUSE_MAX = 3;
export const DEFAULT_DESCRIBE_PAUSE_MIN_SEC = 0.6;

/** describe.pauses を既定で解決(省略時オフ)。loadConfig は cfg.describe を
 *  書き換えない(省略=オフ=バイト等価) */
export function resolveDescribePausesCfg(cfg: Config): {
  enabled: boolean; max: number; minSec: number;
};
```

- `resolvePerceptionCfg`(既存)に `systemSpeech: p.systemSpeech ?? false` を追加。
- `loadConfig` は `cfg.whisper.systemAudio ??= false` **のみ**追加(`wordTimestamps` と
  同じ defaulting。false は挙動不変)。`cfg.plan`・`cfg.describe` は**書き換えない**
  (省略=オフを解決関数が担保)。

### 3.2 `config.yaml`(値は既定オフのまま。コメントで存在を知らせる)

```yaml
whisper:
  # ...既存...
  # システム音声(systemTrack)も第2トラックとして文字起こしする(知覚専用・
  # 描画しない)。既定 false。true で transcript.system.json を書く
  systemAudio: false

plan:
  perception:
    # ...既存...
    systemSpeech: false  # システム音声の発話を plan に添える(要 whisper.systemAudio)

# describe の任意露出(既定オフ=散文/--json ともバイト等価)
# describe:
#   pauses: false      # keep 内の間の位置と長さを出す
#   pauseMax: 3
#   pauseMinSec: 0.6
```

---

## 4. システム音声の文字起こし(D1–D3)

### 4.1 データフロー

```
ingest:  raw.mkv --(systemStream != null かつ whisper.systemAudio)--> audio/system.wav
         manifest.audio.systemWav = "audio/system.wav"   (フラグ off なら未設定)

transcribe: manifest.audio.systemWav があれば
            whisper -f system.wav -of whisper-system-out  --> transcript.system.json
            (micWav の第1回 whisper とは独立の第2回。id 引き継ぎ・words は不要)
```

- `ingest.ts`: `hasSystem && cfg.whisper.systemAudio` のとき `extractAudio(source,
  systemIndex, audio/system.wav)` を追加で1回。manifest に `systemWav` を足す。
  **フラグ off のとき manifest は現状とバイト等価**(オプショナルキー未設定)。
- `transcribe.ts`: `manifest.audio.systemWav` が在れば第2回 whisper を回す。
  出力ベース名は `whisper-system-out`(micWav の `whisper-out` と対称)。
  system transcript は**描画しない**ので `-osrt` は不要・`-oj`(words 不要)固定で
  よい(micWav 側の `wordTimestamps` 設定に引きずられない)。id 引き継ぎ
  (`applyTranscriptIds`)も**しない**(system transcript は `@id` の対象外)。
- **micWav 側のロジック(§transcribe の 78–146 行)には一切触れない。**
  第2回は「micWav が終わった後の別ブロック」として足す(wordTimestamps 付加が
  「別ステップ」として足された §118–124 と同じ規律)。

### 4.2 型(`src/types.ts`)

```ts
export interface Manifest {
  // ...
  audio: {
    micStream: number;
    systemStream: number | null;
    micWav: string;
    /** システム音声の抽出済み wav(whisper.systemAudio 有効時のみ)。
     *  省略時=未抽出(既定・バイト等価)。相対パス */
    systemWav?: string;
  };
}

/** transcribe が生成する知覚専用のシステム音声文字起こし
 * (transcript.system.json)。**描画されない**(テロップにならない)。
 * plan / describe が「アプリ・デモ・TTS が何を鳴らしたか」を読むためだけの
 * 生成物(GENERATED カテゴリ)。track/pos/style/words/id を持たない
 * (描画・アドレッシングの契約は transcript.json だけが担う)。
 * 時刻は他と同じく元収録(raw)の秒 */
export interface SystemTranscript {
  language: string;
  model: string;
  /** 話者帰属(トラックベース)。常に "system"(将来トラックが増えたら拡張)。
   *  mic 側は transcript.json = "host" 相当という対比を明示する情報フィールド */
  speaker: "system";
  segments: { start: number; end: number; text: string }[];
}
```

`SystemTranscript` は `Transcript` を**継承・再利用しない**(意図的)。描画フィールドを
構造的に持たないことで「これは描画されない」を型で表す。

### 4.3 ファイル分類(`src/lib/files.ts` / `AGENTS.md`)

`GENERATED_FILES` に追加:

```
"transcript.system.json",
"whisper-system-out.json",
```

- `audio/system.wav` は `audio/mic.wav` と同じ扱い(現状 `audio/` は分類対象外=
  "other")。ここは**変えない**(micWav と対称に保つ)。
- `transcript.system.json` は**編集ファイルではない**(EDITABLE_FILES に入れない)。
  CLAUDE.md の「中間生成物は編集しない」一覧にも追記する。
- `AGENTS.md` の生成物一覧(`test/agentsMd.test.ts` が `GENERATED_FILES` を
  ピン留め)を同期。

> **5点セットの適用範囲**: 本 Feature の新 JSON は**すべて GENERATED**
> (`cuts.auto.json`/`manifest.json` と同格で `schemas/*.schema.json` を持たない)。
> よって `schemas/*` は**触らない**。editable の validate.ts も**触らない**
> (system transcript は検査対象外)。5点セットのうち本 Feature が触るのは
> `types.ts` コメント / `docs/usage.md` / `AGENTS.md`(+ files.ts・CLAUDE.md)。

---

## 5. トラックベース話者帰属(D4)

- 実装は §4 の「トラック別ファイル」がそのまま話者分離になる:
  `transcript.json` = host(マイク=人間)、`transcript.system.json` = system(アプリ)。
- describe / plan の露出時に **`[システム音声]` / `[app]`** のラベルで明示する
  (§6・§7)。これ以上のラベル体系(複数アプリの区別等)は作らない。
- **正直な宣言(doc・CLAUDE.md・usage.md に明記)**: 「これはトラック起源による
  分離であって、1トラック内の複数話者を聞き分ける音響話者分離ではない」。

---

## 6. keep 内の間(D5)— 既存 `silenceWithin` との差分

### 6.1 差分の定義

| | 既存 `silenceWithin` | 新規 `pausesWithinKeeps` |
|---|---|---|
| 露出先 | **plan のみ**(perception.audio) | **plan(位置追加)+ describe** |
| 粒度 | 区間内無音の**合計秒**(スカラ) | **個々の間**の {位置, 長さ} のリスト |
| 判断 | 「この区間は間が多い」 | 「**ここ**(0:15 付近)に 1.2 秒の間 → 詰める/カット足す」 |
| 出所 | `cuts.auto.json` silences | 同じ(**新規計測ゼロ**) |

### 6.2 純関数(`src/lib/perception.ts`)

```ts
/** keep 内に残った無音(間)1件。位置は keep 先頭からのオフセット(出力秒相当の
 *  尺)と元収録秒の両方を持つ(describe は元秒で、plan は相対で語る) */
export interface KeepPause {
  /** この間が属する keep のインデックス(0始まり) */
  keepIndex: number;
  /** 元収録秒の区間(silence ∩ keep をクリップしたもの) */
  start: number;
  end: number;
  /** 長さ(秒・丸め済み) */
  len: number;
  /** keep 先頭からのオフセット(秒) */
  offset: number;
}

/** silences ∩ 各 keep を、minSec 以上・keepIndex/start 昇順で返す純関数。
 *  cuts.auto.json だけから引ける(detect への新規計測なし) */
export function pausesWithinKeeps(
  keeps: Interval[], silences: Interval[], minSec: number,
): KeepPause[];
```

- **plan 差分**: `SegmentAudioFeature` に `longestPause: number`(最長の間の秒。0=なし)を
  足し、`formatAudio` の行を `#3 尺6.5 / 直前カット2.1 / 内無音0.8(最長0.5)` にする。
  「合計」に「最長1件」を添えるだけの最小差分。**`plan.perception.audio` が真のときだけ**
  効くので off なら現状とバイト等価。
- **describe 差分**: `describe.pauses` が真のとき、各 keep の行の下に
  `間 0:15 (1.2秒) / 0:41 (0.7秒)` を最大 `pauseMax` 件・`pauseMinSec` 以上だけ出す。
  `--json` の `KeepEntry` に optional `pauses?: KeepPause[]` を足す(フラグ off で省略=
  規則C の「任意フィールドは在るときだけ」に合致し既存 --json とバイト等価)。

---

## 7. plan(カット判断 LLM)への露出(D7)

`renderPerceptionBlock` を **3引数**へ拡張(既存の `renderRulesBlock` 型不変条件を維持):

```ts
export function renderPerceptionBlock(
  audio: SegmentAudioFeature[] | null,
  system: SegmentSystemSpeech[] | null,   // ← 追加
  ocr: SegmentOcr[] | null,
): string; // 全 null/空 → "" 、存在時のみ "\n…\n"
```

- `SegmentSystemSpeech { id: number; lines: string[]; text: string }` を追加し、
  各区間に overlap するシステム発話を集める `computeSystemSpeech(numbered,
  systemSegments)`(純関数)を新設。`computeSegmentOcr` の overlap 帰属を踏襲。
- `formatSystemSpeech` の見出しは
  `## 各区間のシステム音声(アプリ/デモ/TTS。マイク発話ではない)`。
- 配線(`plan()`):

```ts
const pc = resolvePerceptionCfg(cfg);
const systemSegs = pc.systemSpeech ? loadSystemTranscript(dir) : null; // 無ければ null
const system = systemSegs ? computeSystemSpeech(numbered, systemSegs) : null;
const perception = renderPerceptionBlock(audio, system, ocr);
```

- **バイト等価**: `pc.systemSpeech` false または `transcript.system.json` 不在なら
  `system=null` → `renderPerceptionBlock` は現状と同じ出力(既存の audio/ocr のみ)。
  `{{perception}}` のプレースホルダ配置(eyes-ears doc §6.2)は**変えない**。
- `remeta` / `plan --cuts-only` にも同じ配線(既存 audio/ocr と同経路)。
- **`{{segments}}` は不可侵**。システム発話は `{{perception}}` にだけ入る。

---

## 8. describe(操作エージェント)への露出(D8)

### 8.1 システム音声(ファイル存在でゲート)

- `loadDescribeInputs` に `systemTranscript: SystemTranscript | null` を追加
  (`readOptional`。ファイル不在=null)。
- **散文**: 各 keep の発話行の後に、その keep に重なるシステム発話を
  `    [システム音声] 「…」` として出す。**null のとき1行も足さない**
  → 既存収録は golden とバイト等価。カットで消える区間にも
  `消える発言 [システム音声]…` を対称に出せる(任意・golden 不変が前提)。
- **`--json`**: トップレベルに optional `systemAudio?: SystemAudioProjection`
  (`{ segments: {start,end,text,out}[] }`。out は timeline 射影)。**ファイル不在で
  キーごと省略**。既存 --json 出力(fixtures にファイル無し)はバイト等価。
  - 規則C は「トップレベル常在」だが、本キーは**新規で後方の全既存プロジェクトが
    不在**なので、常在にすると既存 --json のバイトが動く。ゆえに「新規任意成果物は
    存在時のみ」を明示的な例外として doc 化(バイト等価を規則C より優先)。

### 8.2 keep 内の間(`describe.pauses` でゲート)

- §6.2 のとおり。`resolveDescribePausesCfg(cfg).enabled` が false(既定)なら
  散文も `--json` も現状と1バイトも変わらない。

---

## 9. タスク分解(1タスク=1コミット)

### タスク1: config スキーマ + 解決純関数(挙動変化なし)

- **触る**: `src/lib/config.ts` — `whisper.systemAudio`(+ `loadConfig` の
  `??= false`)、`plan.perception.systemSpeech`(`resolvePerceptionCfg` に追加)、
  `describe?.{pauses,pauseMax,pauseMinSec}` + `DEFAULT_DESCRIBE_PAUSE_MAX` /
  `DEFAULT_DESCRIBE_PAUSE_MIN_SEC` + `resolveDescribePausesCfg`。
  `config.yaml` — コメント/既定 false の行(§3.2)。
- **テスト**(`test/config.test.ts`): (1) 省略 config で `systemAudio=false` /
  `systemSpeech=false` / `describe` オフ+既定値、(2) 部分指定で他が既定、
  (3) `loadConfig` が `cfg.plan`・`cfg.describe` を**生成しない**、
  `cfg.whisper.systemAudio` は `false` に defaulting される。
- **壊すな**: 既存 `resolvePerceptionCfg`(audio/ocr/上限)の返り値、
  `wordTimestamps`/`ocr.languages` の defaulting。

### タスク2: ingest のシステム音声抽出(opt-in・manifest 拡張)

- **触る**: `src/types.ts`(`Manifest.audio.systemWav?` コメント)、
  `src/stages/ingest.ts`(`hasSystem && cfg.whisper.systemAudio` で `system.wav` 抽出+
  manifest に `systemWav` 設定)。
- **テスト**(`test/ingest.test.ts` があれば追加、無ければ純度の高い分岐を関数化して
  unit): フラグ off → manifest に `systemWav` キーが出ない(現状オブジェクトと
  deep-equal)。フラグ on かつ systemStream=null → やはり出ない。
  実データ検証(§10)で on+2トラック合成ファイルの抽出を確認。
- **壊すな**: `micWav` 抽出・`resolveLayout`・plain レイアウトの manifest。
  **off のとき manifest.json はバイト等価**(既存収録の再 ingest で diff ゼロ)。

### タスク3: transcribe の第2回 whisper(transcript.system.json)

- **触る**: `src/types.ts`(`SystemTranscript`)、`src/stages/transcribe.ts`
  (micWav ブロックの後に、`manifest.audio.systemWav` があれば第2回 whisper →
  `transcript.system.json` を書く独立ブロック)、`src/lib/files.ts`
  (`GENERATED_FILES` に `transcript.system.json` / `whisper-system-out.json`)、
  `AGENTS.md`(生成物一覧同期)。
- **テスト**: `buildWords` 相当の純粋パース関数を切り出すなら unit で固定。
  `test/agentsMd.test.ts` / `test/files` 系(あれば)が `GENERATED_FILES` 追加で
  緑になることを確認。バイト等価: `systemWav` 未設定 manifest では第2回が走らず
  `transcript.system.json` が作られない(=既存収録の transcribe 出力不変)。
- **壊すな**: micWav 側の segment 生成・`applyTranscriptIds`・`transcript.json` の
  内容(第2回は完全に別 wav・別出力ベース名・id 引き継ぎなし)。

### タスク4: plan への systemSpeech 露出(opt-in・優雅な劣化)

- **触る**: `src/lib/perception.ts`(`SegmentSystemSpeech`、`computeSystemSpeech`、
  `formatSystemSpeech`、`renderPerceptionBlock` を3引数へ、`loadSystemTranscript(dir)`
  のような存在チェック付きローダ)、`src/stages/plan.ts`(3引数呼び出しへ配線。
  `plan`/`plan --cuts-only`/`remeta` の3経路)。
- **テスト**(`test/perception.test.ts` 追加): `computeSystemSpeech` の overlap 帰属
  (部分重なり・非重なり)、`renderPerceptionBlock(a,null,o)` が現行2引数時代と同一
  文字列(**回帰 golden**)、`(null,null,null)===""`、system ありで見出し行を含む。
- **壊すな**: 既存 `renderPerceptionBlock` の呼び出し側(2→3引数化に伴い全呼出を
  更新)。**audio/ocr のみのときの出力が現状とバイト等価**(既存
  `test/perception.test.ts` の緑を維持)。`{{segments}}`・プレースホルダ配置不変。

### タスク5: describe への露出(system transcript + keep 内の間)

- **触る**: `src/stages/describe.ts`(`loadDescribeInputs` に systemTranscript 読込・
  散文の keep 行への system 発話追記・`--json` の optional `systemAudio` /
  `KeepEntry.pauses`)、`src/lib/perception.ts`(`pausesWithinKeeps` を再利用)。
- **テスト**: `pausesWithinKeeps` の純関数 unit(minSec フィルタ・offset・
  keepIndex 昇順)。describe golden(`test/fixtures/describe.golden.txt`)は
  **フラグ off・ファイル不在で不変=修正なしで緑**であること(これがバイト等価の証明)。
  `--json` テストも fixtures にファイル無し・`describe.pauses` off で不変。
  新規に「system transcript を置いた一時 fixture」で追記行が出ることを確認する
  ケースを1件足す。
- **壊すな**: golden・既存 `--json` 射影(規則A〜E)。frames 鮮度・shorts 要約。

### タスク6: ドキュメント同期

- **触る**: `docs/usage.md`(`whisper.systemAudio` / `plan.perception.systemSpeech` /
  `describe.pauses` の節。トラックベース話者分離の正直な宣言)、`CLAUDE.md`
  (「動画の中身を知る方法」に `transcript.system.json` と system 発話・keep 内の間を
  1〜2行、中間生成物一覧に `transcript.system.json` / `whisper-system-out.json` /
  `audio/system.wav` 追記)。
- **テスト**: なし。`npx tsc --noEmit` と `npm test` が緑。
- **壊すな**: `docs/reviews/` は触らない。

---

## 10. 実データ検証(`~/Movies/cutflow/2026-07-02-whisper-bench`)

**重要な実測事実**: この収録の raw(`2026-07-02 17-26-36.mkv`)は **音声ストリームが
1本だけ**(aac 2ch)で、`manifest.json` の `systemStream` は **null**。よって
**この収録では system 経路をそのままでは検証できない**。手順を2系統に分ける。

### 10.1 バイト等価(mic のみ・全収録で保証すべき本丸)

```sh
# ここで systemStream=null。フラグ off の再 ingest/transcribe が diff ゼロを確認
cd /tmp && node /Users/19mo/dev/tools/cutflow/src/cli.ts validate ~/Movies/cutflow/2026-07-02-whisper-bench
# manifest.json / transcript.json を退避 → 再生成 → cmp でバイト一致を確認
#   (whisper.systemAudio 未設定・plan.perception.systemSpeech 未設定・describe 未設定)
# describe 散文 golden・--json が現行と一致することも確認
node /Users/19mo/dev/tools/cutflow/src/cli.ts describe ~/Movies/cutflow/2026-07-02-whisper-bench
```

- 期待: `systemStream: null` なので `whisper.systemAudio: true` にしても
  `system.wav`・`transcript.system.json` は**作られない**(自動無視)=バイト等価。

### 10.2 system 経路(2トラック合成フィクスチャで機能検証)

whisper-bench に system トラックが無いので、**scratchpad に2音声トラックの
検証用ファイルを合成**して ingest からかける:

```sh
SCR=/private/tmp/claude-501/.../scratchpad   # セッションの scratchpad
mkdir -p "$SCR/sys-test"
# 既存 raw の映像+音声(=mic)に、TTS/デモ音の代用として別音声を track2 として多重化。
# 代用音源が無ければ say コマンドで生成(macOS):
say -o "$SCR/sys.aiff" "これはシステム音声のテストです。デモアプリの読み上げ。"
ffmpeg -y -i "~/Movies/cutflow/2026-07-02-whisper-bench/2026-07-02 17-26-36.mkv" \
       -i "$SCR/sys.aiff" \
       -map 0:v -map 0:a:0 -map 1:a:0 -c:v copy -c:a aac \
       "$SCR/sys-test/raw.mkv"
# config で whisper.systemAudio: true にした状態で ingest → transcribe → describe
```

- 期待: `manifest.audio.systemWav = "audio/system.wav"`、`transcript.system.json` が
  生成され `speaker:"system"`、`describe`(`describe.pauses`/systemSpeech に応じて)で
  `[システム音声]` 行が出る。`plan.perception.systemSpeech: true` で
  `plan.raw.txt` にシステム音声ブロックが載る(LLM 実行は `cd /tmp` の中立 cwd から)。

### 10.3 keep 内の間

- whisper-bench は `cuts.auto.json` に silences があり keep も複数あるので、
  `describe.pauses: true` で per-keep の間が出ること、plan の `audio` 行に
  `最長x.x` が付くことを実データで確認できる(合成不要)。

---

## 11. 実装順序(依存関係)

1. **タスク1(config)** — 全タスクの土台。単独でマージ可(挙動不変)。
2. **タスク2(ingest 抽出)** — manifest に `systemWav` を出す。タスク3の前提。
3. **タスク3(transcribe 第2回)** — `transcript.system.json` を作る。タスク4・5の前提。
4. **タスク4(plan 露出)** と **タスク5(describe 露出)** — タスク3の成果物を読む。
   互いに独立(並行可)。keep 内の間はタスク5に含むが `cuts.auto.json` だけに依存する
   ので、タスク2・3を待たずに着手してもよい(順序上はタスク1の後ならいつでも)。
5. **タスク6(docs)** — 最後に同期。

各タスクは単独で `npx tsc --noEmit` + `npm test` が緑、かつ**未使用時バイト等価**を
保ったままマージできる粒度。

---

## 12. 不変条件(実装子への契約)

1. **既定オフ=バイト等価**: `whisper.systemAudio`/`plan.perception.systemSpeech`/
   `describe.pauses` を書かない(または false)とき、`manifest.json`・
   `transcript.json`・`whisper-out.*`・`plan.raw.txt`・`cutplan/chapters/meta`・
   describe 散文 golden・`describe --json` は**本 Feature 前と1バイトも変わらない**。
   既存テスト(`describe.golden.txt` / `test/perception.test.ts` / config test)が
   修正なしで緑であることが証明。
2. **役割分離不可侵**: `transcript.system.json` は**描画されない・編集されない・
   `@id`/承認 hash/apply の対象外**。`transcript.json`(EDITABLE・描画契約)には
   一切混ぜない。
3. **新規計測ゼロ**: keep 内の間は `cuts.auto.json` の silences からのみ。detect に
   RMS 等のパスを足さない。
4. **優雅な劣化**: `systemStream` 不在・`transcript.system.json` 不在・macOS 非対応で
   例外を投げず、その部分を省いて続行する。
5. **音響話者分離をしない**: 話者分離はトラック起源の帰属に限る(§5)。重 ML 依存を
   増やさない。
6. **`{{segments}}` 不可侵 / plan は1ショットのまま**(eyes-ears doc の不変条件を継承)。
7. **`docs/reviews/` は不可侵**。

---

## 13. 将来の種(本 Feature ではやらない・再検討トリガー)

- **音響話者分離**(1トラック多人数): 複数ホストを1マイクで録る収録が**定常化**し、
  かつローカル・決定論で動く軽量 diarization(将来の on-device API 等)が現れたら
  再検討。`SystemTranscript.speaker` の union を拡張する seam は用意済み。
- **非言語音イベント**(笑い・拍手・SFX): dep-free で安定に取れる検出器
  (whisper の非発話トークンが日本語でも安定して出る / astats ピークが誤検出なく
  使える)が実データで確認できたら。まずは silence マップで代替が効くうちは足さない。
- **区間音量(RMS/ラウドネス)**: eyes-ears doc §10 と同じ。detect に ebur128/astats の
  1パスを足し `AutoCuts` に per-segment 音量を持たせて `computeAudioFeatures` に合流。
- **system transcript の描画**(アプリ/デモの読み上げをテロップ化): 需要が出たら
  `transcript.json` へ**取り込むコマンド**(system→editable への一方向コピー)を別途。
  自動で描画契約に混ぜることはしない。
- **`plan-shorts` への systemSpeech 接続**: 見せ場選定にデモ音が効くと分かれば。
