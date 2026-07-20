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

/** enabled=false(既定)のとき "" を返す(バイト等価の核)。true のときは
 * `## 出力形式` 節の**末尾**に足す差分ブロック(§穴C・P3-2)。既存の JSON 例
 * (`{ "cuts": [...] }`)は1バイトも書き換えず、その後ろに reasonId 付きの例と
 * keeps 配列の例を追加する。LLM が最後に見る具体例をこちらへ寄せることで、
 * renderReasonIdsBlock の指示と `## 出力形式` の旧 JSON 例の矛盾(穴C)を解く。 */
export function renderReasonIdsOutputBlock(enabled: boolean): string {
  if (!enabled) return "";
  const lines: string[] = [
    "`reasonId` を付ける場合はこの形になります(上の例の代わりにこちらを使ってください):",
    "",
    "```json",
    "{",
    '  "cuts": [',
    '    { "id": 3, "reasonId": "restatement", "reason": "同じ説明の言い直し(前半)" },',
    '    { "id": 12, "reasonId": "gap-trim", "reason": "発話間の呼吸" }',
    "  ],",
    '  "keeps": [',
    '    { "id": 40, "reasonId": "demo-wait", "reason": "コマンド実行の結果待ち。画面が変化している" }',
    "  ]",
    "}",
    "```",
    "",
    "- keeps: 「残す(keeps に書くもの)」に該当する区間だけを列挙(無ければ配列ごと省略可)",
  ];
  return `\n${lines.join("\n")}`;
}
