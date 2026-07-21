// plan-effects 用 effectReasonId 注入。IO/LLMに依存しない決定論の文字列生成。
// enabled=false は必ず空文字を返し、既存プロンプトを1バイトも変えない。

import {
  EFFECT_REASON_IDS,
  EFFECT_REASON_ID_DISCRIMINATOR,
  EFFECT_REASON_ID_FAMILY,
  EFFECT_REASON_ID_LABEL,
} from "./effectReasonIds.ts";
import type { EffectReasonFamily } from "./effectReasonIds.ts";

function linesOf(family: EffectReasonFamily): string[] {
  return EFFECT_REASON_IDS
    .filter((id) => EFFECT_REASON_ID_FAMILY[id] === family)
    .map((id) => `- ${id} — ${EFFECT_REASON_ID_LABEL[id]}`);
}

export function renderEffectReasonIdsBlock(enabled: boolean): string {
  if (!enabled) return "";
  const lines = [
    "## 演出判断の分類(effectReasonId)",
    "",
    "各 decision に、次の一覧から **idを1つだけ**選んで `effectReasonId` に書いてください。",
    "一覧に無いidを発明しないでください。座標・時刻・色は従来どおり書きません。",
    "",
    "### 見せる(zoom)",
    ...linesOf("zoom"),
    "",
    "### 隠す(blur)",
    ...linesOf("blur"),
    "",
    "### 指す(annotation)",
    ...linesOf("annotation"),
    "",
    "### 何もしない(none)",
    ...linesOf("none"),
    "",
    "### 紛らわしい境目",
    ...EFFECT_REASON_ID_DISCRIMINATOR.map(
      ({ a, b, discriminator }) => `- ${a} ↔ ${b} — ${discriminator}`,
    ),
    "",
    "秘匿情報か判断できない場合は、公開後に回復できないため blur(secret-exposure) 側へ倒してください。",
    "`none` も『演出を検討したが置かなかった』判断として列挙してください。",
    "ただし none は `max(12, ceil(アンカー数の10%))` 件まで(アンカー総数を上限)とし、超える場合は",
    "演出を置くか特に迷ったものから残してください。",
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
