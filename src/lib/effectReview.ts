// E6(レビューイベント化)+ E7(検品観点を提案ループへ戻す)の純関数。
// §docs/plans/2026-07-11-e6-e7-effect-review-loop-design.md
//
// SD-E2(src/lib/effectCheck.ts)が出す EffectWarning[] を、
// (a) 既存 ReviewEvent(src/lib/reviewEvents.ts)へ載せる材料(EffectReviewPatch)
// (b) planLoop / plan-effects --observe が読む観測テキスト
// へ写像する。fs/LLM/VLM には一切依存しない純関数のみ。
//
// 設計書 §3-A の pseudocode から1点だけ意図的に変えている: EffectReviewPatch
// への写像は warning.kind だけでなく message のプレフィックス(`blur(` /
// `annotation(` / `VLM(zoom` 等)も見て対象の演出種別(zoom/blur/annotation)を
// 決める。"density"(演出密度の窓全体への警告)と "caption-overlap" のうち
// 相手が素材(overlays[])のものは、特定の演出1件に帰属しない警告のため
// bucket が定まらず、ReviewEvent への merge 対象にはしない(=patch を作らない)。
// ただし effectWarningsToObservation の件数サマリには引き続き含める
// (観測は「気づきを次へ渡す」ことが目的で、bucket 化できるかとは別軸のため)。
import type { EffectWarning } from "./effectCheck.ts";

export type EffectReviewBucket = "zoom" | "blur" | "annotation";

/** effect-check の警告1件を、該当 ReviewEvent(zoom/blur/annotation)へ
 *  追記する材料に変換した結果。reviewEvents.ts の merge 処理が消費する */
export interface EffectReviewPatch {
  kind: EffectReviewBucket;
  startSec: number;
  endSec: number;
  /** event.warnings へ push する文言(常に1件) */
  warnings: string[];
  /** event.checkPoints へ push する種別定型文(常に1件) */
  checkPoints: string[];
  /** event.reviewFrameReasons へ push する撮影/確認理由(常に1件) */
  reviewFrameReasons: string[];
  /** SD-E2 の補正下書き(effect-fix.suggested.json)内の対応箇所を指す参照。
   *  warning.suggestions が非空のときだけ立つ。**自動適用はしない**
   *  (apply --patch を人間が実行する経路を指すだけ) */
  fixRef?: string;
}

/** SD-E2(stages/effectCheck.ts)の EFFECT_FIX_PATCH_FILE と同じ名前
 *  (lib からステージ定数を import する依存を避けるためリテラルを複製。
 *  ずれた場合は test/effectReview.test.ts が検出する) */
const EFFECT_FIX_SUGGESTED_FILE = "effect-fix.suggested.json";

const CHECK_POINT_TEMPLATES: Record<EffectReviewBucket, string> = {
  zoom: "見せたい所が中心か",
  blur: "覆えているか",
  annotation: "指す先が合うか",
};

const WARNING_KIND_LABELS: Record<EffectWarning["kind"], string> = {
  "annotation-zoom-overlap": "注釈×ズーム重なり",
  "blur-zoom-overlap": "ぼかし×ズーム重なり",
  density: "密度過多",
  "annotation-too-long": "注釈表示尺超過",
  "caption-overlap": "字幕重なり",
  "vlm-mismatch": "VLM不一致",
};

/** warning からどの ReviewEvent 種別(zoom/blur/annotation)へ載せるべきかを
 *  決める。特定の演出1件に帰属しない警告(density・caption-overlap で相手が
 *  素材)は null(=どの ReviewEvent にも merge しない) */
function bucketOf(warning: EffectWarning): EffectReviewBucket | null {
  switch (warning.kind) {
    case "blur-zoom-overlap":
      return "blur";
    case "annotation-zoom-overlap":
    case "annotation-too-long":
      return "annotation";
    case "vlm-mismatch": {
      const m = warning.message.match(/^VLM\((zoom|blur|annotation)/);
      return m ? (m[1] as EffectReviewBucket) : null;
    }
    case "caption-overlap":
      if (warning.message.includes("blur(")) return "blur";
      if (warning.message.includes("annotation(")) return "annotation";
      return null; // 相手が素材(overlays[])のときは zoom/blur/annotation のどれでもない
    case "density":
      return null; // 窓全体への警告で特定の演出1件に帰属しない
    default:
      return null;
  }
}

/** effect-check の警告を、種別ごとの ReviewEvent 追記材料へ変換する純関数。
 *  bucket が定まらない警告(density・素材相手の caption-overlap)は
 *  patch を作らない(=ReviewEvent へは載らないが、observation には残る) */
export function effectWarningsToReviewPatches(warnings: EffectWarning[]): EffectReviewPatch[] {
  const patches: EffectReviewPatch[] = [];
  for (const warning of warnings) {
    const kind = bucketOf(warning);
    if (kind === null) continue;
    const hasSuggestions = (warning.suggestions?.length ?? 0) > 0;
    patches.push({
      kind,
      startSec: warning.startSec,
      endSec: warning.endSec,
      warnings: [warning.message],
      checkPoints: [CHECK_POINT_TEMPLATES[kind]],
      reviewFrameReasons: [`effect-check: ${warning.kind}`],
      ...(hasSuggestions
        ? { fixRef: `${EFFECT_FIX_SUGGESTED_FILE}#@${warning.refId ?? "?"}` }
        : {}),
    });
  }
  return patches;
}

/** E7 観測: 演出警告を planLoop / plan-effects --observe が読む観測テキストへ
 *  整形する純関数。**参考情報であって命令ではない**(必ず直せとは書かない)。
 *  警告0件は空文字を返す(=呼び出し側が opt-in でも off でもバイト等価になる) */
export function effectWarningsToObservation(warnings: EffectWarning[]): string {
  if (warnings.length === 0) return "";
  const counts = new Map<EffectWarning["kind"], number>();
  for (const w of warnings) counts.set(w.kind, (counts.get(w.kind) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${WARNING_KIND_LABELS[kind]}${count}件`)
    .join("・");
  return (
    `前回の effect-check で演出の警告が${warnings.length}件ありました(${breakdown})。\n` +
    "これは参考情報であり、必ず直すべき指示ではありません。番号選択の判断材料として踏まえてください。"
  );
}
