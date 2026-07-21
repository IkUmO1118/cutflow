// 演出判断の「収録タイプ」による選択注入。
// pattern id は収録の性質なので cut と共有し、演出用の別 id 集合は作らない。
// 注入する effect recipe / note / blueprint だけを演出トラック固有に持つ。

import { CUT_PATTERN_IDS } from "./cutPatterns.ts";
import type { CutPatternId } from "./cutPatterns.ts";
import { EFFECT_REASON_IDS } from "./effectReasonIds.ts";
import type { EffectReasonId } from "./effectReasonIds.ts";

export { CUT_PATTERN_IDS };
export type { CutPatternId };

export interface EffectPatternInjection {
  /** patterns.md の見出しと一致する表示名。 */
  patternName: string;
  /** 注入する effect recipe。表示順は EFFECT_REASON_IDS へ正規化する。 */
  recipes: readonly EffectReasonId[];
  /** blueprints.md の共有見出し。"" は演出 blueprint 注入なし。 */
  blueprint: string;
  /** この収録タイプで特に外しやすい点。"" は注入なし。 */
  note: string;
}

/**
 * 共有アークを演出判断として読むための短いブロック。
 * cut の BLUEPRINT_BLOCKS と同じ id を参照するが、優勢な演出だけを記す。
 */
export const EFFECT_BLUEPRINT_BLOCKS: Record<string, readonly string[]> = {
  "tool-demo-arc": [
    "## この収録の演出の流れ(tool-demo-arc)",
    "アンカーがこの流れのどこにあるかも判断材料にしてください(目安。厳密な境界ではありません):",
    "- フック(冒頭 ~10%): concept-talk を既定とし、演出は置かない",
    "- 概要(~15%): already-legible / concept-talk を優先する",
    "- 実演(~50%): tiny-target / focus-shift の zoom が集中する。秘匿は必ず blur",
    "- 設計・裏側(~20%): motion-carries を優先し、必要な対象だけ zoom / annotation",
    "- おわりに(末尾 ~5%): concept-talk を既定とし、演出は置かない",
  ],
};

export const EFFECT_PATTERN_INJECTION: Record<CutPatternId, EffectPatternInjection> = {
  general: {
    patternName: "汎用(収録タイプを宣言しない)",
    // EP2 の全7分類注入とバイト等価にする。
    recipes: EFFECT_REASON_IDS,
    blueprint: "",
    note: "",
  },
  "tool-demo": {
    patternName: "ツール紹介・デモ",
    // 初版は secret-exposure の安全閉包と2組のG2対比を崩さないため全7分類。
    recipes: EFFECT_REASON_IDS,
    blueprint: "tool-demo-arc",
    note: "この収録は画面が主役です。演出は実演区間の読解補助に絞り、秘匿情報は区間に関わらず blur を優先してください。",
  },
};
