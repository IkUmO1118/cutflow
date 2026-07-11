// lib/styleInjection.ts — SD-T4: style profile(SD-T0)→ compact style policy を
// plan(カット判断LLM)の prompt へ soft prior として整形する純関数群。
// §docs/plans/2026-07-12-sd-t4-style-injection-design.md
//
// IO/fs/LLM には一切依存しない(決定論)。`StyleProfile` は import type だけで
// 取り込む(profile の読込=fs は stages/plan.ts 側の責務。lib→stage の循環を
// 避けるため。styleInjection.ts は stage を一切 import しない)。
//
// v1 は cut/caption/structure の3面だけを surface する(audio・segments は
// 載せない。§2.5.2)。番号選択方式は不変(profile はソフトな prior であって、
// LLM に精密な数値・タイムスタンプを生成させない。§1.2)。

import type { CaptionsProfile, CutDensity, StyleProfile } from "./styleProfile.ts";

/* ======================================================================
 * module 定数(閾値・gloss。§2.5.1)
 * ==================================================================== */

/** confidence → prior 強度の閾値(§10.0 cold-start は 0.25〜0.33 = 弱い prior)。
 *  境界は「以上」側 */
const STYLE_PRIOR_STRONG_CONF = 0.6;
const STYLE_PRIOR_MEDIUM_CONF = 0.4;

/** cutAggressiveness ラベル → 日本語 gloss */
const AGGRESSIVENESS_GLOSS: Record<NonNullable<CutDensity["cutAggressiveness"]>, string> = {
  high: "高(テンポ最優先・短めに)",
  "medium-high": "やや高(冗長は積極的に切る)",
  medium: "標準(明確な冗長を切る)",
  low: "低(ゆったり・切りすぎない)",
};

/** captions.density ラベル → 日本語 gloss */
const DENSITY_GLOSS: Record<NonNullable<CaptionsProfile["density"]>, string> = {
  high: "多め(ほぼ全編に字幕)",
  medium: "中程度",
  low: "少なめ",
};

/** captions.positionHint ラベル → 日本語 gloss */
const POSITION_GLOSS: Record<NonNullable<CaptionsProfile["positionHint"]>, string> = {
  top: "画面上部",
  center: "画面中央",
  bottom: "画面下部",
  mixed: "位置は一定でない",
};

/* ======================================================================
 * compact style policy(中間表現・§2.5.2)
 * ==================================================================== */

export interface StylePolicy {
  provenance: StyleProfile["provenance"];
  cut: {
    targetAvgShotSec: number | null;
    aggressiveness: CutDensity["cutAggressiveness"]; // 既存ラベル
    shotSecP10: number | null; // 学習帯の下側(SD-T1 と同じ帯)
    shotSecP90: number | null; // 学習帯の上側
    confidence: number;
  } | null; // profile.cutDensity が全て null(値が取れない)なら null=行を出さない
  caption: {
    coverageRatio: number | null;
    density: CaptionsProfile["density"];
    positionHint: CaptionsProfile["positionHint"];
    styleNotes: string[];
    confidence: number;
  } | null;
  structure: {
    hookSec: number | null;
    ctaLikely: boolean | null;
    confidence: number;
  } | null;
}

/** StyleProfile → StylePolicy(決定論の抽出。§2.5.4)。値が全く取れない
 *  section は null(=formatStyleProfileBlock がその行を出さない) */
export function buildStylePolicy(profile: StyleProfile): StylePolicy {
  const cd = profile.cutDensity;
  const cut: StylePolicy["cut"] =
    cd.avgShotSec === null && cd.cutAggressiveness === null
      ? null
      : {
          targetAvgShotSec: cd.avgShotSec,
          aggressiveness: cd.cutAggressiveness,
          shotSecP10: cd.shotSecP10,
          shotSecP90: cd.shotSecP90,
          confidence: cd.meta.confidence,
        };

  const cap = profile.captions;
  const caption: StylePolicy["caption"] =
    cap.coverageRatio === null &&
    cap.density === null &&
    cap.positionHint === null &&
    cap.styleNotes.length === 0
      ? null
      : {
          coverageRatio: cap.coverageRatio,
          density: cap.density,
          positionHint: cap.positionHint,
          styleNotes: cap.styleNotes,
          confidence: cap.meta.confidence,
        };

  const st = profile.structure;
  const structure: StylePolicy["structure"] =
    st.hookSec === null && st.ctaLikely === null
      ? null
      : {
          hookSec: st.hookSec,
          ctaLikely: st.ctaLikely,
          confidence: st.meta.confidence,
        };

  return { provenance: profile.provenance, cut, caption, structure };
}

/* ======================================================================
 * prior 強度文言(§2.5.3)
 * ==================================================================== */

export function priorStrengthLabel(confidence: number): string {
  if (confidence >= STYLE_PRIOR_STRONG_CONF) return "強め";
  if (confidence >= STYLE_PRIOR_MEDIUM_CONF) return "中程度";
  return "弱い(cold-start・参考程度)";
}

/* ======================================================================
 * ブロック整形(§2.5.4)。null 処理は styleProfile.ts の
 * formatStyleProfileReport と同じ思想(値が無ければその部分だけ省く)
 * ==================================================================== */

const fmt1 = (n: number): string => n.toFixed(1);

function joinParts(parts: string[]): string {
  return parts.join(" / ");
}

function formatCutLine(cut: NonNullable<StylePolicy["cut"]>): string {
  const parts: string[] = [];
  if (cut.targetAvgShotSec !== null) {
    parts.push(`目標平均ショット長 約${fmt1(cut.targetAvgShotSec)}秒`);
  }
  if (cut.aggressiveness !== null) {
    parts.push(`積極度=${AGGRESSIVENESS_GLOSS[cut.aggressiveness]}`);
  }
  if (cut.shotSecP10 !== null && cut.shotSecP90 !== null) {
    parts.push(`学習帯 約${fmt1(cut.shotSecP10)}〜${fmt1(cut.shotSecP90)}秒`);
  }
  return `- カット: ${joinParts(parts)} [prior:${priorStrengthLabel(cut.confidence)}]`;
}

function formatCaptionLine(caption: NonNullable<StylePolicy["caption"]>): string {
  const parts: string[] = [];
  if (caption.coverageRatio !== null) {
    parts.push(`カバレッジ約${Math.round(caption.coverageRatio * 100)}%`);
  }
  if (caption.density !== null) {
    parts.push(`密度=${DENSITY_GLOSS[caption.density]}`);
  }
  if (caption.positionHint !== null) {
    parts.push(`位置=${POSITION_GLOSS[caption.positionHint]}`);
  }
  if (caption.styleNotes.length > 0) {
    parts.push(`強調: ${caption.styleNotes.join(", ")}`);
  }
  return `- 字幕: ${joinParts(parts)} [prior:${priorStrengthLabel(caption.confidence)}]`;
}

function formatStructureLine(structure: NonNullable<StylePolicy["structure"]>): string {
  const parts: string[] = [];
  if (structure.hookSec !== null) {
    parts.push(`冒頭フック約${fmt1(structure.hookSec)}秒`);
  }
  if (structure.ctaLikely !== null) {
    parts.push(structure.ctaLikely ? "末尾にCTAあり" : "末尾CTAなし");
  }
  return `- 構成: ${joinParts(parts)} [prior:${priorStrengthLabel(structure.confidence)}]`;
}

/** compact style policy を人間可読の日本語ブロックへ整形する(前後の \n は
 *  付けない。それは呼び出し側の renderStyleProfileBlock の責務・§2.5.5)。
 *  少なくとも1つの section が非 null であることは呼び出し側が保証する */
export function formatStyleProfileBlock(policy: StylePolicy): string {
  const parts: string[] = [
    "## スタイル方針(候補選択のソフトな prior)",
    "※ これは brief.md(今回の意図)に劣後する参考情報です。番号選択の重み付けにだけ使い、" +
      "精密な数値やタイムスタンプは生成しないでください。brief と矛盾する場合は brief を優先。",
  ];
  if (policy.cut) parts.push(formatCutLine(policy.cut));
  if (policy.caption) parts.push(formatCaptionLine(policy.caption));
  if (policy.structure) parts.push(formatStructureLine(policy.structure));
  return parts.join("\n");
}

/* ======================================================================
 * トップ関数(バイト等価の核。§2.5.5)
 * ==================================================================== */

/** enabled=false または profile===null のとき "" を返す(バイト等価の核。
 *  renderPerceptionBlock と完全に同じ契約: "" か、前後 \n を伴う1ブロック)。
 *  それ以外は buildStylePolicy → formatStyleProfileBlock。全 section が null に
 *  畳まれた(値が何も取れない profile)ときも "" を返す(空ブロックを出さない)。 */
export function renderStyleProfileBlock(profile: StyleProfile | null, enabled: boolean): string {
  if (!enabled || profile === null) return "";
  const policy = buildStylePolicy(profile);
  if (policy.cut === null && policy.caption === null && policy.structure === null) return "";
  return `\n${formatStyleProfileBlock(policy)}\n`;
}
