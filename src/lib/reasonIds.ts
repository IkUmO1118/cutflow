// カット判断の状況分類(docs/edit-skills/recipes/<id>.md)の id 集合の単一の出所。
// src/lib/ids.ts(@id の ID_PREFIX/ID_RE)と同じ「分類の単一の出所」の位置づけで、
// validate / schema / プロンプト注入 / doc 全単射テストはすべてここから派生する。
//
// §docs/plans/2026-07-20-cut-knowledge-p1-p2-design.md §1(分類 id の確定)・§4.1。
//
// opt-in・sticky: `PlanSegment.reasonId` を1つも持たない cutplan.json は
// validate / describe / apply / render が本機能導入前と同一出力(§I1)。
// このモジュール自体は P2-1 の時点ではどのプロダクションコードからも import
// されない(未使用モジュールの追加のみ。挙動変化ゼロ)。

/** 13分類。順序は docs/edit-skills/README.md の「切る(7)/残す(4)/境界(2)」の
 * 掲載順と一致させる(プロンプト注入・doc の並びの単一の出所)。 */
export const CUT_REASON_IDS = [
  // 系: 切る(7)
  "restatement",
  "stumble",
  "duplicate-tail",
  "gap-trim",
  "dead-air",
  "tangent",
  "slate",
  // 系: 残す(4)
  "demo-wait",
  "failure-and-fix",
  "hook",
  "greeting",
  // 系: 境界(2)
  "tail-clip",
  "reference-orphan",
] as const;

export type CutReasonId = (typeof CUT_REASON_IDS)[number];

/** 分類の系。validate の系不整合 warn(§4.3)とプロンプト注入の見出し分け(§6)が
 * ここから派生する。`boundary` 系は cut/keep どちらにも付きうるため validate の
 * 系不整合検査の対象外(CLAUDE.md 承認境界コメント・design §4.3 表を参照)。 */
export const REASON_ID_FAMILY: Record<CutReasonId, "cut" | "keep" | "boundary"> = {
  restatement: "cut",
  stumble: "cut",
  "duplicate-tail": "cut",
  "gap-trim": "cut",
  "dead-air": "cut",
  tangent: "cut",
  slate: "cut",
  "demo-wait": "keep",
  "failure-and-fix": "keep",
  hook: "keep",
  greeting: "keep",
  "tail-clip": "boundary",
  "reference-orphan": "boundary",
};
