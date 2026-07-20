// カット判断の「収録タイプ」による選択注入(§docs/plans/2026-07-20-cut-knowledge-p3-p5-design.md
// §1/§2)。src/lib/reasonIds.ts(CUT_REASON_IDS。13分類の単一の出所)と同じ
// 「分類の単一の出所」層にある固定マップ。HyperFrames の
// HYPERFRAME_PATTERN_INJECTION と同型だが、「選ぶ主体」は LLM ではなく人間
// (config.yaml の plan.reasonIds.pattern)。
//
// IO/fs/LLM には一切依存しない(決定論)。このモジュール自体は
// lib/reasonIdInjection.ts の renderReasonIdsBlock からだけ参照される。

import { CUT_REASON_IDS } from "./reasonIds.ts";
import type { CutReasonId } from "./reasonIds.ts";

/** 収録タイプ1件の注入定義。 */
export interface CutPatternInjection {
  /** patterns.md の見出しと一致する表示名 */
  patternName: string;
  /** 注入する分類の集合。掲載順は問わない(レンダー時に CUT_REASON_IDS の
   *  掲載順へ正規化して使う。§2.2 却下案) */
  recipes: readonly CutReasonId[];
  /** docs/edit-skills/blueprints.md の見出し(P4)。""=blueprint 注入なし */
  blueprint: string;
  /** 注入ブロック冒頭に置く1行の重み付け(この型で特に外しやすい点)。
   *  ""=冒頭行を出さない(= general はここが空でバイト等価の一部を成す) */
  note: string;
}

/** 2エントリで発足(§1)。実在確認が取れた収録タイプだけを載せる(母艦 §4.1・
 *  G4 の原則を config の分岐にも適用)。統廃合前提の型を並べない。 */
export const CUT_PATTERN_IDS = ["general", "tool-demo"] as const;
export type CutPatternId = (typeof CUT_PATTERN_IDS)[number];

export const CUT_PATTERN_INJECTION: Record<CutPatternId, CutPatternInjection> = {
  general: {
    patternName: "汎用(収録タイプを宣言しない)",
    // 13分類全部。P2 とバイト等価にするための唯一の制約(§0.4 判断1)
    recipes: CUT_REASON_IDS,
    blueprint: "",
    note: "",
  },
  "tool-demo": {
    patternName: "ツール紹介・デモ",
    // 11/13分類(§2.2)。tangent(実データ0件)・failure-and-fix(実データ0件・
    // デモ型では支配的でない)を落とす。demo-wait/dead-air は対比ペアとして
    // 必ず両方入れる(この型で最も外す境目)
    recipes: [
      "restatement",
      "stumble",
      "duplicate-tail",
      "gap-trim",
      "dead-air",
      "slate",
      "demo-wait",
      "hook",
      "greeting",
      "tail-clip",
      "reference-orphan",
    ],
    blueprint: "tool-demo-arc",
    note: "この収録は画面が主役です。無言は既定でカットせず、画面が変化しているかで判断してください。",
  },
};
