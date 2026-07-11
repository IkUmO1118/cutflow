// SD-T1: style-check の純関数群(profile→距離 assert / J→D 変換)。
// §docs/plans/2026-07-12-sd-t1-style-check-design.md
//
// fs/ffmpeg/LLM には一切依存しない(IO ゼロ・決定論)。reference(style-profile
// が書いた StyleProfile)と candidate(候補を mergeObservations で畳んだ
// StyleProfile。orchestrator=src/stages/styleCheck.ts が組む)を section
// (cutDensity/captions/audio。profile v1 scope=§2.8)ごとに突き合わせ、
// 逸脱を warn/info の finding として返す。fail は無い(母艦 §10.0/§8 不変条件3)。
import type { AudioProfile, CaptionsProfile, CutDensity, StyleProfile } from "./styleProfile.ts";

/* ======================================================================
 * §2.3.1 型定義
 * ==================================================================== */

/** style-check.json のスキーマ版。破壊的変更で +1 */
export const STYLE_CHECK_SCHEMA_VERSION = 1;

/** T1 v1 が距離を測る section(profile v1 scope = cut/caption/audio に閉じる。
 *  structure/effect密度/BGM cadence/素材 は §2.8 で defer) */
export type CheckSection = "cutDensity" | "captions" | "audio";

export type FindingKind =
  | "deviation" // 数値が学習帯の外(outer band 超過)
  | "borderline" // 数値が inner..outer の margin 帯(confidence の広げ分でだけ許容)
  | "mismatch" // カテゴリ/boolean ラベルの不一致
  | "skipped"; // profile 側 or 候補側に測定値が無い(欠測)

export type Severity = "warn" | "info";

/** 数値帯(numeric metric のみ。categorical/skipped は null) */
export interface Band {
  lo: number;
  hi: number;
}

export interface StyleFinding {
  kind: FindingKind;
  section: CheckSection;
  metric: string; // "avgShotSec" / "coverageRatio" / "positionHint" 等
  observed: number | string | null; // 候補の値(カテゴリはラベル文字列)
  expected: number | string | null; // profile の値/ラベル
  band: Band | null; // 数値の許容帯(confidence-widened outer)。categorical/skipped は null
  innerBand: Band | null; // 広げる前の帯(監査用。categorical/skipped は null)
  confidence: number; // 参照 section の confidence(帯幅と severity の根拠)
  severity: Severity; // 常に warn|info(fail は無い)
  message: string; // 日本語の人間可読
}

export interface StyleCheckReport {
  schemaVersion: number;
  profileName: string;
  provenance: string; // reference profile の provenance(監査可視化)
  findings: StyleFinding[];
  counts: { warn: number; info: number; skipped: number };
}

/* ======================================================================
 * §2.3.2 module 定数(閾値。config 化せず module 定数=SD-T0 前例に倣う)
 * ==================================================================== */

/** confidence で outer band を広げる傾き。widen(conf)=1+(1-conf)*SLOPE */
const BAND_WIDEN_SLOPE = 2.0;
/** relative metric の基準相対トレランス(±30%) */
const BAND_REL_TOL = 0.3;
/** カテゴリ/boolean 不一致を warn に上げる confidence 下限。未満は info */
const CATEGORICAL_TRUST_CONF = 0.35;
/** relative モードで expected がこの絶対値未満なら「0 基準では相対距離を測れない」
 *  として skipped へ落とす(hw=|expected|*tol が 0 に退化し帯が点になる縮退を防ぐ) */
const RELATIVE_ZERO_EPS = 1e-6;

/** metric ごとの帯モードと基準トレランス。ここが「算出式」の唯一の出所 */
type ToleranceMode = "relative" | "absolute" | "learned-percentile";
interface MetricSpec {
  section: CheckSection;
  metric: string;
  mode: ToleranceMode;
  tol: number; // relative=比率 / absolute=同単位の幅 / learned-percentile=fallback 用の相対比率
}
const NUMERIC_SPECS: MetricSpec[] = [
  // cut(ペース): 学習 p10/p90 帯。p10/p90 が null なら avgShotSec±30% にフォールバック
  { section: "cutDensity", metric: "avgShotSec", mode: "learned-percentile", tol: BAND_REL_TOL },
  { section: "cutDensity", metric: "medianShotSec", mode: "learned-percentile", tol: BAND_REL_TOL },
  { section: "cutDensity", metric: "sceneChangesPerMin", mode: "relative", tol: BAND_REL_TOL },
  // caption: 比率は絶対幅(0..1 に相対%を掛けると小値で潰れる)、表示秒は相対
  { section: "captions", metric: "coverageRatio", mode: "absolute", tol: 0.15 },
  { section: "captions", metric: "avgDisplaySec", mode: "relative", tol: BAND_REL_TOL },
  // audio: dB 系は絶対幅(log 尺に相対%は不適)、silenceRatio は絶対
  { section: "audio", metric: "integratedLufs", mode: "absolute", tol: 3.0 },
  { section: "audio", metric: "truePeakDbtp", mode: "absolute", tol: 3.0 },
  { section: "audio", metric: "silenceRatio", mode: "absolute", tol: 0.1 },
];

/** カテゴリ/boolean metric(ラベル一致で判定) */
interface CategoricalSpec {
  section: CheckSection;
  metric: string;
}
const CATEGORICAL_SPECS: CategoricalSpec[] = [
  { section: "cutDensity", metric: "cutAggressiveness" },
  { section: "captions", metric: "density" },
  { section: "captions", metric: "positionHint" },
  { section: "audio", metric: "bgmLikely" },
];

/* ======================================================================
 * §2.3.3 帯とトレランスの算出式
 * ==================================================================== */

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** confidence が低いほど帯を広げる倍率(>=1)。widen(1)=1, widen(0)=1+SLOPE */
export function widen(confidence: number): number {
  return 1 + (1 - clamp01(confidence)) * BAND_WIDEN_SLOPE;
}

/** inner(広げる前)と outer(confidence 広げ後)の帯を返す。
 *  expected が null なら {inner:null, outer:null}(→ skipped)。
 *  relative モードで |expected| が RELATIVE_ZERO_EPS 未満のときも
 *  {inner:null, outer:null}(0 基準では相対距離を測れない→ skipped。
 *  hw=|expected|*tol が 0 に退化し帯が点になる縮退を避ける) */
export function numericBands(args: {
  expected: number | null;
  spec: MetricSpec;
  confidence: number;
  pctLo: number | null; // learned-percentile 用(reference.shotSecP10)
  pctHi: number | null; // 同 shotSecP90
}): { inner: Band | null; outer: Band | null } {
  const { expected, spec, confidence, pctLo, pctHi } = args;
  if (expected === null) return { inner: null, outer: null };
  if (spec.mode === "relative" && Math.abs(expected) < RELATIVE_ZERO_EPS) {
    return { inner: null, outer: null };
  }
  const w = widen(confidence);

  if (spec.mode === "learned-percentile" && pctLo !== null && pctHi !== null) {
    const inner: Band = { lo: pctLo, hi: pctHi };
    // 学習分散(p90-p10)由来の広げ。ただし p10===p90 の退化帯(単一 keep・均一尺の
    // 収録で cold-start に plausible)だと 0 に退化し、confidence(w)をいくら上げても
    // outer===inner の「点帯」になる→ borderline が到達不能で過剰 warn(設計 §4.1)。
    // expected の相対トレランス由来のフロアマージンと max を取ることで、退化帯でも
    // confidence で outer が広がるようにする(正常帯では spreadMargin が支配的なので
    // 挙動は不変。2026-07-02 実測: spreadMargin≈5.70 > floorMargin≈1.18)
    const spreadMargin = (pctHi - pctLo) * (w - 1) * 0.5; // 幅の (w-1) 半分を左右へ
    const floorMargin = Math.abs(expected) * spec.tol * (w - 1) * 0.5;
    const margin = Math.max(spreadMargin, floorMargin);
    const outer: Band = { lo: pctLo - margin, hi: pctHi + margin };
    return { inner, outer };
  }
  // relative / absolute /(percentile だが p10/p90 欠落)の共通式
  const hw =
    spec.mode === "relative"
      ? Math.abs(expected) * spec.tol // 相対
      : spec.mode === "absolute"
        ? spec.tol // 絶対(同単位)
        : Math.abs(expected) * spec.tol; // percentile fallback = 相対
  const inner: Band = { lo: expected - hw, hi: expected + hw };
  const outer: Band = { lo: expected - hw * w, hi: expected + hw * w };
  return { inner, outer };
}

/** 数値1件の判定(observed/inner/outer は非 null。null 扱いは呼び出し側=
 *  compareProfiles が skipped として先に処理する)。confidence は帯計算に
 *  既に織り込み済みのため、ここでは境界比較にのみ使う(将来の拡張点として
 *  シグネチャに残す)。inner 内側=finding なし(null)・inner外/outer内=
 *  borderline・outer外=deviation */
export function classifyNumeric(
  observed: number,
  inner: Band,
  outer: Band,
  // 帯は numericBands で既に confidence 込みなので判定自体には使わない
  // (severity floor を数値に設けない=§2.3.3 確定形)。シグネチャは設計書
  // §2.3.4 の呼び出し規約(confidence を渡す4引数)に合わせて残す
  confidence: number,
): FindingKind | null {
  if (observed >= inner.lo && observed <= inner.hi) return null;
  if (observed >= outer.lo && observed <= outer.hi) return "borderline";
  return "deviation";
}

/** カテゴリ/boolean1件の判定。一致 or どちらかが "mixed" は null(finding なし)。
 *  不一致は参照 confidence が CATEGORICAL_TRUST_CONF 以上なら warn、未満なら info */
export function classifyCategorical(
  observed: string,
  expected: string,
  confidence: number,
): "warn" | "info" | null {
  if (observed === expected) return null;
  if (observed === "mixed" || expected === "mixed") return null;
  return confidence >= CATEGORICAL_TRUST_CONF ? "warn" : "info";
}

/* ======================================================================
 * §2.3.4 距離計算のトップ関数
 * ==================================================================== */

function sectionOf(profile: StyleProfile, section: CheckSection): CutDensity | CaptionsProfile | AudioProfile {
  if (section === "cutDensity") return profile.cutDensity;
  if (section === "captions") return profile.captions;
  return profile.audio;
}

function confidenceOf(profile: StyleProfile, section: CheckSection): number {
  return sectionOf(profile, section).meta.confidence;
}

function numericValueOf(profile: StyleProfile, section: CheckSection, metric: string): number | null {
  const raw = (sectionOf(profile, section) as unknown as Record<string, unknown>)[metric];
  return typeof raw === "number" ? raw : null;
}

function categoricalValueOf(profile: StyleProfile, section: CheckSection, metric: string): string | null {
  const raw = (sectionOf(profile, section) as unknown as Record<string, unknown>)[metric];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "string") return raw;
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtNum(n: number): string {
  return String(round2(n));
}

function fmtBand(b: Band): string {
  return `[${fmtNum(b.lo)}, ${fmtNum(b.hi)}]`;
}

/** section=="audio" のときだけ「先に av」を添える(母艦 §6.3 カバレッジ併記の
 *  精神。av.probe 欠落時に「静かだから測れなかった」と「実際に一致している」を
 *  混同させない) */
function skippedMessage(section: CheckSection): string {
  if (section === "audio") {
    return "測定値がありません(候補または参照 profile に audio 統計が無いため。先に `av <dir>` を実行してください)";
  }
  return "測定値がありません(候補または参照 profile にこの項目の値がありません)";
}

const RELATIVE_ZERO_SKIP_MESSAGE =
  "参照値がほぼ0のため相対距離を0基準では測れません(このmetricはrelativeトレランスのため skip)";

function numericMessage(kind: FindingKind, observed: number, expected: number, inner: Band, outer: Band, confidence: number): string {
  const band = kind === "deviation" ? outer : inner;
  const bandLabel = kind === "deviation" ? "学習帯(outer)" : "学習帯(inner)";
  const dir = observed > band.hi ? "上回る" : "下回る";
  return `候補の観測値 ${fmtNum(observed)} が${bandLabel} ${fmtBand(band)} を${dir}(参照 ${fmtNum(expected)}, conf ${confidence})`;
}

function categoricalMessage(observed: string, expected: string, confidence: number): string {
  return `ラベル不一致: 参照=${expected} / 候補=${observed}(参照 confidence ${confidence})`;
}

/** reference(profile)と candidate(mergeObservations で畳んだ候補 StyleProfile)を
 *  section ごとに突き合わせ、逸脱 finding を返す。IO ゼロ・決定論。
 *  reference の各 section.meta.confidence が帯幅と severity の根拠 */
export function compareProfiles(reference: StyleProfile, candidate: StyleProfile): StyleFinding[] {
  const findings: StyleFinding[] = [];

  for (const spec of NUMERIC_SPECS) {
    const expected = numericValueOf(reference, spec.section, spec.metric);
    const observed = numericValueOf(candidate, spec.section, spec.metric);
    const confidence = confidenceOf(reference, spec.section);

    if (observed === null || expected === null) {
      findings.push({
        kind: "skipped",
        section: spec.section,
        metric: spec.metric,
        observed,
        expected,
        band: null,
        innerBand: null,
        confidence,
        severity: "info",
        message: skippedMessage(spec.section),
      });
      continue;
    }

    const pctLo = spec.mode === "learned-percentile" ? numericValueOf(reference, "cutDensity", "shotSecP10") : null;
    const pctHi = spec.mode === "learned-percentile" ? numericValueOf(reference, "cutDensity", "shotSecP90") : null;
    const { inner, outer } = numericBands({ expected, spec, confidence, pctLo, pctHi });

    if (inner === null || outer === null) {
      // expected は非 null と確認済みなので、ここに来るのは RELATIVE_ZERO_EPS ガードのケースのみ
      findings.push({
        kind: "skipped",
        section: spec.section,
        metric: spec.metric,
        observed,
        expected,
        band: null,
        innerBand: null,
        confidence,
        severity: "info",
        message: RELATIVE_ZERO_SKIP_MESSAGE,
      });
      continue;
    }

    const kind = classifyNumeric(observed, inner, outer, confidence);
    if (kind === null) continue; // inner 帯内 = finding なし

    findings.push({
      kind,
      section: spec.section,
      metric: spec.metric,
      observed,
      expected,
      band: outer,
      innerBand: inner,
      confidence,
      severity: kind === "deviation" ? "warn" : "info",
      message: numericMessage(kind, observed, expected, inner, outer, confidence),
    });
  }

  for (const spec of CATEGORICAL_SPECS) {
    const expected = categoricalValueOf(reference, spec.section, spec.metric);
    const observed = categoricalValueOf(candidate, spec.section, spec.metric);
    const confidence = confidenceOf(reference, spec.section);

    if (observed === null || expected === null) {
      findings.push({
        kind: "skipped",
        section: spec.section,
        metric: spec.metric,
        observed,
        expected,
        band: null,
        innerBand: null,
        confidence,
        severity: "info",
        message: skippedMessage(spec.section),
      });
      continue;
    }

    const severity = classifyCategorical(observed, expected, confidence);
    if (severity === null) continue; // 一致 or mixed 吸収 = finding なし

    findings.push({
      kind: "mismatch",
      section: spec.section,
      metric: spec.metric,
      observed,
      expected,
      band: null,
      innerBand: null,
      confidence,
      severity,
      message: categoricalMessage(observed, expected, confidence),
    });
  }

  return findings;
}

/** findings → counts 集計(orchestrator が report に載せる)。skipped は
 *  severity に関わらず counts.skipped だけへ計上する(warn/info との二重計上を避ける) */
export function summarizeFindings(findings: StyleFinding[]): StyleCheckReport["counts"] {
  const counts = { warn: 0, info: 0, skipped: 0 };
  for (const f of findings) {
    if (f.kind === "skipped") {
      counts.skipped++;
    } else if (f.severity === "warn") {
      counts.warn++;
    } else {
      counts.info++;
    }
  }
  return counts;
}
