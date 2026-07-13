import type { Hunk } from "./docDiff.ts";
import type { ReviewBundle } from "../stages/review.ts";
import type { EffectWarning } from "./effectCheck.ts";
import { effectWarningsToReviewPatches } from "./effectReview.ts";
import type { EffectReviewPatch } from "./effectReview.ts";

export type ReviewEventKind =
  | "cut"
  | "caption"
  | "overlay"
  | "insert"
  | "annotation"
  | "blur"
  | "zoom"
  | "wipe"
  | "caption-track"
  | "bgm"
  | "short"
  | "json";

export type ReviewEventStatus = "use" | "skip" | "mixed" | "unreviewed";

export interface ReviewEventTimeRange {
  axis: "source" | "output";
  startSec: number;
  endSec: number;
}

export interface ReviewEvent {
  id: string;
  kind: ReviewEventKind;
  title: string;
  subtitle: string;
  timeRange?: ReviewEventTimeRange;
  hunkLabels: string[];
  hunkIndexes: number[];
  jsonPaths: string[];
  intent?: string;
  checkPoints: string[];
  warnings: string[];
  reviewFrameReasons: string[];
}

export function buildReviewEvents(args: {
  hunks: Hunk[];
  reviewBundle?: ReviewBundle;
  aiNotes?: string[];
  applyWarnings?: string[];
  /** effect-check(SD-E2)の演出警告。E6: 該当する zoom/blur/annotation
   *  イベントへ merge する(無ければその演出の独立イベントを1つ作る)。
   *  **未指定(undefined)/空配列のときは既存挙動とバイト等価**
   *  (§docs/plans/2026-07-11-e6-e7-effect-review-loop-design.md 不変条件1) */
  effectWarnings?: EffectWarning[];
}): ReviewEvent[] {
  const groups = new Map<string, { indexes: number[]; hunks: Hunk[] }>();
  args.hunks.forEach((hunk, index) => {
    const key = groupKey(hunk);
    const group = groups.get(key) ?? { indexes: [], hunks: [] };
    group.indexes.push(index);
    group.hunks.push(hunk);
    groups.set(key, group);
  });
  const events = [...groups.values()].map((group) => eventOfGroup(group, args)).sort(compareEvents);
  if (!args.effectWarnings || args.effectWarnings.length === 0) return events;
  return mergeEffectReviewPatches(events, effectWarningsToReviewPatches(args.effectWarnings));
}

/** E6: effect-check 由来の patch を、時間帯(source axis)+kind が一致する
 *  既存イベントへ merge する。一致するイベントが無ければ独立イベントを作る。
 *  既存イベント(hunk 由来)の hunkIndexes/jsonPaths 等は変えず、
 *  warnings/checkPoints/reviewFrameReasons だけへ追記する */
function mergeEffectReviewPatches(events: ReviewEvent[], patches: EffectReviewPatch[]): ReviewEvent[] {
  const merged = events.map((event) => ({
    ...event,
    checkPoints: [...event.checkPoints],
    warnings: [...event.warnings],
    reviewFrameReasons: [...event.reviewFrameReasons],
  }));
  const extra: ReviewEvent[] = [];
  for (const patch of patches) {
    const target = merged.find(
      (event) => event.kind === patch.kind && event.timeRange && timeOverlaps(event.timeRange, patch),
    );
    const warningTexts = patch.fixRef ? [...patch.warnings, `補正候補あり: ${patch.fixRef}`] : patch.warnings;
    if (target) {
      pushUnique(target.warnings, warningTexts);
      pushUnique(target.checkPoints, patch.checkPoints);
      pushUnique(target.reviewFrameReasons, patch.reviewFrameReasons);
    } else {
      extra.push(standaloneEffectEvent(patch, warningTexts));
    }
  }
  return [...merged, ...extra].sort(compareEvents);
}

function timeOverlaps(a: ReviewEventTimeRange, b: { startSec: number; endSec: number }): boolean {
  return a.axis === "source" && a.startSec < b.endSec && b.startSec < a.endSec;
}

function pushUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function standaloneEffectEvent(patch: EffectReviewPatch, warningTexts: string[]): ReviewEvent {
  const timeRange: ReviewEventTimeRange = { axis: "source", startSec: patch.startSec, endSec: patch.endSec };
  return {
    id: stableEventId({ kind: patch.kind, source: "effect-check", timeRange }),
    kind: patch.kind,
    title: `演出検品: ${warningGroupLabel(patch.kind)}`,
    subtitle: subtitleOf([], timeRange),
    timeRange,
    hunkLabels: [],
    hunkIndexes: [],
    jsonPaths: [],
    checkPoints: [...patch.checkPoints],
    warnings: warningTexts,
    reviewFrameReasons: [...patch.reviewFrameReasons],
  };
}

export function reviewEventStatus(args: {
  event: ReviewEvent;
  hunks: Hunk[];
  resolution: Map<Hunk, "theirs" | "mine">;
}): ReviewEventStatus {
  const sides = new Set<"theirs" | "mine">();
  let unresolved = 0;
  for (const index of args.event.hunkIndexes) {
    const hunk = args.hunks[index];
    if (!hunk) continue;
    const side = args.resolution.get(hunk);
    if (!side) {
      unresolved += 1;
      continue;
    }
    sides.add(side);
  }
  if (sides.size === 0) return "unreviewed";
  if (sides.size > 1) return "mixed";
  if (unresolved > 0) return "mixed";
  return sides.has("theirs") ? "use" : "skip";
}

export function warningSummary(events: ReviewEvent[]): {
  total: number;
  groups: { label: string; count: number }[];
} {
  const counts = new Map<ReviewEventKind, number>();
  let total = 0;
  for (const event of events) {
    const count = event.warnings.length;
    total += count;
    if (count === 0) continue;
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + count);
  }
  return {
    total,
    groups: [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([kind, count]) => ({ label: warningGroupLabel(kind), count })),
  };
}

function warningGroupLabel(kind: ReviewEventKind): string {
  switch (kind) {
    case "cut":
      return "カット";
    case "caption":
      return "字幕";
    case "overlay":
      return "素材";
    case "insert":
      return "挿入";
    case "annotation":
      return "注釈";
    case "blur":
      return "ぼかし";
    case "zoom":
      return "ズーム";
    case "wipe":
      return "ワイプ";
    case "caption-track":
      return "字幕トラック";
    case "bgm":
      return "BGM";
    case "short":
      return "ショート";
    default:
      return "JSON";
  }
}

function eventOfGroup(
  group: { indexes: number[]; hunks: Hunk[] },
  args: {
    hunks: Hunk[];
    reviewBundle?: ReviewBundle;
    aiNotes?: string[];
    applyWarnings?: string[];
  },
): ReviewEvent {
  const first = group.hunks[0];
  const kind = kindOf(first);
  const timeRange = timeRangeOf(group.hunks);
  const jsonPaths = group.hunks.map((hunk) => hunk.address.label);
  return {
    id: stableEventId({ kind, jsonPaths, timeRange }),
    kind,
    title: titleOf(kind, group.hunks),
    subtitle: subtitleOf(group.hunks, timeRange),
    timeRange,
    hunkLabels: [...jsonPaths],
    hunkIndexes: [...group.indexes],
    jsonPaths,
    checkPoints: checkPointsOf(kind),
    warnings: warningsForGroup(group.hunks, args),
    reviewFrameReasons: frameReasonsFor(timeRange, args.reviewBundle),
  };
}

function compareEvents(a: ReviewEvent, b: ReviewEvent): number {
  if (a.timeRange && !b.timeRange) return -1;
  if (!a.timeRange && b.timeRange) return 1;
  if (a.timeRange && b.timeRange && a.timeRange.startSec !== b.timeRange.startSec) {
    return a.timeRange.startSec - b.timeRange.startSec;
  }
  return a.kind.localeCompare(b.kind)
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id);
}

function groupKey(hunk: Hunk): string {
  const a = hunk.address;
  if (a.arrayKey && a.elementId) return `${a.file}:${a.arrayKey}:${a.elementId}`;
  if (a.arrayKey) return `${a.file}:${a.arrayKey}`;
  if (a.field) return `${a.file}:${a.field}`;
  return a.label;
}

function kindOf(hunk: Hunk): ReviewEventKind {
  const { file, arrayKey } = hunk.address;
  if (file === "cutplan") return "cut";
  if (file === "transcript" && arrayKey === "segments") return "caption";
  if (file === "overlays" && arrayKey === "overlays") return "overlay";
  if (file === "overlays" && arrayKey === "inserts") return "insert";
  if (file === "overlays" && arrayKey === "annotations") return "annotation";
  if (file === "overlays" && arrayKey === "blurs") return "blur";
  if (file === "overlays" && arrayKey === "zooms") return "zoom";
  if (file === "overlays" && arrayKey === "wipeFull") return "wipe";
  if (file === "overlays" && arrayKey === "captionTracks") return "caption-track";
  if (file === "bgm") return "bgm";
  if (file === "shorts") return "short";
  return "json";
}

function titleOf(kind: ReviewEventKind, hunks: Hunk[]): string {
  const first = hunks[0];
  const field = first.address.field;
  if (kind === "annotation") {
    if (first.kind === "element-add") return "注釈を追加";
    if (first.kind === "element-remove") return "注釈を削除";
    if (isRectField(field) || field === "points") return "注釈の位置を変更";
  }
  if (kind === "blur") {
    if (first.kind === "element-add") return "ぼかしを追加";
    if (isRectField(field)) return "ぼかし範囲を変更";
  }
  if (kind === "zoom" && first.kind === "element-add") return "ズームを追加";
  if (kind === "overlay") {
    if (first.kind === "element-add") return "素材を追加";
    if (first.kind === "element-remove") return "素材を削除";
  }
  if (kind === "insert") {
    if (first.kind === "element-add") return "インサートを追加";
    if (first.kind === "element-remove") return "インサートを削除";
  }
  if (kind === "wipe" && first.kind === "element-add") return "ワイプを追加";
  if (kind === "caption") {
    if (field === "text") return "字幕文言を変更";
    if (field === "start" || field === "end") return "字幕の表示時間を変更";
  }
  if (kind === "cut" && (field === "action" || field === "start" || field === "end")) return "カット範囲を変更";
  if (kind === "bgm" && field === "volume") return "BGM 音量を変更";
  if (kind === "short" && (field === "ranges" || field === "start" || field === "end")) return "ショート範囲を変更";
  return "JSON 変更";
}

function subtitleOf(hunks: Hunk[], timeRange?: ReviewEventTimeRange): string {
  if (timeRange) {
    return `${timeRange.axis} ${formatSec(timeRange.startSec)}-${formatSec(timeRange.endSec)}`;
  }
  if (hunks.length === 1) return hunks[0].address.label;
  return `${hunks.length}件のJSON変更`;
}

function checkPointsOf(kind: ReviewEventKind): string[] {
  switch (kind) {
    case "annotation":
      return ["画面外に出ていないか", "字幕や重要な文字を隠していないか", "表示時間が長すぎないか"];
    case "blur":
      return ["隠したい範囲を覆えているか", "不要な場所まで隠していないか", "動きに対して範囲がずれていないか"];
    case "zoom":
      return ["見せたい箇所が中央付近にあるか", "字幕や注釈が見切れていないか", "ズーム開始と終了が唐突でないか"];
    case "caption":
      return ["意味が変わっていないか", "読める長さになっているか", "表示時間が短すぎないか"];
    case "cut":
      return ["話の意味がつながっているか", "音声や画面が不自然に切れていないか"];
    case "bgm":
      return ["声を邪魔していないか", "区間の入りと終わりが自然か"];
    case "short":
      return ["冒頭で内容が伝わるか", "切り出し範囲が主題に合っているか"];
    default:
      return ["変更内容が意図に合っているか"];
  }
}

function warningsForGroup(
  hunks: Hunk[],
  args: {
    reviewBundle?: ReviewBundle;
    aiNotes?: string[];
    applyWarnings?: string[];
  },
): string[] {
  const keys = warningKeysOf(hunks);
  const warnings = new Set<string>();
  for (const check of args.reviewBundle?.observation.checks ?? []) {
    if ((check.status === "warn" || check.status === "fail") && matchesAny(check.message, keys)) {
      warnings.add(check.message);
    }
  }
  for (const warning of args.applyWarnings ?? []) {
    if (matchesAny(warning, keys)) warnings.add(warning);
  }
  for (const note of args.reviewBundle?.secondaryObservation?.summary ?? []) {
    if (matchesAny(note, keys)) warnings.add(note);
  }
  for (const observation of args.reviewBundle?.secondaryObservation?.items ?? []) {
    if (matchesAny(observation.message, keys)) warnings.add(observation.message);
  }
  return [...warnings];
}

function frameReasonsFor(timeRange: ReviewEventTimeRange | undefined, reviewBundle?: ReviewBundle): string[] {
  if (!timeRange || !reviewBundle) return [];
  const reasons = new Set<string>();
  for (const still of reviewBundle.stills) {
    if (still.requested.axis !== timeRange.axis) continue;
    if (still.requested.atSec < timeRange.startSec || still.requested.atSec > timeRange.endSec) continue;
    reasons.add(still.requested.reason);
  }
  return [...reasons].sort((a, b) => a.localeCompare(b));
}

function timeRangeOf(hunks: Hunk[]): ReviewEventTimeRange | undefined {
  const start = numberField(hunks, "start") ?? numberFromObject(hunks, "start");
  const end = numberField(hunks, "end") ?? numberFromObject(hunks, "end");
  if (start === undefined && end === undefined) return undefined;
  if (start !== undefined && end !== undefined) return normalizeRange(start, end);
  if (start !== undefined) return normalizeRange(start, start + 2);
  const resolvedEnd = end as number;
  return normalizeRange(Math.max(0, resolvedEnd - 2), resolvedEnd);
}

function numberField(hunks: Hunk[], field: string): number | undefined {
  for (const hunk of hunks) {
    if (hunk.address.field === field && typeof hunk.theirs === "number") return hunk.theirs;
  }
  return undefined;
}

function numberFromObject(hunks: Hunk[], field: string): number | undefined {
  for (const hunk of hunks) {
    if (isRecord(hunk.theirs) && typeof hunk.theirs[field] === "number") return hunk.theirs[field] as number;
  }
  return undefined;
}

function normalizeRange(startSec: number, endSec: number): ReviewEventTimeRange {
  const start = round2(Math.min(startSec, endSec));
  const end = round2(Math.max(startSec, endSec));
  return { axis: "source", startSec: start, endSec: end };
}

function warningKeysOf(hunks: Hunk[]): string[] {
  const keys = new Set<string>();
  for (const hunk of hunks) {
    keys.add(hunk.address.label.toLowerCase());
    keys.add(hunk.address.file.toLowerCase());
    if (hunk.address.arrayKey) keys.add(hunk.address.arrayKey.toLowerCase());
    if (hunk.address.elementId) keys.add(hunk.address.elementId.toLowerCase());
  }
  return [...keys];
}

function matchesAny(text: string, keys: string[]): boolean {
  const lower = text.toLowerCase();
  return keys.some((key) => key !== "" && lower.includes(key));
}

function stableEventId(input: unknown): string {
  const text = JSON.stringify(input);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `rev_${(h >>> 0).toString(36)}`;
}

function isRectField(field: string | undefined): boolean {
  return field === "rect" || field?.startsWith("rect.") === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSec(value: number): string {
  return `${round2(value).toFixed(2)}s`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
