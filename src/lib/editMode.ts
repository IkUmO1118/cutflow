/** カット判断の積極度(X4)。§docs/plans/2026-07-11-x4-editing-aggressiveness-design.md */
export type EditMode = "safe" | "balanced" | "aggressive";

export const DEFAULT_EDIT_MODE: EditMode = "balanced";

/** safe は現状 3 テンプレの当該行と完全一致でなければならない(バイト等価の逃げ道)。
 *  実装時はテンプレの既存行をコピーすること(手打ち禁止)。 */
const MODE_LINE: Record<EditMode, string> = {
  safe: "- 迷ったら残す。過剰カットより冗長の方がまし(人間が後から調整できる)",
  balanced:
    "- 明確な冗長・言い直し・脱線は積極的に切ってテンポを作る。見せ場と説明の要点は必ず残す。判断がつかない中間的な区間は残す",
  aggressive:
    "- 冗長・重複・長い沈黙・脱線はためらわず切る。テンポを最優先。見せ場(上の見せ場リスト)だけは必ず残し、それ以外は「残す理由があるか」で判断する",
};

const MODE_VALUES: readonly string[] = ["safe", "balanced", "aggressive"];

/** 文字列を EditMode に正規化。未知値は null(呼び出し側でフォールバック)。 */
export function asEditMode(v: unknown): EditMode | null {
  return typeof v === "string" && MODE_VALUES.includes(v) ? (v as EditMode) : null;
}

/** rules / brief 本文からモード指定マーカーを1つ拾う純関数。
 *  受理する行の形(前後空白可): 「編集モード: aggressive」「edit-mode: safe」等。
 *  複数あれば最後の一致を採用(rules ブロックは収録固有が後ろ=自然に優先される)。
 *  無ければ null。 */
export function editModeMarker(text: string): EditMode | null {
  const re = /(?:編集モード|edit[-_ ]?mode)\s*[:：]\s*(safe|balanced|aggressive)/gi;
  let mode: EditMode | null = null;
  for (const m of text.matchAll(re)) mode = m[1].toLowerCase() as EditMode;
  return mode;
}

/** 優先順位: brief マーカー > rules マーカー > config.plan.editMode > 既定(balanced)。
 *  未知の config 値は warn して既定へ。 */
export function resolveEditMode(args: {
  configMode: unknown; // config.plan.editMode(未設定なら undefined)
  rules: string; // renderPrompt が持つ rules ブロック(channel+収録連結)
  brief: string; // brief.md 本文(無ければ既定メッセージ)
  warn?: (msg: string) => void;
}): EditMode {
  const fromBrief = editModeMarker(args.brief);
  if (fromBrief) return fromBrief;
  const fromRules = editModeMarker(args.rules);
  if (fromRules) return fromRules;
  if (args.configMode === undefined || args.configMode === null) return DEFAULT_EDIT_MODE;
  const cfg = asEditMode(args.configMode);
  if (cfg) return cfg;
  args.warn?.(
    `plan.editMode の値 "${String(args.configMode)}" は未対応です(safe/balanced/aggressive)。balanced を使います`,
  );
  return DEFAULT_EDIT_MODE;
}

/** {{editMode}} の展開文字列を作る。目標尺があればモード行の直後に1行足す。 */
export function renderEditModeBlock(
  mode: EditMode,
  targetOutDurationSec: number | null,
): string {
  const lines = [MODE_LINE[mode]];
  if (targetOutDurationSec !== null) {
    lines.push(
      `- 目標の出力尺は約 ${targetOutDurationSec.toFixed(0)} 秒。冗長を削ってこの尺に近づける(見せ場は優先して残す)`,
    );
  }
  return lines.join("\n");
}
