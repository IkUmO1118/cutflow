// SD-T0: style-profile の純関数群(観測集約・ラベル写像・confidence・補正
// デルタ・merge)。§docs/plans/2026-07-12-sd-t0-style-profile-design.md
//
// fs/ffmpeg/LLM には一切依存しない(IO ゼロ・決定論)。`DescribeProjection`
// (describe.ts)・`SoundReport`/`MotionReport`(av.ts)は import type だけで
// 取り込む(Node の type stripping で実行時に消える=stage への runtime
// 依存なし・循環なし)。generatedAt だけは wall-clock(new Date())を使う
// (av.ts の capturedAt と同じ精神。値の決定論性そのものには影響しない)。

import type { CaptionEntry, DescribeProjection } from "../stages/describe.ts";
import type { SoundReport, MotionReport } from "../stages/av.ts";
import type { CaptionStyle, CaptionTrackDef } from "../types.ts";

/* ======================================================================
 * §2.1 型定義
 * ==================================================================== */

/** style.probe/<name>.json のスキーマ版。破壊的変更で +1 */
export const STYLE_PROFILE_SCHEMA_VERSION = 1;

/** 集約の出所。§7・§8 不変条件1。bare-video は補正デルタ (B) を持てない=provenance で表す */
export type Provenance = "own-project" | "bare-video" | "reference" | "merged";

/** 全時刻の軸(§8 不変条件4)。v1 は常に "reference-output"(見本/自コーパスの出力秒基準) */
export type StyleAxis = "reference-output";

/** 各 section が持つ出所メタ。section ごとに1つ(cutDensity/captions/audio/
 * structure/correctionDelta の粒度) */
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
  /** avgShotSec → 閾値ラベル(決定論写像)。値が無ければ null */
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
  /** caption 位置バケットの多数決ラベル */
  positionHint: "top" | "center" | "bottom" | "mixed" | null;
  /** 位置の内訳(件数)。SD-T1 の位置距離の素地。値が無ければ null */
  positionHistogram: { top: number; center: number; bottom: number } | null;
  /** v1 は決定論由来のみ(bold/outlined/boxed/karaoke 等)。VLM styleNotes は拡張点で追記 */
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

/** 構成(§7 structure)。母艦「構成テンプレ」。own-project の chapters を出力秒へ射影 */
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

/** delta の生値(SectionMeta を付ける前)。CorrectionDelta の cuts/chapters/titles/description と同型 */
export interface CorrectionDeltaRaw {
  cuts: { proposed: number; final: number };
  chapters: { proposed: number; final: number; titlesKeptVerbatim: number };
  titles: { proposed: number; final: number; keptVerbatim: number };
  description: "identical" | "edited" | "replaced" | "none";
}

/** 補正デルタ(§7 の (b) 信号)。own-project + plan.raw.txt のときだけ。
 *  bare-video は null(§8 不変条件1)。AI 提案(plan.raw.txt)→ 人間最終
 *  (cutplan/chapters/meta)の要約統計(件数と verbatim 残存の粒度に留める) */
export interface CorrectionDelta {
  meta: SectionMeta;
  cuts: { proposed: number; final: number } | null;
  chapters: { proposed: number; final: number; titlesKeptVerbatim: number } | null;
  titles: { proposed: number; final: number; keptVerbatim: number } | null;
  description: "identical" | "edited" | "replaced" | "none" | null;
}

/** 各 --from の記録(監査・§8 不変条件1 の可視化用) */
export interface SourceRef {
  path: string;
  kind: "own-project" | "bare-video";
  durationSec: number | null;
  keepCount: number | null; // own-project のみ
  captionCount: number | null; // own-project のみ
  hasAv: boolean; // av.probe/sound.json を読めたか
  hasPlanRaw: boolean; // plan.raw.txt があった(補正デルタ可否)
}

/** style.probe/<name>.json 本体(§7 v1 scope) */
export interface StyleProfile {
  schemaVersion: number; // = STYLE_PROFILE_SCHEMA_VERSION
  name: string; // --name(省略時 "default")
  provenance: Provenance; // 全体の出所(混在=merged)
  axis: StyleAxis; // 常に "reference-output"(§8 不変条件4)
  generatedAt: string; // ISO8601
  sampleSize: {
    projects: number; // own-project 入力の数
    videos: number; // bare-video 入力の数
    shots: number; // 全 keep 数の総和(cutDensity の母数)
    captions: number; // 全 caption 数の総和
  };
  sources: SourceRef[];
  cutDensity: CutDensity;
  captions: CaptionsProfile;
  audio: AudioProfile;
  structure: StructureProfile;
  /** own-project 由来があるときだけ非 null。bare-video のみなら null(§8 不変条件1) */
  correctionDelta: CorrectionDelta | null;
}

/** merge が畳めるだけの十分統計を持つ、入力1本の観測 */
export interface ProjectObservation {
  kind: "own-project" | "bare-video";
  path: string;
  durationSec: number | null;
  // --- cut density ---
  shotDurations: number[]; // keep durationSec 群(bare は [])
  outDurationSec: number | null;
  sceneChangesPerMin: number | null;
  // --- captions ---
  captionOutIntervals: { start: number; end: number }[]; // 全 caption の出力秒区間(coverage union 用)
  captionDisplaySecs: number[]; // 各 caption の出力表示秒(avgDisplaySec 用)
  /** この観測自身の canvasHeight で分類済みの位置バケット数。observeOwnProject が
   *  captionBucketOf で数え上げる(明示 pos も track 既定も無ければ bottom 既定。
   *  レンダラー既定フォールバック=remotion/Main.tsx:326-329 と一致させるため)。
   *  merge はフィールドごとに合算するだけ(異解像度混在でも分母がズレない) */
  positionHistogram: { top: number; center: number; bottom: number };
  captionCount: number; // 全 caption 数(pos 有無問わず)
  styleFlags: string[]; // 決定論 styleNotes(重複可・merge で頻度集約)
  // --- audio ---
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  silenceCount: number | null;
  silenceSec: number | null;
  bgmLikely: boolean | null;
  hasAv: boolean;
  // --- structure ---
  chapters: { name: string; startOutSec: number; endOutSec: number }[] | null;
  /** 真の章数(out===null の章=丸ごとカットされた章も含む。structureFrom の chapterCount)。
   *  own-project のみ。bare-video は null */
  chapterCount: number | null;
  hookSec: number | null;
  ctaLikely: boolean | null;
  // --- correction delta(own-project + plan.raw のみ) ---
  delta: CorrectionDeltaRaw | null;
  hasPlanRaw: boolean;
}

/** plan.raw.txt(AI 提案)の寛容パース結果 */
export interface PlanRaw {
  cuts: { id: number; reason?: string }[];
  chapters: { startId: number; title: string }[];
  titles: string[];
  description: string;
}

/* ======================================================================
 * module 定数(閾値・CTA語・kSample・SCENE_CHANGE_THRESHOLD)
 * ==================================================================== */

/** motion.json の sceneScore がこれ以上ならシーンチェンジとみなす(§2.5) */
const SCENE_CHANGE_THRESHOLD = 0.4;

/** 末尾章タイトルに含まれれば ctaLikely=true とみなす語(§2.5) */
const CTA_KEYWORDS = ["まとめ", "チャンネル登録", "高評価", "フォロー", "登録", "subscribe", "like"];

/** avgShotSec → cutAggressiveness の閾値(秒。境界は「以下」側に倒す。§3.2 ケース3) */
const CUT_AGGRESSIVENESS_THRESHOLDS = { high: 2, mediumHigh: 4, medium: 7 } as const;

/** coverageRatio → density の閾値(§3.2 ケース4) */
const CAPTION_DENSITY_THRESHOLDS = { low: 0.3, medium: 0.6 } as const;

/** positionHint: 最多バケットが総数のこの比率以上なら多数決ラベル、未満なら mixed */
const POSITION_HINT_MAJORITY_RATIO = 0.6;

/** sectionConfidence の spread(分布のばらつきによる軽いペナルティ)の係数 */
const SPREAD_CV_WEIGHT = 0.3;
const SPREAD_MIN = 0.7;
const SPREAD_MAX = 1;

/** section 別の飽和定数(§2.5)。単位は section ごとに異なる(shots/captions/projects/chapters) */
const K_SAMPLE = {
  cutDensity: 8, // shots
  captions: 10, // captions
  audio: 1, // projects
  structure: 2, // chapters
  correctionDelta: 1, // projects
} as const;

/* ======================================================================
 * §2.2(f) 小さな決定論ヘルパ
 * ==================================================================== */

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** p は 0..1・線形補間(index = p*(n-1)、floor/ceil 間を線形補間) */
export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

/** 区間 union の総和(重なりを二重計上しない) */
export function unionCoverageSec(intervals: { start: number; end: number }[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = sorted[0].start;
  let curEnd = sorted[0].end;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
    if (iv.start <= curEnd) {
      curEnd = Math.max(curEnd, iv.end);
    } else {
      total += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    }
  }
  total += curEnd - curStart;
  return total;
}

/** captionTracks/caption.style から決定論フラグを distinct 収集 */
export function styleFlagsFrom(proj: DescribeProjection): string[] {
  const flags = new Set<string>();
  const consider = (style: CaptionStyle | undefined): void => {
    if (!style) return;
    if (style.fontWeight !== undefined && style.fontWeight >= 700) flags.add("bold");
    if (style.outlineColor !== undefined && style.outlineColor !== "none") flags.add("outlined");
    if (style.background !== undefined) flags.add("boxed");
    if (style.karaoke !== undefined) flags.add("karaoke");
    if (style.anim !== undefined && style.anim.in !== undefined && style.anim.in !== "none") {
      flags.add("animated");
    }
  };
  for (const ct of proj.overlays.captionTracks) consider(ct.style);
  for (const cap of proj.captions) consider(cap.style);
  return [...flags];
}

/** chapters から構成セグメント(出力秒)・章数・フック秒・CTA 有無を作る */
export function structureFrom(proj: DescribeProjection): {
  segments: { name: string; startOutSec: number; endOutSec: number }[] | null;
  chapterCount: number;
  hookSec: number | null;
  ctaLikely: boolean | null;
} {
  const withOut = proj.chapters
    .filter((c): c is DescribeProjection["chapters"][number] & { out: number } => c.out !== null)
    .sort((a, b) => a.out - b.out);
  const outDur = proj.summary.outDurationSec;
  const segments =
    withOut.length > 0
      ? withOut.map((c, i) => ({
          name: c.title,
          startOutSec: c.out,
          endOutSec: i + 1 < withOut.length ? withOut[i + 1].out : outDur,
        }))
      : null;
  const chapterCount = proj.chapters.length;
  const hookSec = segments !== null && segments.length >= 2 ? segments[0].endOutSec : null;
  const lastTitle = chapterCount > 0 ? proj.chapters[proj.chapters.length - 1].title : null;
  const ctaLikely =
    chapterCount > 0 && lastTitle !== null
      ? CTA_KEYWORDS.some((k) => lastTitle.includes(k))
      : null;
  return { segments, chapterCount, hookSec, ctaLikely };
}

/* ======================================================================
 * §2.2(c) 決定論の閾値→ラベル写像
 * ==================================================================== */

export function cutAggressivenessLabel(avgShotSec: number | null): CutDensity["cutAggressiveness"] {
  if (avgShotSec == null) return null;
  if (avgShotSec <= CUT_AGGRESSIVENESS_THRESHOLDS.high) return "high";
  if (avgShotSec <= CUT_AGGRESSIVENESS_THRESHOLDS.mediumHigh) return "medium-high";
  if (avgShotSec <= CUT_AGGRESSIVENESS_THRESHOLDS.medium) return "medium";
  return "low";
}

export function captionDensityLabel(coverageRatio: number | null): CaptionsProfile["density"] {
  if (coverageRatio == null) return null;
  if (coverageRatio < CAPTION_DENSITY_THRESHOLDS.low) return "low";
  if (coverageRatio < CAPTION_DENSITY_THRESHOLDS.medium) return "medium";
  return "high";
}

export function positionHintLabel(
  hist: { top: number; center: number; bottom: number } | null,
): CaptionsProfile["positionHint"] {
  if (hist === null) return null;
  const total = hist.top + hist.center + hist.bottom;
  if (total === 0) return null;
  const entries: [NonNullable<CaptionsProfile["positionHint"]>, number][] = [
    ["top", hist.top],
    ["center", hist.center],
    ["bottom", hist.bottom],
  ];
  let bestLabel = entries[0][0];
  let bestCount = entries[0][1];
  for (const [label, count] of entries) {
    if (count > bestCount) {
      bestLabel = label;
      bestCount = count;
    }
  }
  return bestCount / total >= POSITION_HINT_MAJORITY_RATIO ? bestLabel : "mixed";
}

/* ======================================================================
 * §2.2(d) confidence
 * ==================================================================== */

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** 0..1。present=false なら 0。sampleSize と projectCount と(任意)変動係数から算出 */
export function sectionConfidence(args: {
  present: boolean;
  sampleSize: number;
  projectCount: number;
  kSample: number;
  cv?: number | null;
}): number {
  if (!args.present) return 0;
  const base = args.sampleSize / (args.sampleSize + args.kSample);
  const project = args.projectCount / (args.projectCount + 1);
  const cv = args.cv ?? null;
  const spread = cv == null ? 1 : clamp(1 - Math.min(cv, 1) * SPREAD_CV_WEIGHT, SPREAD_MIN, SPREAD_MAX);
  return round2(base * project * spread);
}

/* ======================================================================
 * §2.2(e) 補正デルタ
 * ==================================================================== */

function normText(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function wordsOf(s: string): Set<string> {
  return new Set(
    s
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** plan.raw.txt(AI 提案)と最終 proj(人間仕上げ)から要約統計を作る */
export function computeCorrectionDelta(planRaw: PlanRaw, proj: DescribeProjection): CorrectionDeltaRaw {
  const cuts = { proposed: planRaw.cuts.length, final: proj.cuts.length };

  const finalChapterTitles = new Set(proj.chapters.map((c) => normText(c.title)));
  const titlesKeptVerbatim = planRaw.chapters.filter((c) =>
    finalChapterTitles.has(normText(c.title)),
  ).length;
  const chapters = {
    proposed: planRaw.chapters.length,
    final: proj.chapters.length,
    titlesKeptVerbatim,
  };

  const finalTitles = new Set(proj.meta.titles.map(normText));
  const keptVerbatim = planRaw.titles.filter((t) => finalTitles.has(normText(t))).length;
  const titles = { proposed: planRaw.titles.length, final: proj.meta.titles.length, keptVerbatim };

  const f = normText(proj.meta.description);
  const p = normText(planRaw.description);
  let description: CorrectionDeltaRaw["description"];
  if (f === "") description = "none";
  else if (f === p) description = "identical";
  else if (jaccard(wordsOf(p), wordsOf(f)) >= 0.5) description = "edited";
  else description = "replaced";

  return { cuts, chapters, titles, description };
}

function tryParseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function isPlanRawShape(v: unknown): v is PlanRaw {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.cuts) &&
    Array.isArray(o.chapters) &&
    Array.isArray(o.titles) &&
    typeof o.description === "string"
  );
}

/** plan.raw.txt のテキストを寛容に parse。JSON でなければ null(補正デルタ省略=confidence へ反映) */
export function parsePlanRaw(text: string): PlanRaw | null {
  const direct = tryParseJson(text);
  const candidate = direct !== undefined ? direct : tryParseJson(extractBraces(text));
  if (candidate === undefined || !isPlanRawShape(candidate)) return null;
  return candidate;
}

/* ======================================================================
 * §2.2(a) 各入力を正規化した中間表現に落とす
 * ==================================================================== */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function stddev(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const m = mean(xs);
  if (m === null) return null;
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/** motion があれば sceneScore 由来を優先、無ければ keeps 数/出力分(own-project のみ
 * フォールバック可。bare-video は motion 無しなら null=§8 不変条件1 に沿った保守側) */
function computeSceneChangesPerMin(args: {
  motion: MotionReport | null;
  outDurationSec: number | null;
  fallbackCount: number;
  allowFallback: boolean;
}): number | null {
  const { motion, outDurationSec, fallbackCount, allowFallback } = args;
  if (outDurationSec === null || outDurationSec <= 0) return null;
  const minutes = outDurationSec / 60;
  if (motion) {
    const count = motion.motion.filter((m) => m.sceneScore >= SCENE_CHANGE_THRESHOLD).length;
    return round2(count / minutes);
  }
  if (allowFallback) return round2(fallbackCount / minutes);
  return null;
}

/** caption の描画位置バケット。明示 pos.y → track 既定 y → どちらも無ければ
 *  レンダラー既定(本編は下部中央)= "bottom"(remotion/Main.tsx:326-329 の
 *  captionDefaultPos 不在フォールバックと一致させる。無ければ positionHistogram
 *  から実質除外され、実データで多数派の bottom が top に化けるバグになる)。
 *  canvasHeight で top/center/bottom に分ける(観測自身の canvasHeight を使う=
 *  異解像度 merge でも分母がズレない) */
function captionBucketOf(
  cap: CaptionEntry,
  tracks: CaptionTrackDef[],
  canvasHeight: number,
): "top" | "center" | "bottom" {
  const y = cap.pos?.y ?? tracks.find((t) => t.track === cap.track)?.y ?? null;
  if (y === null) return "bottom";
  if (y < canvasHeight / 3) return "top";
  if (y < (2 * canvasHeight) / 3) return "center";
  return "bottom";
}

/** own-project 1本 → 観測。av は optional(null 可)。plan.raw は parsePlanRaw 済みを渡す */
export function observeOwnProject(args: {
  path: string;
  proj: DescribeProjection;
  sound: SoundReport | null;
  motion: MotionReport | null;
  planRaw: PlanRaw | null;
  bgmPresent: boolean;
}): ProjectObservation {
  const { path, proj, sound, motion, planRaw, bgmPresent } = args;
  const shotDurations = proj.keeps.map((k) => k.durationSec);
  const outDurationSec = proj.summary.outDurationSec;

  const sceneChangesPerMin = computeSceneChangesPerMin({
    motion,
    outDurationSec,
    fallbackCount: shotDurations.length,
    allowFallback: true,
  });

  const captionOutIntervals: { start: number; end: number }[] = [];
  const captionDisplaySecs: number[] = [];
  const positionHistogram = { top: 0, center: 0, bottom: 0 };
  const canvasHeight = proj.source.video.screenRegion.h;
  for (const cap of proj.captions) {
    let displaySec = 0;
    for (const o of cap.out) {
      captionOutIntervals.push({ start: o.start, end: o.end });
      displaySec += o.end - o.start;
    }
    captionDisplaySecs.push(round2(displaySec));
    positionHistogram[captionBucketOf(cap, proj.overlays.captionTracks, canvasHeight)]++;
  }

  const silences = sound?.silences ?? null;
  const silenceCount = silences ? silences.length : null;
  const silenceSec = silences ? round2(silences.reduce((a, s) => a + s.lenSec, 0)) : null;

  const structure = structureFrom(proj);

  return {
    kind: "own-project",
    path,
    durationSec: proj.source.durationSec,
    shotDurations,
    outDurationSec,
    sceneChangesPerMin,
    captionOutIntervals,
    captionDisplaySecs,
    positionHistogram,
    captionCount: proj.captions.length,
    styleFlags: styleFlagsFrom(proj),
    integratedLufs: sound?.mix?.integratedLufs ?? null,
    truePeakDbtp: sound?.mix?.truePeakDbtp ?? null,
    silenceCount,
    silenceSec,
    bgmLikely: bgmPresent || (sound?.bgm.spans.length ?? 0) > 0,
    hasAv: sound !== null,
    chapters: structure.segments,
    chapterCount: structure.chapterCount,
    hookSec: structure.hookSec,
    ctaLikely: structure.ctaLikely,
    delta: planRaw ? computeCorrectionDelta(planRaw, proj) : null,
    hasPlanRaw: planRaw !== null,
  };
}

/** bare-video 1本 → 観測。captions/structure/delta は持てない(全 null/空)。§8 不変条件1 */
export function observeBareVideo(args: {
  path: string;
  probe: { durationSec: number | null; width: number | null; height: number | null; fps: number | null; hasAudio: boolean };
  sound: SoundReport | null;
  motion: MotionReport | null;
}): ProjectObservation {
  const { path, probe, sound, motion } = args;
  const outDurationSec = probe.durationSec;
  const sceneChangesPerMin = computeSceneChangesPerMin({
    motion,
    outDurationSec,
    fallbackCount: 0,
    allowFallback: false,
  });

  const silences = sound?.silences ?? null;
  const silenceCount = silences ? silences.length : null;
  const silenceSec = silences ? round2(silences.reduce((a, s) => a + s.lenSec, 0)) : null;
  const bgmLikely = sound ? sound.bgm.spans.length > 0 : null;

  return {
    kind: "bare-video",
    path,
    durationSec: probe.durationSec,
    shotDurations: [],
    outDurationSec,
    sceneChangesPerMin,
    captionOutIntervals: [],
    captionDisplaySecs: [],
    positionHistogram: { top: 0, center: 0, bottom: 0 },
    captionCount: 0,
    styleFlags: [],
    integratedLufs: sound?.mix?.integratedLufs ?? null,
    truePeakDbtp: sound?.mix?.truePeakDbtp ?? null,
    silenceCount,
    silenceSec,
    bgmLikely,
    hasAv: sound !== null,
    chapters: null,
    chapterCount: null,
    hookSec: null,
    ctaLikely: null,
    delta: null,
    hasPlanRaw: false,
  };
}

/* ======================================================================
 * §2.2(b) N 観測 → 1 profile
 * ==================================================================== */

type Kind = ProjectObservation["kind"];

/** section に寄与した観測の kind 集合 → その section の provenance。
 * 何も寄与していなければプロファイル全体の provenance を fallback に使う */
function kindsToProvenance(kinds: Set<Kind>, fallback: Provenance): Provenance {
  if (kinds.size === 0) return fallback;
  if (kinds.has("own-project") && kinds.has("bare-video")) return "merged";
  return kinds.has("own-project") ? "own-project" : "bare-video";
}

function weightedMean(items: { value: number | null; weight: number | null }[]): number | null {
  let sumWeight = 0;
  let sumWeightedValue = 0;
  let any = false;
  for (const it of items) {
    if (it.value === null || it.weight === null || it.weight <= 0) continue;
    sumWeight += it.weight;
    sumWeightedValue += it.value * it.weight;
    any = true;
  }
  return any && sumWeight > 0 ? sumWeightedValue / sumWeight : null;
}

/** N 個の観測を 1 StyleProfile へ。分布統計は配列プーリング(平均の平均にしない)、
 *  比率は尺で加重、provenance は混在判定、correctionDelta は own-project 分だけ合算 */
export function mergeObservations(name: string, obs: ProjectObservation[]): StyleProfile {
  const ownObs = obs.filter((o) => o.kind === "own-project");
  const bareObs = obs.filter((o) => o.kind === "bare-video");
  const ownCount = ownObs.length;
  const bareCount = bareObs.length;

  const provenance: Provenance =
    ownCount > 0 && bareCount > 0 ? "merged" : ownCount > 0 ? "own-project" : "bare-video";
  // §2.7: 各 section の confidence は「own の数」を projectCount として使う(全 section 共通)
  const projectCount = ownCount;

  /* ---------------- cutDensity(own+bare 両方が寄与しうる) ---------------- */
  const shots = obs.flatMap((o) => o.shotDurations);
  const avgShotSec = mean(shots);
  const medianShotSec = median(shots);
  const shotSecP10 = percentile(shots, 0.1);
  const shotSecP90 = percentile(shots, 0.9);
  const shotsCv =
    shots.length > 0 && avgShotSec !== null && avgShotSec !== 0
      ? (stddev(shots) ?? 0) / avgShotSec
      : null;

  let sceneCountSum = 0;
  let sceneMinutesSum = 0;
  const cutDensityKinds = new Set<Kind>();
  for (const o of obs) if (o.shotDurations.length > 0) cutDensityKinds.add(o.kind);
  for (const o of obs) {
    if (o.sceneChangesPerMin !== null && o.outDurationSec !== null && o.outDurationSec > 0) {
      const minutes = o.outDurationSec / 60;
      sceneCountSum += o.sceneChangesPerMin * minutes;
      sceneMinutesSum += minutes;
      cutDensityKinds.add(o.kind);
    }
  }
  const sceneChangesPerMin = sceneMinutesSum > 0 ? round2(sceneCountSum / sceneMinutesSum) : null;

  const cutDensity: CutDensity = {
    meta: {
      provenance: kindsToProvenance(cutDensityKinds, provenance),
      confidence: sectionConfidence({
        present: avgShotSec !== null || sceneChangesPerMin !== null,
        sampleSize: shots.length,
        projectCount,
        kSample: K_SAMPLE.cutDensity,
        cv: shotsCv,
      }),
      sampleSize: shots.length,
    },
    avgShotSec: avgShotSec !== null ? round2(avgShotSec) : null,
    medianShotSec: medianShotSec !== null ? round2(medianShotSec) : null,
    shotSecP10: shotSecP10 !== null ? round2(shotSecP10) : null,
    shotSecP90: shotSecP90 !== null ? round2(shotSecP90) : null,
    sceneChangesPerMin,
    cutAggressiveness: cutAggressivenessLabel(avgShotSec !== null ? round2(avgShotSec) : null),
  };

  /* ---------------- captions(own-only。bare は集約に寄与しない) ---------------- */
  const captionOutIntervalsAll: { start: number; end: number }[] = [];
  const captionDisplaySecsAll: number[] = [];
  const positionHistogramTotal = { top: 0, center: 0, bottom: 0 };
  let captionCountSum = 0;
  let coverageSecSum = 0;
  let coverageOutDurSum = 0;
  const styleFlagSet = new Set<string>();
  for (const o of ownObs) {
    captionOutIntervalsAll.push(...o.captionOutIntervals);
    captionDisplaySecsAll.push(...o.captionDisplaySecs);
    captionCountSum += o.captionCount;
    if (o.outDurationSec !== null && o.outDurationSec > 0) {
      coverageSecSum += unionCoverageSec(o.captionOutIntervals);
      coverageOutDurSum += o.outDurationSec;
    }
    // 観測ごとに自身の canvasHeight で分類済みの histogram をフィールドごとに合算する
    // だけ(異解像度混在でも「1つの canvasHeight で全 y をバケット化」しないので分母がズレない)
    positionHistogramTotal.top += o.positionHistogram.top;
    positionHistogramTotal.center += o.positionHistogram.center;
    positionHistogramTotal.bottom += o.positionHistogram.bottom;
    for (const f of o.styleFlags) styleFlagSet.add(f);
  }
  const coverageRatio =
    coverageOutDurSum > 0 ? round2(Math.min(1, coverageSecSum / coverageOutDurSum)) : null;
  const avgDisplaySec = mean(captionDisplaySecsAll);
  const captionsCv =
    captionDisplaySecsAll.length > 0 && avgDisplaySec !== null && avgDisplaySec !== 0
      ? (stddev(captionDisplaySecsAll) ?? 0) / avgDisplaySec
      : null;
  const positionHistogramSum =
    positionHistogramTotal.top + positionHistogramTotal.center + positionHistogramTotal.bottom;
  const positionHistogram = positionHistogramSum > 0 ? positionHistogramTotal : null;
  const captionsKinds = new Set<Kind>(ownObs.length > 0 ? (["own-project"] as const) : []);

  const captions: CaptionsProfile = {
    meta: {
      provenance: kindsToProvenance(captionsKinds, provenance),
      confidence: sectionConfidence({
        present: captionCountSum > 0,
        sampleSize: captionCountSum,
        projectCount,
        kSample: K_SAMPLE.captions,
        cv: captionsCv,
      }),
      sampleSize: captionCountSum,
    },
    coverageRatio,
    avgDisplaySec: avgDisplaySec !== null ? round2(avgDisplaySec) : null,
    density: captionDensityLabel(coverageRatio),
    positionHint: positionHintLabel(positionHistogram),
    positionHistogram,
    styleNotes: [...styleFlagSet],
  };

  /* ---------------- audio(own+bare 両方が寄与しうる) ---------------- */
  const integratedLufs = weightedMean(obs.map((o) => ({ value: o.integratedLufs, weight: o.outDurationSec })));
  const truePeakDbtp = weightedMean(obs.map((o) => ({ value: o.truePeakDbtp, weight: o.outDurationSec })));
  const silenceCountContributors = obs.filter((o) => o.silenceCount !== null);
  const silenceCount =
    silenceCountContributors.length > 0
      ? silenceCountContributors.reduce((a, o) => a + (o.silenceCount ?? 0), 0)
      : null;
  let silenceSecSum = 0;
  let silenceOutDurSum = 0;
  for (const o of obs) {
    if (o.silenceSec !== null && o.outDurationSec !== null && o.outDurationSec > 0) {
      silenceSecSum += o.silenceSec;
      silenceOutDurSum += o.outDurationSec;
    }
  }
  const silenceRatio = silenceOutDurSum > 0 ? round2(silenceSecSum / silenceOutDurSum) : null;
  const bgmVals = obs.map((o) => o.bgmLikely);
  const bgmLikely = bgmVals.some((v) => v === true) ? true : bgmVals.every((v) => v === null) ? null : false;
  const avKinds = new Set<Kind>();
  for (const o of obs) if (o.hasAv) avKinds.add(o.kind);
  const avSampleSize = obs.filter((o) => o.hasAv).length;

  const audio: AudioProfile = {
    meta: {
      provenance: kindsToProvenance(avKinds, provenance),
      confidence: sectionConfidence({
        present: avSampleSize > 0,
        sampleSize: avSampleSize,
        projectCount,
        kSample: K_SAMPLE.audio,
        cv: null,
      }),
      sampleSize: avSampleSize,
    },
    integratedLufs: integratedLufs !== null ? round2(integratedLufs) : null,
    truePeakDbtp: truePeakDbtp !== null ? round2(truePeakDbtp) : null,
    silenceCount,
    silenceRatio,
    bgmLikely,
  };

  /* ---------------- structure(own-only) ---------------- */
  const chapterCounts = ownObs.map((o) => o.chapters?.length ?? 0);
  const totalChapters = chapterCounts.reduce((a, b) => a + b, 0);
  // chapterCount の平均は真の章数(out===null=丸ごとカットされた章も含む)を使う。
  // o.chapters?.length(segments。out!==null でフィルタ後)で代用すると、丸ごと
  // カットされた章が静かに欠落する
  const trueChapterCounts = ownObs
    .map((o) => o.chapterCount)
    .filter((v): v is number => v !== null);
  const chapterCount = trueChapterCounts.length > 0 ? round2(mean(trueChapterCounts) ?? 0) : null;
  const hookVals = ownObs.map((o) => o.hookSec).filter((v): v is number => v !== null);
  const hookSec = hookVals.length > 0 ? round2(mean(hookVals) ?? 0) : null;
  const ctaVals = ownObs.map((o) => o.ctaLikely).filter((v): v is boolean => v !== null);
  const ctaLikely = ctaVals.length > 0 ? ctaVals.filter(Boolean).length / ctaVals.length > 0.5 : null;
  const segments = ownObs.length === 1 ? ownObs[0].chapters : null;
  const structureKinds = new Set<Kind>(ownObs.length > 0 ? (["own-project"] as const) : []);

  const structure: StructureProfile = {
    meta: {
      provenance: kindsToProvenance(structureKinds, provenance),
      confidence: sectionConfidence({
        present: totalChapters > 0,
        sampleSize: totalChapters,
        projectCount,
        kSample: K_SAMPLE.structure,
        cv: null,
      }),
      sampleSize: totalChapters,
    },
    segments,
    chapterCount,
    hookSec,
    ctaLikely,
  };

  /* ---------------- correctionDelta(own-project かつ delta を持つ観測だけ) ---------------- */
  const deltaObs = ownObs.filter((o) => o.delta !== null);
  let correctionDelta: CorrectionDelta | null = null;
  if (deltaObs.length > 0) {
    const sumOf = (get: (d: CorrectionDeltaRaw) => number): number =>
      deltaObs.reduce((a, o) => a + get(o.delta as CorrectionDeltaRaw), 0);
    const cuts = { proposed: sumOf((d) => d.cuts.proposed), final: sumOf((d) => d.cuts.final) };
    const chapters = {
      proposed: sumOf((d) => d.chapters.proposed),
      final: sumOf((d) => d.chapters.final),
      titlesKeptVerbatim: sumOf((d) => d.chapters.titlesKeptVerbatim),
    };
    const titles = {
      proposed: sumOf((d) => d.titles.proposed),
      final: sumOf((d) => d.titles.final),
      keptVerbatim: sumOf((d) => d.titles.keptVerbatim),
    };
    const descCounts = new Map<CorrectionDeltaRaw["description"], number>();
    for (const o of deltaObs) {
      const label = (o.delta as CorrectionDeltaRaw).description;
      descCounts.set(label, (descCounts.get(label) ?? 0) + 1);
    }
    let bestLabel: CorrectionDeltaRaw["description"] = (deltaObs[0].delta as CorrectionDeltaRaw).description;
    let bestCount = -1;
    for (const [label, count] of descCounts) {
      if (count > bestCount) {
        bestLabel = label;
        bestCount = count;
      }
    }
    correctionDelta = {
      meta: {
        provenance: "own-project",
        confidence: sectionConfidence({
          present: true,
          sampleSize: deltaObs.length,
          projectCount,
          kSample: K_SAMPLE.correctionDelta,
          cv: null,
        }),
        sampleSize: deltaObs.length,
      },
      cuts,
      chapters,
      titles,
      description: bestLabel,
    };
  }

  const sources: SourceRef[] = obs.map((o) => ({
    path: o.path,
    kind: o.kind,
    durationSec: o.durationSec,
    keepCount: o.kind === "own-project" ? o.shotDurations.length : null,
    captionCount: o.kind === "own-project" ? o.captionCount : null,
    hasAv: o.hasAv,
    hasPlanRaw: o.hasPlanRaw,
  }));

  return {
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    name,
    provenance,
    axis: "reference-output",
    generatedAt: new Date().toISOString(),
    sampleSize: {
      projects: ownCount,
      videos: bareCount,
      shots: shots.length,
      captions: captionCountSum,
    },
    sources,
    cutDensity,
    captions,
    audio,
    structure,
    correctionDelta,
  };
}
