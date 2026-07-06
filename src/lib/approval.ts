// 承認レコード(approvals.json)のハッシュ算出と I/O。
//
// 承認は「cutplan / short の keep 集合(= render が実際に使う内容)」の
// sha256 ハッシュに束縛される。boolean の approved はもう render のゲートでは
// なく、人間の承認意図の表示に過ぎない(src/types.ts の CutPlan.approved /
// Short.approved を参照)。ゲートは isCutplanApproved / isShortApproved の
// 「現内容のハッシュと一致する承認レコードが approvals.json にあるか」だけで
// 判定する(レコード無し/ハッシュ不一致は未承認)。
//
// 純ハッシュ関数(cutplanApprovalHash / shortApprovalHash)と fs I/O を分離し、
// ハッシュ計算だけを fs 抜きで単体テストできるようにしている。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeIntervals } from "./timeline.ts";
import type { Approvals, ApprovalRecord, CutPlan, Interval, Short } from "../types.ts";

/** 収録フォルダ直下の承認レコードファイル名。編集ワークフロー
 * (EDITABLE_FILES)にも中間生成物(GENERATED_FILES)にも属さない第3カテゴリ。
 * backup 退避の対象にはしない(内容が変われば作り直すものであり、
 * 退避・復元の対象ではない) */
export const APPROVALS_FILE = "approvals.json";

/** keep 区間を承認ハッシュ用に正規化する: mergeIntervals 後に [start, end] の
 * タプル配列にし、各値を ms 丸め(浮動小数のジッタを吸収)する */
function normalizeKeeps(keeps: Interval[]): [number, number][] {
  return mergeIntervals(keeps).map((k) => [round3(k.start), round3(k.end)]);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function sha256Of(payload: unknown): string {
  const json = JSON.stringify(payload);
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

/**
 * cutplan の承認ハッシュ。対象は keep 集合のみ(mergeIntervals(segments
 * filter action==="keep") を正規化)。reason・cut セグメントはハッシュに
 * 含めない(出力に影響しない注釈のため、reason だけの編集で承認は失効しない)。
 */
export function cutplanApprovalHash(cutplan: CutPlan): string {
  const keeps = cutplan.segments.filter((s) => s.action === "keep");
  return sha256Of(normalizeKeeps(keeps));
}

/**
 * short の承認ハッシュ。対象は { profile, keeps }。profile はレイアウト=
 * 出力に効くため含める。name はレコードのキーであってハッシュ対象ではない
 * (rename は別ショート扱いで新規レコードになる)。captionTracks はハッシュ
 * 対象外(承認スコープは cut 決定のみ)。
 */
export function shortApprovalHash(short: Short): string {
  return sha256Of({
    profile: short.profile ?? null,
    keeps: normalizeKeeps(short.ranges),
  });
}

/** approvals.json を読む(無ければ空の Approvals) */
export function readApprovals(dir: string): Approvals {
  const p = join(dir, APPROVALS_FILE);
  if (!existsSync(p)) return { version: 1 };
  return JSON.parse(readFileSync(p, "utf8")) as Approvals;
}

function writeApprovals(dir: string, approvals: Approvals): void {
  // cutplan / shorts が undefined のときは JSON.stringify が自動でキーを
  // 落とす(「承認が無い項目はキーごと存在しない」という §2.2 の仕様どおり)
  writeFileSync(join(dir, APPROVALS_FILE), JSON.stringify(approvals, null, 2));
}

/** cutplan の承認レコードを mint する(現内容のハッシュで上書き)。
 * by は監査用の情報(判定には使わない) */
export function writeCutplanApproval(
  dir: string,
  cutplan: CutPlan,
  by: "cli" | "gui",
): void {
  const approvals = readApprovals(dir);
  const record: ApprovalRecord = {
    hash: cutplanApprovalHash(cutplan),
    approvedAt: new Date().toISOString(),
    by,
  };
  writeApprovals(dir, { ...approvals, version: 1, cutplan: record });
}

/** cutplan の承認レコードを消す(unapprove) */
export function clearCutplanApproval(dir: string): void {
  const approvals = readApprovals(dir);
  if (!approvals.cutplan) return;
  writeApprovals(dir, { version: 1, shorts: approvals.shorts });
}

/** short(name)の承認レコードを mint する(現内容のハッシュで上書き) */
export function writeShortApproval(
  dir: string,
  short: Short,
  by: "cli" | "gui",
): void {
  const approvals = readApprovals(dir);
  const record: ApprovalRecord = {
    hash: shortApprovalHash(short),
    approvedAt: new Date().toISOString(),
    by,
  };
  writeApprovals(dir, {
    ...approvals,
    version: 1,
    shorts: { ...approvals.shorts, [short.name]: record },
  });
}

/** short(name)の承認レコードを消す(unapprove) */
export function clearShortApproval(dir: string, name: string): void {
  const approvals = readApprovals(dir);
  if (!approvals.shorts?.[name]) return;
  const shorts = { ...approvals.shorts };
  delete shorts[name];
  writeApprovals(dir, {
    ...approvals,
    version: 1,
    shorts: Object.keys(shorts).length > 0 ? shorts : undefined,
  });
}

/** render ゲートの判定結果。ok なら render 可、false なら reason に理由 */
export interface ApprovalGate {
  ok: boolean;
  reason?: string;
}

/** cutplan が「現内容のハッシュに一致する承認レコード」を持つか(render の
 * 唯一のゲート。boolean approved へは一切フォールバックしない=strict) */
export function isCutplanApproved(dir: string, cutplan: CutPlan): ApprovalGate {
  const record = readApprovals(dir).cutplan;
  if (!record) return { ok: false, reason: "承認レコードがありません(未承認)" };
  if (record.hash !== cutplanApprovalHash(cutplan)) {
    return {
      ok: false,
      reason: "承認後に cut が変更されています(承認が失効)。再承認が必要です",
    };
  }
  return { ok: true };
}

/** short が「現内容のハッシュに一致する承認レコード」を持つか */
export function isShortApproved(dir: string, short: Short): ApprovalGate {
  const record = readApprovals(dir).shorts?.[short.name];
  if (!record) return { ok: false, reason: "承認レコードがありません(未承認)" };
  if (record.hash !== shortApprovalHash(short)) {
    return {
      ok: false,
      reason: "承認後に ranges/profile が変更されています(承認が失効)。再承認が必要です",
    };
  }
  return { ok: true };
}
