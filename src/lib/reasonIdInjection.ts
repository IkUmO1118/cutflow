// lib/reasonIdInjection.ts — plan.reasonIds(§4.2)の注入ブロック生成。
// IO/fs/LLM には一切依存しない(決定論。lib/styleInjection.ts と同じ位置づけ)。
// §docs/plans/2026-07-20-cut-knowledge-p1-p2-design.md §6(P2 は13分類を
// 「id + 一行定義 + 系」だけ全注入する。recipe 本文はディスクに残す=読みに行かない)。
//
// 最重要不変条件(I2): enabled=false のとき "" を返す(renderPerceptionBlock /
// renderStyleProfileBlock と同じ契約)。呼び出し側(stages/plan.ts)がこの結果を
// renderPrompt の reasonIds 引数へそのまま渡す。

import { CUT_REASON_IDS, REASON_ID_FAMILY, REASON_ID_LABEL } from "./reasonIds.ts";
import type { CutReasonId } from "./reasonIds.ts";

function idsOfFamily(family: "cut" | "keep" | "boundary"): readonly CutReasonId[] {
  return CUT_REASON_IDS.filter((id) => REASON_ID_FAMILY[id] === family);
}

function idLines(family: "cut" | "keep" | "boundary"): string[] {
  return idsOfFamily(family).map((id) => `- ${id} — ${REASON_ID_LABEL[id]}`);
}

/** enabled=false(既定)のとき "" を返す(バイト等価の核)。true のときは
 * 13分類(id + 一行定義 + 系。切る/残す/境界の見出しで分ける)+ keeps 配列
 * (§5。切る誘惑があったが残した区間だけを列挙させる。上限
 * max(12, 候補数の10%))の書き方を固定の日本語ブロックで返す。
 * 候補数に依存しない固定文字列(上限は数値ではなく式のまま書く=毎回再計算しない)。 */
export function renderReasonIdsBlock(enabled: boolean): string {
  if (!enabled) return "";
  const lines: string[] = [
    "## 判断の分類(reasonId)",
    "",
    "各判断に、次の一覧から **id を1つだけ**選んで `reasonId` に書いてください。",
    "一覧に無い id を発明しないでください。当てはまるものが無いときは",
    "`reasonId` を書かず `reason` だけを書いてください。",
    "",
    "### 切る",
    ...idLines("cut"),
    "",
    "### 残す(keeps に書くもの)",
    ...idLines("keep"),
    "",
    "### 境界",
    ...idLines("boundary"),
    "",
    "## 残す判断の記録(keeps)",
    "",
    "上の「残す(keeps に書くもの)」に挙げた分類が当てはまる区間だけを、",
    "出力の `keeps` 配列に `{ id, reasonId, reason }` で書いてください。",
    "それ以外の keep(特筆すべき理由の無い本編)は書かないでください——",
    "「迷ったら書かない」のではなく、「切ろうか迷ったが残した」区間だけを",
    "書く、という基準です。境界系の判断も keeps に書いて構いません。",
    "上限は `max(12, 候補数の10%)` 件です。超える場合は切る誘惑が強かった順に",
    "絞ってください。",
  ];
  return `\n${lines.join("\n")}\n`;
}
