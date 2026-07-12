# SD-T0 設計書 — `style-profile`(任意パス→スタイルプロファイル抽出)

> 母艦: `docs/programs/aesthetic-judgment-and-style-learning.md`(§4.0 供給源・
> §5 profile が測定の穴を3つ塞ぐ・§7 統一 schema・§8 不変条件・§10.0/§10.1 確定判断)。
> 本書は **SD-T0 の実装設計書**(Opus 設計 → Sonnet 実装 → コーディネータ実測のリレー)。
> 4部形式(背景 / 変更 / 検証 / リスク)。**コードは書かない。この設計に従って実装するのは Sonnet。**

---

## 0. スコープ(この設計書が作るもの / 作らないもの)

- **作る**: 新コマンド `style-profile`。任意の動画/収録パスを吸収し、**スタイルプロファイル**
  (`style.probe/<name>.json`)を channel 直下に**決定論で**抽出する。**profile 抽出のみ**が SD-T0。
- **作らない**(別タスク・本書スコープ外): 距離 assert(SD-T1)・判断注入 `plan.styleProfile`(SD-T4)・
  agreement harness(SD-T2)・VLM 審美 judge(SD-T5)。本書ではこれらへの**拡張点だけ**を型と
  コメントに残す(実装の必須スコープからは外す=Sonnet が最短で通せる形)。
- **v1 の割り切り**(母艦 §10.0 確定): 数値経路は**決定論のみ**。LLM/VLM は styleNotes・構成ラベルの
  optional 拡張点として型に穴を空けておくだけで、v1 実装では呼ばない。profile schema は
  **cut / caption / audio(+演出"密度"は SD-T1 側)/ structure** まで。**素材配置・演出座標の
  policy は profile v2**(母艦 §7・§10.0)=本書では持たせない。

---

## 1. 背景

### 1.1 母艦のどこか(§5 の測定の的)

母艦の中心命題(§1.2)は「審美眼を測るには**良さの参照点**が要り、その参照点を供給するのが
スタイル学習」。SD-T0 が抽出する `style.probe/<name>.json` が、その参照点の**唯一の正本**
(§7)。1個の profile が下流3経路の的になる: §5.1 距離 assert(SD-T1)の目標値・§5.2 agreement の
目標・§5.3 判断注入(SD-T4)の事前分布/few-shot 基質。**測定基盤の第1手が抽象エラー分類ログでは
なく profile 抽出**なのはこのため(母艦 §5 末尾)。

### 1.2 cold-start の制約(確定 2026-07-12・母艦 §4.0/§11)

このチャンネル `/Users/19mo/Movies/cutflow/` は **承認済み 1 本**(`2026-07-02`)・**自信作なし**・
**channel rules.md/brief.md なし**。ゆえに:

- **主入口は「承認済み自コーパスの自動採掘」ではなく `style-profile --from <path>` の任意パス吸収**
  (母艦 §4.0)。自コーパス採掘は「収録プロジェクト入力」モードの1ケースにすぎない。
- **N=1** なので sampleSize=1 の弱さを **confidence で正直に可視化**する(§8 不変条件)。
- **agreement(SD-T2)は保留**(leave-one-out は N=1 不成立)。SD-T0 は agreement の入力ではなく、
  SD-T1 の決定論 distance-to-profile の**基準点**を作ることに集中する。

### 1.3 入力型で「取れるもの」が変わる(母艦 §3 の (A)/(B) 境界・§4.0 の表)

| 入力 | provenance | 取れる信号 | 補正デルタ (B) |
|---|---|---|---|
| cutflow 収録(manifest.json + cutplan.json あり) | `own-project` | 観測統計 (A) + AI提案→人間最終の**補正デルタ** (B) | **持てる**(plan.raw.txt があれば) |
| 素の動画/plain フォルダ | `bare-video` | **観測統計のみ** (A)。何を切ったかは完成品に残らない | **持てない**(§8 不変条件1) |

> **能力境界(母艦 §3)**: スタイル抽出は *rate/placement 統計*(どのくらい/どの頻度で/どこに)を
> 教えるが、*instance semantics*(この一個が正しいか)は教えない。profile はこの線の内側に留まる。

### 1.4 実装の重み配分(重要な設計判断・母艦 §10.0)

母艦は「主入口=任意パス吸収」だが、**cold-start のテストデータは own-project(2026-07-02)だけ**。
そこで本書は:

- **own-project を確実に動かすのを最優先**(数値統計 + 補正デルタのフル抽出)。
- **bare-video は「最小 + 拡張点」**: ffprobe レベル(尺・解像度・fps・音声有無)+ **既に生成されて
  いれば** `av.probe/` を読む、まで。**ingest/transcribe/detect/whisper/frames を style-profile が
  自前で起動することはしない**(重すぎる・非決定・cold-start テストに不要)。フル bare-video 抽出
  (ingest→transcribe→detect→frames --ocr→av の連結)は v2/拡張点として設計に残すだけ。
- **これで bare-video を完全には切り捨てない**(素の動画でも尺・解像度・音の統計は出る)が、重い
  経路には踏み込まない。母艦「主入口=任意パス吸収」と「最短で通す」を両立させる妥協点。

---

## 2. 変更(揺れない粒度)

### 2.0 新規/変更ファイルの完全な一覧

**新規**:

| パス | 役割 |
|---|---|
| `src/lib/styleProfile.ts` | **純関数(テスト対象)+ 型 + 定数**。観測集約・ラベル写像・confidence・補正デルタ・merge。IO しない |
| `src/stages/styleProfile.ts` | **orchestrator**(薄い殻)。read → 入力型判定 → `describeJson`/av.probe/plan.raw 読込 → 純関数呼び出し → write + `formatStyleProfileReport` |
| `test/styleProfile.test.ts` | `src/lib/styleProfile.ts` の純関数の単体テスト(realistic 値で固定) |

**変更**:

| パス | 差分の要点 |
|---|---|
| `src/lib/files.ts` | `GENERATED_DIRS` に `"style.probe"` を追加(channel 直下の生成ディレクトリ) |
| `src/cli.ts` | `style-profile` コマンド登録(`--from` 複数 collect・`--name`)+ import |
| `docs/usage.md` | コマンド説明追記 + 生成物 `style.probe/` の一行 |
| `AGENTS_CONTRACT.md` | **コマンド表に `style-profile` 行(test/agentsMd.test.ts で必須)** + generated ディレクトリ一覧に `style.probe/` |
| `CLAUDE.md` | コマンド一覧に `style-profile` / 中間生成物ディレクトリに `style.probe/` を追記(CLAUDE.md 自身のルール) |
| `test/files.test.ts` | `style.probe/` の `fileRole` = generated を1ケース追加(av.probe/review.probe と同型・網羅のため) |

**変更しない(明示)**:

- `schemas/`(**新スキーマを置かない**)。理由 §2.7。
- `src/types.ts`(`StyleProfile` 型は `src/lib/styleProfile.ts` に置く。理由 §2.3)。
- `src/stages/validate.ts`(profile.json は生成物・channel 直下・`validate <dir>` の対象外。無変更)。
- `src/lib/config.ts`(**config セクション不要**。理由 §2.8)。

### 2.1 `StyleProfile` 型定義の完全な TS

> **配置の決定(§2.3 参照)**: 生成物レポートの型は `av.ts`(MotionReport/SoundReport)・
> `bgmFit.ts`(BgmFitFinding)・`describe.ts`(DescribeProjection)と同じく **その module に置く**の
> が本リポジトリの一貫慣行。よって `StyleProfile` 系は `src/types.ts` ではなく
> **`src/lib/styleProfile.ts` に置く**(types.ts は「8編集ファイル」のスキーマ源で schema.test.ts が
> テキスト解析でピン留めしているため、編集ファイル以外の型を足す家ではない)。以下をそのまま
> `src/lib/styleProfile.ts` の先頭に置く。

```ts
/** style.probe/<name>.json のスキーマ版。破壊的変更で +1 */
export const STYLE_PROFILE_SCHEMA_VERSION = 1;

/** 集約の出所。§7・§8 不変条件1。bare-video は補正デルタ (B) を持てない=provenance で表す */
export type Provenance = "own-project" | "bare-video" | "reference" | "merged";

/** 全時刻の軸(§8 不変条件4)。v1 は常に "reference-output"(見本/自コーパスの出力秒基準) */
export type StyleAxis = "reference-output";

/** 各 section が持つ出所メタ。§7「各集約値に provenance + confidence + sampleSize」を
 *  スカラーごとではなく section ごとに1つ持たせる(cutDensity/captions/audio/structure/
 *  correctionDelta の粒度。§7 骨子が cutDensity.confidence を持つのと同じ) */
export interface SectionMeta {
  /** この section の値がどの入力型由来か(混在すれば "merged") */
  provenance: Provenance;
  /** 0..1。sampleSize・欠測・ばらつきから算出(§2.5 confidence)。1 入力=低い */
  confidence: number;
  /** この section の母数(cut=shots 数 / caption=captions 数 / audio=projects 数 等) */
  sampleSize: number;
}

/** カット密度(§7 cutDensity)。母艦 §2.1 ペース次元の測定基盤 */
export interface CutDensity {
  meta: SectionMeta;
  /** keep durationSec の平均(own-project)。bare は av があれば freeze 逆算・無ければ null */
  avgShotSec: number | null;
  medianShotSec: number | null;
  /** ショット長分布(SD-T1 の KS 距離の素地)。短い側/長い側の10/90 パーセンタイル */
  shotSecP10: number | null;
  shotSecP90: number | null;
  /** 分/回。av.probe/motion.json があれば sceneScore 由来を優先、無ければ keeps 数/出力分 */
  sceneChangesPerMin: number | null;
  /** avgShotSec → 閾値ラベル(§2.4 決定論写像)。値が無ければ null */
  cutAggressiveness: "low" | "medium" | "medium-high" | "high" | null;
}

/** テロップ(§7 captions)。母艦 §2「caption 密度/位置」 */
export interface CaptionsProfile {
  meta: SectionMeta;
  /** テロップが1つ以上出ている時間の和 ÷ outDurationSec(区間 union。0..1) */
  coverageRatio: number | null;
  /** 1テロップの平均表示秒(出力秒) */
  avgDisplaySec: number | null;
  /** coverageRatio → 閾値ラベル */
  density: "low" | "medium" | "high" | null;
  /** pos.y ヒストグラムの多数決ラベル(§2.4) */
  positionHint: "top" | "center" | "bottom" | "mixed" | null;
  /** 位置の内訳(件数)。SD-T1 の位置距離の素地。値が無ければ null */
  positionHistogram: { top: number; center: number; bottom: number } | null;
  /** v1 は**決定論由来のみ**(bold/outlined/boxed/karaoke 等・§2.6)。VLM styleNotes は拡張点で追記 */
  styleNotes: string[];
}

/** 音(§7 audio)。母艦 §2.3 BGM ラウドネス。av.probe/sound.json があるときだけ実値・無ければ null */
export interface AudioProfile {
  meta: SectionMeta;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  /** 出力尺内の無音区間数 */
  silenceCount: number | null;
  /** Σ無音秒 ÷ outDurationSec(0..1) */
  silenceRatio: number | null;
  /** bgm.json / 収録直下 bgm.* / av.sound.bgm.spans のいずれかがあれば true */
  bgmLikely: boolean | null;
}

/** 構成(§7 structure)。母艦 §2「構成テンプレ」。own-project の chapters を出力秒へ射影 */
export interface StructureProfile {
  meta: SectionMeta;
  /** 章から作る構成セグメント(出力秒)。merge 時(N>1)は timeline を混ぜられないため null */
  segments: { name: string; startOutSec: number; endOutSec: number }[] | null;
  chapterCount: number | null;
  /** 冒頭フックの長さ(= 最初の章の尺 = 2番目の章の startOutSec)。章<2 なら null */
  hookSec: number | null;
  /** 末尾章タイトルが CTA 語(まとめ/チャンネル登録/高評価/フォロー等)を含めば true */
  ctaLikely: boolean | null;
}

/** 補正デルタ(§7 の (b) 信号・母艦 §4.0/§10.0)。**own-project + plan.raw.txt のときだけ**。
 *  bare-video は null(§8 不変条件1)。AI 提案(plan.raw.txt)→ 人間最終(cutplan/chapters/meta)の
 *  **要約統計**(過剰設計を避け、決定論で robust に取れる粒度=件数と verbatim 残存に留める。§2.6) */
export interface CorrectionDelta {
  meta: SectionMeta;
  /** 提案 cut 件数 vs 最終 cut 区間数(coarse な件数比較) */
  cuts: { proposed: number; final: number } | null;
  /** 提案章 vs 最終章、+ 提案タイトルが最終章に verbatim で残った数 */
  chapters: { proposed: number; final: number; titlesKeptVerbatim: number } | null;
  /** 提案タイトル数 vs 最終、+ verbatim 残存数 */
  titles: { proposed: number; final: number; keptVerbatim: number } | null;
  /** 概要欄が AI 案からどう変わったか */
  description: "identical" | "edited" | "replaced" | "none" | null;
}

/** 各 --from の記録(監査・§8 不変条件1 の可視化用) */
export interface SourceRef {
  path: string;
  kind: "own-project" | "bare-video";
  durationSec: number | null;
  keepCount: number | null;      // own-project のみ
  captionCount: number | null;   // own-project のみ
  hasAv: boolean;                // av.probe/sound.json を読めたか
  hasPlanRaw: boolean;           // plan.raw.txt があった(補正デルタ可否)
}

/** style.probe/<name>.json 本体(§7 v1 scope) */
export interface StyleProfile {
  schemaVersion: number;         // = STYLE_PROFILE_SCHEMA_VERSION
  name: string;                  // --name(省略時 "default")
  provenance: Provenance;        // 全体の出所(混在=merged)
  axis: StyleAxis;               // 常に "reference-output"(§8 不変条件4)
  generatedAt: string;           // ISO8601
  sampleSize: {
    projects: number;            // own-project 入力の数
    videos: number;              // bare-video 入力の数
    shots: number;               // 全 keep 数の総和(cutDensity の母数)
    captions: number;            // 全 caption 数の総和
  };
  sources: SourceRef[];
  cutDensity: CutDensity;
  captions: CaptionsProfile;
  audio: AudioProfile;
  structure: StructureProfile;
  /** own-project 由来があるときだけ非 null。bare-video のみなら null(§8 不変条件1) */
  correctionDelta: CorrectionDelta | null;
}
```

### 2.2 純関数(`src/lib/styleProfile.ts`)— シグネチャと責務

> 全て IO なし・決定論。`SoundReport`/`MotionReport`(av.ts)・`DescribeProjection`(describe.ts)は
> **`import type` で型だけ**取り込む(Node type-stripping で実行時に消える=stage への runtime 依存
> なし・循環なし)。IO は全て §2.4 の orchestrator が担う。

```ts
import type { DescribeProjection } from "../stages/describe.ts";
import type { SoundReport, MotionReport } from "../stages/av.ts";
```

**(a) 各入力を正規化した中間表現に落とす**(merge が加重できるよう十分統計を持つ):

```ts
/** merge が畳めるだけの十分統計を持つ、入力1本の観測 */
export interface ProjectObservation {
  kind: "own-project" | "bare-video";
  path: string;
  durationSec: number | null;
  // --- cut density ---
  shotDurations: number[];        // keep durationSec 群(bare は [])
  outDurationSec: number | null;
  sceneChangesPerMin: number | null;
  // --- captions ---
  captionOutIntervals: { start: number; end: number }[]; // 全 caption の出力秒区間(coverage union 用)
  captionDisplaySecs: number[];   // 各 caption の出力表示秒(avgDisplaySec 用)
  positionHistogram: { top: number; center: number; bottom: number }; // ★実装訂正(レビュー反映後)
  captionCount: number;           // 全 caption 数(pos 有無問わず)
  styleFlags: string[];           // 決定論 styleNotes(重複可・merge で頻度集約)
  // --- audio ---
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  silenceCount: number | null;
  silenceSec: number | null;
  bgmLikely: boolean | null;
  hasAv: boolean;
  // --- structure ---
  chapters: { name: string; startOutSec: number; endOutSec: number }[] | null;
  chapterCount: number | null;    // ★実装訂正(レビュー反映後)。真の章数(out===null 含む)。own-project のみ
  hookSec: number | null;
  ctaLikely: boolean | null;
  // --- correction delta(own-project + plan.raw のみ) ---
  delta: CorrectionDelta["cuts"] extends never ? never : CorrectionDeltaRaw | null;
  hasPlanRaw: boolean;
}

/** delta の生値(SectionMeta を付ける前)。CorrectionDelta の cuts/chapters/titles/description と同型 */
export interface CorrectionDeltaRaw {
  cuts: { proposed: number; final: number };
  chapters: { proposed: number; final: number; titlesKeptVerbatim: number };
  titles: { proposed: number; final: number; keptVerbatim: number };
  description: "identical" | "edited" | "replaced" | "none";
}

/** own-project 1本 → 観測。av は optional(null 可)。plan.raw は parsePlanRaw 済みを渡す */
export function observeOwnProject(args: {
  path: string;
  proj: DescribeProjection;
  sound: SoundReport | null;
  motion: MotionReport | null;
  planRaw: PlanRaw | null;
  bgmPresent: boolean;            // bgm.json or 収録直下 bgm.* の有無(orchestrator が判定)
}): ProjectObservation;

/** bare-video 1本 → 観測。captions/structure/delta は持てない(全 null/空)。§8 不変条件1 */
export function observeBareVideo(args: {
  path: string;
  probe: { durationSec: number | null; width: number | null; height: number | null; fps: number | null; hasAudio: boolean };
  sound: SoundReport | null;
  motion: MotionReport | null;
}): ProjectObservation;
```

> **実装訂正(コードレビュー反映・2026-07-12)**: 上記コード片は初版設計(`captionYs`/`canvasHeight` を
> 集めて merge 時に1つの canvasHeight でまとめてバケット化)のままだが、**実装はこれと異なる**。
> レンダラー(`remotion/Main.tsx:326-329` + `renderProps.ts`)は「明示 pos も captionTracks 既定も
> 無いテロップ」を**下部中央にフォールバック**して描画する(本編は常に下部中央)。初版の
> `captionYOf` はそれを `null`(位置不明)にして positionHistogram から除外していたため、pos 無し
> テロップが多数(実データ 2026-07-02: 30件中25件)を占める実際の収録では positionHint が実態
> (下部多数)と**逆**(top)になるバグがあった。加えて「全観測の y を1つの canvasHeight でバケット
> 化」は異解像度 merge で分母がズレる。実装は次の形へ訂正:
> - `ProjectObservation` は `captionYs`/`canvasHeight` を持たず、**観測ごとに** `positionHistogram:
>   { top, center, bottom }` を持つ(`observeOwnProject` が自身の `canvasHeight`
>   (`proj.source.video.screenRegion.h`)で分類済み。`observeBareVideo` は `{0,0,0}`)。
> - 分類ヘルパは `captionBucketOf(cap, tracks, canvasHeight): "top"|"center"|"bottom"`
>   (`captionYOf` を置換)。`y = cap.pos?.y ?? tracks.find(t=>t.track===cap.track)?.y ?? null`。
>   **`y === null` のときは `"bottom"` を返す**(レンダラー既定フォールバックと一致させる。
>   `null` を返して histogram から除外しない)。
> - `mergeObservations` は各観測の `positionHistogram` を**フィールドごとに合算**するだけ
>   (`canvasHeightForBucketing`/`bucketYs(captionYsAll, …)` 経路は削除)。
> - 同時に `chapterCount: number | null` を `ProjectObservation` に追加(§2.5/§2.7 の実装訂正を参照。
>   `structureFrom` が返す真の章数を保存し、merge の平均が `segments.length` による過少カウントを
>   起こさないようにする)。

**(b) N 観測 → 1 profile**(母艦 §4.0「複数を1プロファイルへ集約・sampleSize↑」):

```ts
/** N 個の観測を 1 StyleProfile へ。分布統計は配列プーリング(平均の平均にしない)、
 *  比率は尺で加重、provenance は混在判定、correctionDelta は own-project 分だけ合算 */
export function mergeObservations(name: string, obs: ProjectObservation[]): StyleProfile;
```

**(c) 決定論の閾値→ラベル写像**(母艦 §10.0「数値経路に LLM を挟まない」):

```ts
export function cutAggressivenessLabel(avgShotSec: number | null): CutDensity["cutAggressiveness"];
export function captionDensityLabel(coverageRatio: number | null): CaptionsProfile["density"];
export function positionHintLabel(hist: { top: number; center: number; bottom: number } | null): CaptionsProfile["positionHint"];
```

**(d) confidence**(§2.5):

```ts
/** 0..1。present=false なら 0。sampleSize と projectCount と(任意)変動係数から算出 */
export function sectionConfidence(args: {
  present: boolean;
  sampleSize: number;      // この section の母数(shots/captions/…)
  projectCount: number;    // 独立プロジェクト数(cold-start ペナルティ)
  kSample: number;         // section 別の飽和定数(§2.5 の定数表)
  cv?: number | null;      // 分布統計の変動係数(あれば軽いペナルティ)
}): number;
```

**(e) 補正デルタ**(§2.6):

```ts
/** plan.raw.txt(AI 提案)と最終 proj(人間仕上げ)から要約統計を作る */
export function computeCorrectionDelta(planRaw: PlanRaw, proj: DescribeProjection): CorrectionDeltaRaw;

/** plan.raw.txt のテキストを寛容に parse。JSON でなければ null(补正デルタ省略=confidence へ反映) */
export function parsePlanRaw(text: string): PlanRaw | null;

export interface PlanRaw {
  cuts: { id: number; reason?: string }[];
  chapters: { startId: number; title: string }[];
  titles: string[];
  description: string;
}
```

**(f) 小さな決定論ヘルパ**(テストで固定):

```ts
export function mean(xs: number[]): number | null;                 // 空配列→null
export function median(xs: number[]): number | null;
export function percentile(xs: number[], p: number): number | null; // p は 0..1・線形補間
export function unionCoverageSec(intervals: { start: number; end: number }[]): number; // 区間 union の総和
export function styleFlagsFrom(proj: DescribeProjection): string[]; // captionTracks/caption.style から決定論フラグ
export function structureFrom(proj: DescribeProjection): { segments; chapterCount; hookSec; ctaLikely };
```

### 2.3 型を types.ts でなく styleProfile.ts に置く決定(揺れ防止)

母艦 §7 の「5点セット(types/validate/…)」は**編集ファイルのスキーマ変更**の手順。`style.probe/<name>.json`
は**生成物**であり、生成物レポートの型は本リポジトリでは一貫して**その module 内**に置かれている
(`av.ts` の MotionReport/SoundReport、`bgmFit.ts` の BgmFitFinding、`describe.ts` の DescribeProjection、
`effectCheck.ts` の検品型)。`src/types.ts` は「8編集ファイル」のスキーマ源で、`test/schema.test.ts` が
テキスト解析で enum/union をピン留めしている繊細な家。**よって `StyleProfile` 系は
`src/lib/styleProfile.ts` に置き、types.ts は触らない**(precedent 準拠・schema.test を揺らさない)。

### 2.4 orchestrator(`src/stages/styleProfile.ts`)擬似コード

`bgmFit.ts` / `av.ts` と同じ「read → 純関数 → write + formatXxxReport」の薄い殻。

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import type { Config } from "../lib/config.ts";
import { describeJson } from "./describe.ts";
import type { SoundReport, MotionReport } from "./av.ts";
import { AV_DIR, SOUND_FILE } from "./av.ts"; // ("motion.json" は av.ts で未 export → リテラルで持つ)
import {
  observeOwnProject, observeBareVideo, mergeObservations, parsePlanRaw,
  STYLE_PROFILE_SCHEMA_VERSION, type StyleProfile, type ProjectObservation,
} from "../lib/styleProfile.ts";
import { probe as ffprobe } from "../lib/ffmpeg.ts";

export const STYLE_PROBE_DIR = "style.probe";

export interface StyleProfileResult { profile: StyleProfile; outPath: string; warnings: string[]; }

export async function styleProfile(
  opts: { from: string[]; name?: string },
  cfg: Config,
): Promise<StyleProfileResult> {
  if (!opts.from || opts.from.length === 0) throw new Error("--from を1つ以上指定してください");
  const name = sanitizeName(opts.name ?? "default"); // 英数-_ のみ・空→"default"
  const warnings: string[] = [];
  const observations: ProjectObservation[] = [];

  for (const raw of opts.from) {
    const abs = resolve(raw);
    if (!existsSync(abs)) throw new Error(`--from のパスがありません: ${abs}`);
    const kind = classifyInput(abs);            // §下記

    if (kind === "own-project") {
      const proj = describeJson(abs, cfg);        // manifest/cutplan/transcript 必須(無ければ throw)
      const sound = readJsonOpt<SoundReport>(join(abs, AV_DIR, SOUND_FILE));
      const motion = readJsonOpt<MotionReport>(join(abs, AV_DIR, "motion.json"));
      if (!sound) warnings.push(`${abs}: av.probe/sound.json 未生成 → audio 統計は欠落(先に \`av ${abs}\`)`);
      const planText = readTextOpt(join(abs, "plan.raw.txt"));
      const planRaw = planText ? parsePlanRaw(planText) : null;
      // 実装訂正(コードレビュー反映・av 欠落との対称性): planText はあるが parse 失敗
      // (例: `plan --cuts-only` が書く cuts のみの plan.raw.txt・形式不正)のときも、
      // av 欠落と同様に警告する(無言で correctionDelta が落ちるのを防ぐ)
      if (planText !== null && planRaw === null) {
        warnings.push(`${abs}: plan.raw.txt を解析できず補正デルタは欠落(cuts-only の plan.raw か形式不正)`);
      }
      const bgmPresent = existsSync(join(abs, "bgm.json"))
        || ["bgm.mp3","bgm.m4a","bgm.wav"].some((f) => existsSync(join(abs, f)));
      observations.push(observeOwnProject({
        path: abs, proj, sound, motion,
        planRaw,
        bgmPresent,
      }));
    } else {
      // bare-video: 最小抽出(ffprobe レベル)+ 既存 av.probe があれば読む
      const videoFile = resolveVideoFile(abs);    // file ならそれ・folder なら中の代表動画
      const p = videoFile ? summarizeFfprobe(await ffprobe(videoFile)) : emptyProbe();
      if (!videoFile) warnings.push(`${abs}: 動画ファイルを特定できず ffprobe 統計は欠落`);
      const probeDir = videoFile ? dirname(videoFile) : abs;
      const sound = readJsonOpt<SoundReport>(join(probeDir, AV_DIR, SOUND_FILE));
      const motion = readJsonOpt<MotionReport>(join(probeDir, AV_DIR, "motion.json"));
      observations.push(observeBareVideo({ path: abs, probe: p, sound, motion }));
    }
  }

  const profile = mergeObservations(name, observations);

  // channel = 最初の --from の親ディレクトリ(learn.ts / readRules の dirname(dir) 規約)
  const channel = dirname(resolve(opts.from[0]));
  const outDir = join(channel, STYLE_PROBE_DIR);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(profile, null, 2));
  return { profile, outPath, warnings };
}

/** manifest.json + cutplan.json があれば own-project、無ければ bare-video */
function classifyInput(abs: string): "own-project" | "bare-video" {
  // abs がディレクトリで manifest.json & cutplan.json を持つ → own-project
  // それ以外(動画ファイル / plain フォルダ)→ bare-video
}
```

- **`classifyInput`**: `statSync(abs).isDirectory()` かつ `existsSync(join(abs,"manifest.json"))` かつ
  `existsSync(join(abs,"cutplan.json"))` → `own-project`。それ以外は `bare-video`(動画ファイル
  そのもの・plain フォルダの両方)。
- **`resolveVideoFile`**: `abs` がファイルならそれ。ディレクトリなら中の
  `*.mkv|*.mp4|*.mov`(先頭1件・名前昇順で決定論)。無ければ null。
- **av を自前で起動しない**: §1.4 の判断。`av.probe/{sound,motion}.json` を**読むだけ**。
  own-project で欠落していれば warning を出し audio 統計を欠落(confidence 0)にする=cold-start に強い。
  母艦の「av 依存は optional(あれば足す/無ければ confidence 低)」を確定実装。
- **`motion.json` のファイル名**は `av.ts` で `const MOTION_FILE` が未 export のため、orchestrator 側で
  リテラル `"motion.json"` を持つ(`SOUND_FILE`/`AV_DIR` は export 済みなので import)。

**stdout 整形**(`formatStyleProfileReport(result: StyleProfileResult): string[]`):

```
style-profile: name=default provenance=own-project projects=1 videos=0 shots=19 captions=30
  cut: avgShot 5.17s (median 4.6, p10 1.32, p90 9.96) / 11.6 changes/min / aggressiveness=medium [conf 0.32]
  caption: coverage 0.71 / avgDisplay 2.1s / density=high / position=bottom [conf 0.40]
  audio: I -14.2 LUFS / TP -1.3 dBFS / silence 4 (ratio 0.08) / bgm=yes [conf 0.50]
  structure: 4 chapters / hook 8.5s / cta=yes [conf 0.33]
  delta: cuts 9→10 / chapters 4→4 (titles kept 4) / titles 3→3 (kept 2) / description=edited [conf 0.50]
プロファイルを <channel>/style.probe/default.json に書きました。
警告: <dir>: av.probe/sound.json 未生成 → …(あれば)
```

### 2.5 統計の算出式(決定論・すべて純関数で固定)

記号: `shots` = keep durationSec 配列、`outDur` = `proj.summary.outDurationSec`。

**cutDensity**:
- `avgShotSec = mean(shots)` / `medianShotSec = median(shots)` / `shotSecP10 = percentile(shots, .10)` /
  `shotSecP90 = percentile(shots, .90)`(空配列は null)。丸めは `round2`(既存 describe/av と同じ)。
- `sceneChangesPerMin`:
  - **motion があれば優先**: `count(motion.motion[].sceneScore ≥ SCENE_CHANGE_THRESHOLD) / (outDur/60)`。
    `SCENE_CHANGE_THRESHOLD = 0.4`(module 定数)。
  - **無ければ keeps 由来**: `shots.length / (outDur/60)`(keep 境界 ≈ カット ≈ scene change)。
  - own-project で outDur 既知。bare-video で motion も outDur も無ければ null。
- `cutAggressiveness = cutAggressivenessLabel(avgShotSec)`:
  `avgShotSec == null → null` / `≤ 2 → "high"` / `≤ 4 → "medium-high"` / `≤ 7 → "medium"` /
  `> 7 → "low"`(短い平均 = より積極的にカット)。

**captions**(すべて出力秒。`proj.captions[].out` は `Interval[]`):
- 各 caption の表示秒 = `Σ (o.end - o.start) for o in caption.out`。`captionDisplaySecs` に積む。
  `avgDisplaySec = mean(captionDisplaySecs)`。
- `captionOutIntervals` = 全 caption の全 `out` 区間を平坦化。
  `coverageRatio = min(1, unionCoverageSec(captionOutIntervals) / outDur)`(union=重なりを二重計上しない)。
- `density = captionDensityLabel(coverageRatio)`: `null→null` / `< 0.3 → "low"` /
  `< 0.6 → "medium"` / `≥ 0.6 → "high"`。
- **位置**(実装訂正・上記コード片の注記を参照): 各 caption を `captionBucketOf(cap, tracks,
  canvasHeight)` で観測ごとにバケット化して数え上げる。`y = caption.pos?.y` があればそれ、無ければ
  **その track の既定 y**(`proj.overlays.captionTracks` から `track` 一致の `y`)。**どちらも無ければ
  `y = null` ではなく `"bottom"` を返す**(レンダラーの既定フォールバック=`remotion/Main.tsx:326-329`
  が「明示 pos も captionTracks 既定も無いテロップ」を下部中央に描画するのと一致させる。skip して
  histogram から除外すると、pos 無しテロップが多数の実データで positionHint が実態と逆になる)。
  `canvasHeight = proj.source.video.screenRegion.h`(観測自身のもの)。バケット: `y < H/3 → top` /
  `H/3 ≤ y < 2H/3 → center` / `y ≥ 2H/3 → bottom`。`observeOwnProject` はこの分類結果を
  `ProjectObservation.positionHistogram` に持ち、`mergeObservations` は全観測の `positionHistogram` を
  フィールドごとに合算して `CaptionsProfile.positionHistogram` を作る(合計0なら null)。
  `positionHint = positionHintLabel(hist)`: 総数0→null / 最多バケットが総数の 60% 以上→そのラベル /
  それ未満→ "mixed"。
- `styleNotes = styleFlagsFrom(proj)`(§2.6)。

**audio**(`sound = av.probe/sound.json`。null なら全 null):
- `integratedLufs = sound.mix?.integratedLufs ?? null` / `truePeakDbtp = sound.mix?.truePeakDbtp ?? null`。
- `silenceCount = sound.silences.length`(sound あれば)。
  `silenceRatio = Σ(sound.silences[].lenSec) / outDur`(0..1・outDur は sound.range 由来 or proj)。
- `bgmLikely = bgmPresent || (sound?.bgm.spans.length ?? 0) > 0`(own-project は bgmPresent を渡す)。

**structure**(`structureFrom(proj)`・own-project の chapters を出力秒へ):
- `proj.chapters[]` は `{start, out, title}`。`out != null` のものを昇順に並べ、隣接章で
  `segments[i] = { name: title_i, startOutSec: out_i, endOutSec: out_{i+1} ?? outDur }`。
- `chapterCount = proj.chapters.length`。
- `hookSec = segments[0].endOutSec`(= 2番目の章の開始 = 最初の章の尺)。章 < 2 なら null。
- `ctaLikely`: 末尾章タイトルが `CTA_KEYWORDS`(`["まとめ","チャンネル登録","高評価","フォロー",
  "登録","subscribe","like"]`・module 定数)のいずれかを含めば true(章0件なら null)。
- bare-video は structure 全 null(chapters を持たない)。

**confidence**(`sectionConfidence`):
```
present=false → 0
base    = sampleSize / (sampleSize + kSample)          // 母数の飽和
project = projectCount / (projectCount + 1)            // cold-start ペナルティ(1→0.5, 2→0.667, 3→0.75)
spread  = cv==null ? 1 : clamp(1 - min(cv,1)*0.3, 0.7, 1)
confidence = round2( base * project * spread )
```
`kSample`(section 別定数): `cutDensity=8`(shots) / `captions=10`(captions) / `audio=1`(projects) /
`structure=2`(chapters) / `correctionDelta=1`(projects)。`cv` は分布統計を持つ section(cutDensity は
`stddev(shots)/mean(shots)`、captions は表示秒の cv)だけ渡す。audio/structure/delta は `cv=null`。
- 例(2026-07-02・1 project): cutDensity `base=19/27=0.70, project=0.5, spread≈0.9 → 0.32`。
  audio `base=1/2=0.5, project=0.5, spread=1 → 0.25`(sound あり)…実測は §3 の目安に合わせて確認。

### 2.6 補正デルタの算出式(`computeCorrectionDelta`)

`plan.raw.txt` の `cuts[].id` は plan 生成時の候補 id で、**候補格子の再構築なしに source 秒へは
戻せない**。過剰設計を避け(母艦 §10.0「決定論で取れる粒度に留める」)、格子非依存で robust に
取れる**要約統計**に留める:

- `cuts = { proposed: planRaw.cuts.length, final: proj.cuts.length }`
  (`proj.cuts` = keep 間の gap = 実質の最終カット区間数。件数比較のみ)。
- `chapters = { proposed: planRaw.chapters.length, final: proj.chapters.length,
  titlesKeptVerbatim: planRaw.chapters[].title のうち trim 一致で proj.chapters[].title に現れる数 }`。
- `titles = { proposed: planRaw.titles.length, final: proj.meta.titles.length,
  keptVerbatim: planRaw.titles のうち trim 一致で proj.meta.titles に現れる数 }`。
- `description`:
  - `norm(x)` = trim + 連続空白1化。`f = norm(proj.meta.description)`, `p = norm(planRaw.description)`。
  - `f === "" → "none"` / `f === p → "identical"` /
    Jaccard(語集合(p), 語集合(f)) ≥ 0.5 → `"edited"` / それ未満 → `"replaced"`。
- **`styleFlagsFrom(proj)`**(補正デルタとは別・captions.styleNotes 用): 決定論フラグを distinct 収集 —
  `captionTracks[].style` と `captions[].style` を走査し、`fontWeight ≥ 700 → "bold"` /
  `outlineColor && outlineColor !== "none" → "outlined"` / `background → "boxed"` /
  `karaoke → "karaoke"` / `anim && anim.in!=="none" → "animated"`。VLM 由来の styleNotes は
  **v1 では追加しない**(拡張点: SD-T5 で vision route から追記)。

`parsePlanRaw`: `JSON.parse(text)` を試み、失敗したら**先頭の `{` 〜 末尾の `}` を抜き出して再 parse**
(LLM 生応答に前後注釈が混じるケースの寛容化)。それでも失敗 or 期待キー欠落なら `null`。null の
とき orchestrator は補正デルタを付けず、`CorrectionDelta` 全体を null にする(bare と同じ扱い)。

### 2.7 複数 `--from` の集約(`mergeObservations`)

母艦 §4.0「複数を1プロファイルへ集約・sampleSize↑・作風が違えば --name で分ける(合成しない)」。
merge は**同一 --name に入れた入力は同一作風**という前提で畳む(混ぜる判断はユーザーが --name で行う):

- **分布統計はプーリング**(平均の平均にしない): 全観測の `shotDurations` を連結してから
  `mean/median/percentile`。captions も `captionOutIntervals`/`captionDisplaySecs` を連結。
  **位置だけは例外**(実装訂正・上記注記を参照): `captionYs` を連結して1つの canvasHeight で
  バケット化するのではなく、**観測ごとに分類済みの `positionHistogram` をフィールドごとに合算**
  する(異解像度 merge で分母がズレないため)。
- **比率は尺で加重**: `coverageRatio` は各観測の `union秒` と `outDur` を別々に総和してから割る
  (`Σunion / ΣoutDur`)。`silenceRatio` も同様。
- **音は尺で加重平均**: `integratedLufs`/`truePeakDbtp` は `Σ(値×durationSec)/ΣdurationSec`
  (欠測は分母から除外)。
- **sceneChangesPerMin**: `Σ(scene changes) / Σ(outDur/60)`(観測ごとの生カウントと尺を総和)。
- **provenance**: own のみ→`own-project` / bare のみ→`bare-video` / 混在→`merged`
  (reference は v1 未生成)。
- **sampleSize**: `projects = own の数` / `videos = bare の数` / `shots = Σ shotDurations 長` /
  `captions = Σ captionCount`。
- **structure.segments**: 入力1本のときだけそのまま。N>1 は timeline を混ぜられないため `segments=null`
  にし、`hookSec` は平均、`ctaLikely` は多数決(過半 true→true)。`chapterCount` の平均は
  **実装訂正**(コードレビュー反映): `o.chapters?.length`(= `out !== null` でフィルタ後の
  segments 数)ではなく、`observeOwnProject` が保存した **真の `o.chapterCount`**
  (`structureFrom` 由来。`out === null` の丸ごとカットされた章も含む)を、own かつ
  `chapterCount !== null` の観測だけ対象に平均する(`o.chapters?.length` で代用すると
  丸ごとカットされた章が静かに欠落するバグがあった)。
- **correctionDelta**: own-project かつ delta を持つ観測**だけ**を対象に、`cuts.proposed/final` 等を
  総和(件数の合算)、`description` は最頻ラベル。own の delta が1つも無ければ profile.correctionDelta=null。
- **confidence**: 各 section の `sampleSize`(プール後)と `projectCount`(own の数)で `sectionConfidence`。
- `provenance` を各 `SectionMeta` にも設定(その section に寄与した入力型の集合。own+bare 混在で
  値が両方由来なら `merged`、片方のみなら該当型)。

### 2.8 config セクションの要否 — **不要(v1)**

`resolveEffectCheckCfg` 等の opt-in パターンは検討したが、SD-T0 では **config セクションを追加しない**:

- 閾値(cutAggressiveness の 2/4/7、density の 0.3/0.6、CTA 語、SCENE_CHANGE_THRESHOLD、confidence の
  kSample 等)は **`src/lib/styleProfile.ts` の module 定数**(`lib/profile.ts` の PROFILES 同様の
  「組み込み定数」)にする。収録ごとの調整需要はまだ無く、config 化は surface を無駄に広げる
  (`validateWorkflowConfig` 追記・`test/config.test.ts` ドリフトを招く)。
- 注入の opt-in `plan.styleProfile`(既定 off・バイト等価)は **SD-T4 の担当**で本書スコープ外。
- よって `src/lib/config.ts` は無変更。将来チューニングが要れば `resolveStyleProfileCfg(cfg)` を
  この定数群から差し替える形で後付けできる(拡張点)。

### 2.9 CLI 登録(`src/cli.ts`)

`--from` 複数値は commander の collect 関数で(既存 cli.ts に複数値オプションの前例は無いため明示):

```ts
import { styleProfile, formatStyleProfileReport } from "./stages/styleProfile.ts";

function collectFrom(value: string, prev: string[]): string[] { return [...prev, value]; }

program
  .command("style-profile")
  .description(
    "任意の動画/収録パスからスタイルプロファイルを抽出し、channel(最初の --from の親ディレクトリ)の " +
      "style.probe/<name>.json に書く。収録(manifest+cutplan あり)= 統計+補正デルタ(own-project)、" +
      "素の動画/フォルダ = 観測統計のみ(bare-video)。決定論のみ・編集ファイルは1バイトも書かない",
  )
  .option("--from <path>", "入力パス(収録フォルダ or 素の動画/フォルダ)。複数指定可", collectFrom, [])
  .option("--name <name>", "プロファイル名(出力ファイル名 style.probe/<name>.json)。省略時 default")
  .action(async (opts: { from: string[]; name?: string }) => {
    const cfg = loadConfig(program.opts().config);
    const result = await styleProfile({ from: opts.from, name: opts.name }, cfg);
    for (const line of formatStyleProfileReport(result)) console.log(line);
  });
```

- **位置引数 `<dir>` を取らない**(他コマンドと違い `--from` 主導)。これは仕様(母艦 §10.0 の
  `style-profile --from <path>`)。
- `agentsMd.test.ts` の `extractCliCommandNames` は `.command("style-profile"` を拾うので、
  **AGENTS_CONTRACT.md のコマンド表に `| \`style-profile\`` 行が必須**(§2.11)。

### 2.10 `files.ts` の差分

```ts
// GENERATED_DIRS に "style.probe" を1語追加(av.probe/review.probe と同列)
const GENERATED_DIRS: readonly string[] =
  ["frames", "render.chunks", "shorts", "materials.probe", "av.probe", "review.probe", "style.probe"];
```
コメントに「`style.probe/`(`style-profile` が channel 直下に書く profile 集約。生成物)」を1文添える。
`test/files.test.ts` に `fileRole("style.probe/default.json") === "generated"` の1ケースを追加
(av.probe/review.probe と同型)。

### 2.11 5点セット各所の差分(母艦 §7・CLAUDE.md「コードを触るとき」)

生成物なので**編集ファイル用の 5 点セットは一部だけ該当**する。該当・非該当を明示:

| 箇所 | 差分 | 必須理由 |
|---|---|---|
| `src/types.ts` | **無変更**(型は styleProfile.ts。§2.3) | 生成物型は module 内が慣行・schema.test を揺らさない |
| `src/stages/validate.ts` | **無変更** | profile は生成物・`validate <dir>` の対象外 |
| `docs/usage.md` | コマンド説明を1節追加(§下)+ 生成物一覧に `style.probe/` を1行 | ドキュメント整合 |
| `schemas/*.schema.json` | **追加しない**(§下) | `schema.test.ts` の全単射が壊れる |
| `schemas/examples/*.max.json` | **追加しない** | 同上 |
| `AGENTS_CONTRACT.md` | コマンド表に `style-profile` 行 + generated 一覧に `style.probe/` | **`agentsMd.test.ts` がコマンド表を必須ピン留め** |
| `CLAUDE.md` | コマンド一覧に `style-profile` / 中間生成物に `style.probe/` | CLAUDE.md 自身の運用ルール |

**`schemas/` に profile スキーマを置くかの決定 = 置かない**。理由(コード確認済み・確定):
`test/schema.test.ts` の全単射テストは `schemas/*.schema.json` の集合が **8編集ファイル用スキーマと
完全一致**であることを `sortedEq(editableSchemas, expected)` で強制する(common/apply-patch/assertions
だけ除外)。生成物用スキーマを1つでも `schemas/` に置くと**この全単射が壊れて `npm test` が落ちる**。
`av.probe/sound.json` / `effect-check.json` / `bgm-fit.json` など**既存の生成物 JSON はすべて
`schemas/` にスキーマを持たない**のと同じ扱いにする。**profile の機械可読契約は
`src/lib/styleProfile.ts` の `StyleProfile` 型 + `STYLE_PROFILE_SCHEMA_VERSION` 定数**が担う
(av.ts の `SCHEMA_VERSION` と同型)。

**docs/usage.md 追記文(そのまま使える下書き)**:
> `node src/cli.ts style-profile --from <path> [--from <path> ...] [--name <名前>]` … 任意の動画/収録
> パスから**スタイルプロファイル**(テンポ・字幕密度/位置・ラウドネス・構成の観測統計)を抽出し、
> channel(最初の `--from` の親ディレクトリ)の `style.probe/<名前>.json`(省略時 `default.json`)へ
> 書く。収録プロジェクト(manifest+cutplan あり)は**観測統計 + AI 提案→人間仕上げの補正デルタ**
> (`own-project`)、素の動画/plain フォルダは**観測統計のみ**(`bare-video`)。決定論のみ・編集
> ファイルは1バイトも書かない。`av <dir>` を先に走らせておくと音の統計(LUFS 等)が加わる。
> `--from` 複数で1プロファイルへ集約(作風が違う動画は `--name` で分ける)。

---

## 3. 検証(コーディネータが実測する手順)

### 3.1 型・テスト

- `npx tsc --noEmit`(= `npm run typecheck`)が通る。
- `npm test` が緑(既存テスト + 新規 `test/styleProfile.test.ts`)。特に `test/schema.test.ts`
  (schemas/ 無追加なので不変)・`test/agentsMd.test.ts`(コマンド表に行を足したので緑)・
  `test/files.test.ts`(style.probe ケース追加)を確認。

### 3.2 新規ユニットテスト `test/styleProfile.test.ts`(純関数を realistic 値で固定)

母艦 [[precision-measurement-nondeterminism-wall]]「D 次元は関数直叩きで測る」。以下を最低ケースに:

1. **mean/median/percentile**: `shots=[0.7,1.7,12.5,7.5,4.5,4.6,9.2,5.2,2.4,10.6,9.8,1,3.4,7.5,3.1,4.6,3,5.6,1.4]`
   → `mean≈5.17` / `median=4.6` / `p10≈1.32` / `p90≈9.96`。空配列 → null。
2. **unionCoverageSec**: 重なる区間 `[{0,3},{2,5},{7,8}]` → `union=6`(重複二重計上しない)。
3. **cutAggressivenessLabel**: 境界 `2→high`, `2.01→medium-high`, `4→medium-high`, `4.01→medium`,
   `7→medium`, `7.01→low`, `null→null`。
4. **captionDensityLabel**: `0.29→low`, `0.3→medium`, `0.59→medium`, `0.6→high`, `null→null`。
5. **positionHintLabel**: `{top:1,center:1,bottom:8}`→`bottom`(80%) / `{top:4,center:3,bottom:3}`→`mixed` /
   `{0,0,0}`→null。
6. **sectionConfidence**: `present:false`→0 / `(sampleSize:19,projectCount:1,kSample:8,cv:0.5)`→
   `≈0.70*0.5*0.85 ≈ 0.30`(±0.02)/ projectCount を 1→3 に上げると単調増加。
7. **computeCorrectionDelta**: 合成 `planRaw`(cuts 9・chapters 4・titles 3・description X)と合成 `proj`
   から `cuts.proposed=9` / `chapters.titlesKeptVerbatim` の verbatim 一致カウント / `titles.keptVerbatim` /
   `description` ラベル(identical/edited/replaced/none 各1ケース)。
8. **parsePlanRaw**: 正常 JSON → 構造 / 前後注釈付き `"...{...}..."` → 抽出成功 / 壊れ → null。
9. **observeBareVideo**: captions/structure/**delta が全 null/空**であること(§8 不変条件1 の機械的固定)。
10. **mergeObservations**:
    - own×2 → `provenance="own-project"` / `sampleSize.projects=2` / shots がプールされ mean が
      **プール平均**(平均の平均でない)。
    - own×1 + bare×1 → `provenance="merged"` / `correctionDelta` は own の delta のみ由来 /
      bare の captions/structure は集約に寄与しない(null を混ぜない)。
    - bare のみ → `correctionDelta=null`。
11. **styleFlagsFrom**: `fontWeight:700`→"bold" / `outlineColor:"none"`→フラグ無し /
    `background`有→"boxed" の distinct 収集。

### 3.3 own-project 実走(主検証・cold-start テストデータ)

```
node src/cli.ts av /Users/19mo/Movies/cutflow/2026-07-02          # audio 統計を出すため(既に av.probe あり)
node src/cli.ts style-profile --from /Users/19mo/Movies/cutflow/2026-07-02
```
期待(実測目安):

- 出力: `/Users/19mo/Movies/cutflow/style.probe/default.json`(**channel = 親 `/Users/19mo/Movies/cutflow`**)。
- `provenance: "own-project"` / `sampleSize.projects=1, shots=19, captions=30`。
  (注: 母艦の「keeps 18本」は概数で、**実 cutplan は 19 keeps**=本設計の期待値は 19。)
- `cutDensity.avgShotSec ≈ 5.17` / `medianShotSec=4.6` / `shotSecP10≈1.32` / `shotSecP90≈9.96` /
  `sceneChangesPerMin ≈ 11.6`(motion があれば sceneScore 由来に置換)/ `cutAggressiveness="medium"`。
- `captions.coverageRatio`(実行時算出・0.6 超が目安)→ `density="high"` / `avgDisplaySec` 実値 /
  `positionHint`(captionTracks 既定 y から・bottom 目安)。
- `audio`: av.probe/sound.json があるので `integratedLufs`/`truePeakDbtp`/`silenceCount`/`bgmLikely=true`
  (bgm.json あり)。**av を消して再走すると audio 全 null + warning + confidence 0**(cold-start 劣化確認)。
- `structure.chapterCount=4` / `hookSec`(最初の章の尺・実値)/ `ctaLikely=true`(末尾章「参考にした
  ブログとまとめ」に「まとめ」)。
- `correctionDelta`: plan.raw.txt あり → `cuts { proposed:9, final:~10 }` /
  `chapters { proposed:4, final:4, titlesKeptVerbatim:… }` / `titles { proposed:3, final:3, keptVerbatim:… }` /
  `description` ラベル。各 section の `confidence` は 1 project ゆえ **0.2〜0.5 の低め**(cold-start が
  正直に出ていること=§8 不変条件の目視確認)。
- **編集ファイル不変**: 実行後 `git status`(収録フォルダ)で cutplan/transcript/overlays/bgm/meta/
  chapters/approvals が**未変更**であること(§8 不変条件2)。書かれるのは `style.probe/default.json` のみ。

### 3.4 複数 `--from` 集約(schema の複数対応を実走)

`2026-07-10` / `2026-07-10_2` の承認状態は要確認(承認不要=describeJson は承認と無関係に射影できる。
manifest+cutplan があれば own-project として吸収可)。

```
node src/cli.ts style-profile --from /Users/19mo/Movies/cutflow/2026-07-02 \
  --from /Users/19mo/Movies/cutflow/2026-07-10 --name multi
```
期待: `style.probe/multi.json` / `sampleSize.projects=2` / shots プール / `provenance="own-project"` /
各 section の confidence が単一より上がる(projectFactor 0.5→0.667)。**2026-07-10 が manifest/cutplan を
欠く/describeJson が throw する場合**は、その旨を報告(その収録は own-project 前提を満たさない)。

### 3.5 bare-video モードの検証

`2026-07-02` の**素の .mkv をファイルとして** `--from` に渡すと(フォルダでなくファイル指定なので
`classifyInput` は bare-video):

```
node src/cli.ts style-profile --from "/Users/19mo/Movies/cutflow/2026-07-02/2026-07-02 17-26-36.mkv" --name bare-test
```
期待: `provenance:"bare-video"` / `correctionDelta:null`(§8 不変条件1)/ `captions`/`structure` 全 null /
`audio` は同フォルダの `av.probe/sound.json` があれば実値・無ければ null / `cutDensity` は motion があれば
値・無ければ null / `sampleSize.videos=1, projects=0`。出力先 channel = `dirname(file)` =
`/Users/19mo/Movies/cutflow/2026-07-02/style.probe/bare-test.json`(生成物なので収録フォルダ内でも可)。
**クリーンな bare-video** を見たい場合は .mkv を空フォルダへコピーして `--from <その動画>`(av.probe が
無いので audio=null・ffprobe レベルの尺/解像度/fps/hasAudio のみ)。

### 3.6 既存挙動バイト等価

新コマンド追加 + `files.ts` の `GENERATED_DIRS` 1語追加のみで、**既存コマンドの出力ロジックは不変**。
確認: `npm test` 緑(既存 stage の golden/snapshot テストが不変)。`GENERATED_DIRS` への追加は
`fileRole("style.probe/…")` を `"other"→"generated"` に変えるだけで、既存の分類(av.probe 等)には
影響しない(`files.test.ts` の既存ケースが緑)。

---

## 4. リスク

1. **非決定性**: 低い。統計は決定論(D 次元・関数直叩きで固定=§3.2)。唯一の非決定要素は av.probe の
   有無で audio が変わる点だが、それは `hasAv`/confidence で明示され、値自体は決定論。
   → §3.2 のユニットテストが回帰基準線。
2. **av 未生成時の劣化**: own-project で `av` 未実行だと audio 全 null。**設計上の意図**(cold-start に
   強い・av は optional)。warning を出し confidence 0 で正直に表す。誤解防止に stdout と warnings で
   「先に `av <dir>`」を明示。母艦の「av 依存 optional」確定どおり。
3. **bare-video の重さ/浅さ**: v1 は ffprobe レベル + 既存 av.probe のみ(§1.4)。ingest/whisper/detect は
   起動しない=軽いが、素の動画単体では captions/structure/delta が出ない(§3 の (A)/(B) 境界どおり)。
   これは**能力境界であって欠陥ではない**(§8 不変条件1)。フル bare-video 抽出は v2 拡張点。
4. **cold-start の sampleSize=1**: confidence を projectFactor で 0.5 倍にして**低く出す**(§2.5)。
   「1本の癖を全体の型と誤認しない」ための可視化。SD-T1/T4 は confidence を下流で重みに使える。
5. **補正デルタの粒度が粗い**: cut を件数比較に留めた(候補格子を再構築しない・§2.6)。source 秒への
   逆写像を欲張ると plan 内部(numberSegments/candidate grid)へ密結合し脆くなる。母艦「決定論で
   取れる粒度に留める・過剰設計を避ける」に沿った意図的な割り切り。より精密な delta は候補格子を
   永続化する別施策(v2)。
6. **5点セットのテストピン留れ漏れ**: 実害の出るピン留めは2つ — (a) `agentsMd.test.ts` が CLI コマンド
   表を全数照合 → **AGENTS_CONTRACT.md にコマンド行を必ず足す**(漏れると即 red)。(b) `schema.test.ts`
   の全単射 → **schemas/ に何も足さない**(足すと即 red)。この2点さえ守れば緑。`files.test.ts` の
   style.probe ケースは網羅目的の追加(既存を壊さない)。
7. **`motion.json` 名の未 export**: `av.ts` の `MOTION_FILE` は未 export。orchestrator がリテラルを持つ
   ことで結合(§2.4)。将来 av.ts が名前を変えたら追随が要る(低リスク・コメントで明記)。
8. **channel 衝突**: bare-video をファイル指定すると channel=そのファイルのフォルダになり、収録フォルダ
   内に `style.probe/` ができる。生成物なので実害なし(§2.4 のルールが uniform=`dirname(resolve(from[0]))`)。
   ユーザーが profile を集めたい場所は `--from` の並べ方で決まる(母艦「--name 単位でユーザーが決める」)。

---

## 付録: 実装順(Sonnet 向け・最短で緑にする順)

1. **`src/lib/styleProfile.ts`**: 型 + module 定数 + 小ヘルパ(mean/median/percentile/unionCoverageSec)
   + ラベル写像 + `sectionConfidence` + `parsePlanRaw`/`computeCorrectionDelta` + `styleFlagsFrom`/
   `structureFrom` + `observeOwnProject`/`observeBareVideo` + `mergeObservations`。**IO ゼロ**。
2. **`test/styleProfile.test.ts`**: §3.2 の11ケース。ここで純関数を固めてから殻に進む。
3. **`src/stages/styleProfile.ts`**: orchestrator + `formatStyleProfileReport`(§2.4)。`describeJson`・
   av.probe 読込・ffprobe(`lib/ffmpeg.ts` の `probe`)・classifyInput/resolveVideoFile。
4. **`src/cli.ts`**: `style-profile` 登録(§2.9・collect 関数)。
5. **`src/lib/files.ts`**: `GENERATED_DIRS` に `"style.probe"` + `test/files.test.ts` に1ケース。
6. **ドキュメント**: `AGENTS_CONTRACT.md`(コマンド表行=**必須**・generated 一覧)→ `docs/usage.md` →
   `CLAUDE.md`。
7. `npx tsc --noEmit` → `npm test` → §3.3 の own-project 実走で provenance/数値/編集ファイル不変を確認。
