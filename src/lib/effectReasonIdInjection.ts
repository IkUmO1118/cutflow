// plan-effects 用 effectReasonId 注入。IO/LLMに依存しない決定論の文字列生成。
// enabled=false は必ず空文字を返し、既存プロンプトを1バイトも変えない。

import {
  EFFECT_REASON_IDS,
  EFFECT_REASON_ID_DISCRIMINATOR,
  EFFECT_REASON_ID_FAMILY,
  EFFECT_REASON_ID_LABEL,
} from "./effectReasonIds.ts";
import type { EffectReasonFamily, EffectReasonId } from "./effectReasonIds.ts";
import { EFFECT_BLUEPRINT_BLOCKS, EFFECT_PATTERN_INJECTION } from "./effectPatterns.ts";
import type { CutPatternId } from "./effectPatterns.ts";

function linesOf(recipeSet: ReadonlySet<EffectReasonId>, family: EffectReasonFamily): string[] {
  return EFFECT_REASON_IDS
    .filter((id) => recipeSet.has(id) && EFFECT_REASON_ID_FAMILY[id] === family)
    .map((id) => `- ${id} — ${EFFECT_REASON_ID_LABEL[id]}`);
}

/** recipe 集合に両側がある G2 対比だけを返す。 */
export function effectReasonIdDiscriminatorLines(recipes: readonly EffectReasonId[]): string[] {
  const recipeSet = new Set(recipes);
  return EFFECT_REASON_ID_DISCRIMINATOR
    .filter(({ a, b }) => recipeSet.has(a) && recipeSet.has(b))
    .map(({ a, b, discriminator }) => `- ${a} ↔ ${b} — ${discriminator}`);
}

function familySection(recipeSet: ReadonlySet<EffectReasonId>, family: EffectReasonFamily, heading: string): string[] {
  const lines = linesOf(recipeSet, family);
  return lines.length > 0 ? [heading, ...lines, ""] : [];
}

export function renderEffectReasonIdsBlock(enabled: boolean, pattern: CutPatternId = "general"): string {
  if (!enabled) return "";
  const injection = EFFECT_PATTERN_INJECTION[pattern] ?? EFFECT_PATTERN_INJECTION.general;
  const recipeSet = new Set<EffectReasonId>(injection.recipes);
  const discriminatorLines = effectReasonIdDiscriminatorLines(injection.recipes);
  const lines = [
    ...(injection.note ? [injection.note, ""] : []),
    "## 演出判断の分類(effectReasonId)",
    "",
    "各 decision に、次の一覧から **idを1つだけ**選んで `effectReasonId` に書いてください。",
    "一覧に無いidを発明しないでください。座標・時刻・色は従来どおり書きません。",
    "",
    ...familySection(recipeSet, "zoom", "### 見せる(zoom)"),
    ...familySection(recipeSet, "blur", "### 隠す(blur)"),
    ...familySection(recipeSet, "annotation", "### 指す(annotation)"),
    ...familySection(recipeSet, "none", "### 何もしない(none)"),
    ...(discriminatorLines.length > 0 ? ["### 紛らわしい境目", ...discriminatorLines, ""] : []),
    ...(recipeSet.has("secret-exposure")
      ? ["秘匿情報か判断できない場合は、公開後に回復できないため blur(secret-exposure) 側へ倒してください。"]
      : []),
    ...(linesOf(recipeSet, "none").length > 0
      ? [
          "`none` も『演出を検討したが置かなかった』判断として列挙してください。",
          "ただし none は `max(12, ceil(アンカー数の10%))` 件まで(アンカー総数を上限)とし、超える場合は",
          "演出を置くか特に迷ったものから残してください。",
        ]
      : []),
    ...(injection.blueprint && EFFECT_BLUEPRINT_BLOCKS[injection.blueprint]
      ? ["", ...EFFECT_BLUEPRINT_BLOCKS[injection.blueprint]]
      : []),
  ];
  return `\n${lines.join("\n")}\n`;
}

export function renderEffectReasonIdsOutputBlock(enabled: boolean): string {
  if (!enabled) return "";
  const lines = [
    "`effectReasonId` を含む出力は次の形です(上の出力例の代わりに使ってください):",
    "",
    "```json",
    "{",
    '  "decisions": [',
    '    { "anchorId": 3, "effect": "zoom", "effectReasonId": "tiny-target", "reason": "設定値が小さい" },',
    '    { "anchorId": 8, "effect": "none", "effectReasonId": "already-legible", "reason": "全画面のまま読める" }',
    "  ]",
    "}",
    "```",
    "",
    "- on時は全decisionに `effectReasonId` が必須です",
    "- noneは理由の記録だけで、overlays.json に演出を生成しません",
  ];
  return `\n${lines.join("\n")}\n`;
}
