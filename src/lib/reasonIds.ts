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

/** 一行定義。docs/edit-skills/README.md の表と同内容(§P2-7。プロンプト注入
 * (lib/reasonIdInjection.ts)と doc 検査の両方が使う想定の一次資料)。
 * P6-T6 で `docs/edit-skills/recipes/*.md` の判定シグナル(craft 由来を含む)
 * から蒸留し、最も判別力のある識別子(特に G2 対比ペアとの弁別語)へ研いだ
 * (docs/plans/2026-07-21-cut-knowledge-p6-design.md §1.4)。意味は実データの
 * 記述を上書きしない(§5.2)——語順・語彙の圧縮のみ。 */
export const REASON_ID_LABEL: Record<CutReasonId, string> = {
  restatement: "同内容を後でうまく言い直す時の収束前の版(前半)。未完成の言いかけを含む",
  stumble: "内容が無いフィラー単独・言い淀みの反復(除いても意味が変わらない)",
  "duplicate-tail": "完成後に残った末尾・遷移句の反復(直前keepの末尾と一致する断片)",
  "gap-trim": "keep済み発話どうしの短い無音を詰める(0.1〜1.5秒・テンポ調整)",
  "dead-air": "発話も画面変化もない長めの間(段取り・思考。demo-waitと違い画面が動かない)",
  tangent: "本題と無関係な脱線・独り言(章立て・briefのどの主題にも紐づかない)",
  slate: "収録の頭/尻の段取り(本編の外。最初/最後のkeepより外側)",
  "demo-wait": "画面が語っている無言(結果待ち・dead-airと違い直前から画面が変化)",
  "failure-and-fix": "エラーと解決のセット(片方だけ残さない。単一候補では判断しない)",
  hook: "冒頭のフック(課題提示。主題提示より前。テンポ調整の対象にしない)",
  greeting: "挨拶・お礼・締め(尺の都合で切らない。余韻の無音も含めて残す)",
  "tail-clip": "境界が語尾を食う(後ろへ倒す。語の終了時刻以降まで余白を残す)",
  "reference-orphan": "切ると次候補の指示語が宙に浮く(前へ倒す。単一候補では判断しない)",
};
