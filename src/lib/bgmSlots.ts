// B1(+B3): BGM 配置候補の生成(番号選択・人間承認)の純関数群。
// §docs/plans/2026-07-11-b1-b3-bgm-placement-candidates-design.md
//
// plan-materials(M1)/plan-effects(E1)と同じ「番号 → 実体」変換の思想: LLM には
// (slotId × 曲番号 or null)のペアだけを選ばせ、時刻・ファイルパス・音量は
// すべてコード側(このファイル)が実在の値(切替アンカー・実在音声ファイル)から
// 組み立てる。
import { buildTimeline, playbackSegmentsOf, remapInterval } from "./timeline.ts";
import type { Bgm, Chapters, CutPlan } from "../types.ts";

/** BGM の切れ目候補(元収録の秒)。source で由来が分かる。 */
export interface BgmAnchor {
  timeSec: number;
  source: "chapter" | "cut" | "start" | "end";
  label: string; // 章タイトル or "大カット" 等(スロットの意味づけ)
}

/** 隣り合うアンカーで挟まれた区間スロット。ここに曲 or 無音を割り当てる。 */
export interface BgmSlot {
  id: number; // 1始まりの通し番号
  start: number; // 元収録の秒(アンカー時刻)
  end: number; // 元収録の秒(次アンカー時刻)
  label: string; // 章タイトル等(LLM への意味づけ)
  keepSec: number; // この区間で実際に流れる尺(カット控除後。visibleSec 相当)
}

/** LLM に見せる曲候補(実在ファイルだけ)。 */
export interface BgmChoice {
  id: number; // 1始まりの通し番号
  file: string; // 収録フォルダ相対(materials/xxx.mp3 or bgm.mp3)
  durationSec?: number; // 分かれば(無くてもよい=ループ再生前提)
}

/** LLM 応答の1割り当て。番号だけ(file は曲番号 or null=無音)。 */
export interface BgmAssignment {
  slotId: number;
  file: number | null;
  reason: string;
}

export interface BgmSlotCfg {
  bigCutSec: number; // 「大カット境界」とみなす cut 尺の下限(既定 3.0)
  minSlotSec: number; // BGM スロットの最小尺(これ未満は前後へ吸収。既定 8.0)
  maxSlots: number; // スロット上限(区切りすぎ防止。既定 12)
}

/** アンカー由来ごとの優先度(近接マージ時にどちらの意味づけを残すか)。
 *  章タイトルが最も情報量が多いので最優先、次いで端点、最後が大カット */
const SOURCE_PRIORITY: Record<BgmAnchor["source"], number> = {
  chapter: 3,
  start: 2,
  end: 2,
  cut: 1,
};

/** 章境界 + 大カット境界から切替アンカーを決定論生成。
 *  - 章境界: chapters.chapters[].start(あれば)。
 *  - 大カット境界: cutplan の cut segment のうち尺が cfg.bigCutSec 以上の所
 *    (その cut の終端 = 次に映像が再開する実時刻をアンカーにする)。
 *  - 先頭(0)と末尾(totalSec)も端アンカーに含める。
 *  - cfg.minSlotSec 未満の間隔で近接するアンカーは1つへマージする
 *    (章タイトルなど情報量の多い由来を優先して残す)。 */
export function buildBgmAnchors(
  cutplan: CutPlan,
  chapters: Chapters | null,
  totalSec: number,
  cfg: BgmSlotCfg,
): BgmAnchor[] {
  const raw: BgmAnchor[] = [];
  raw.push({ timeSec: 0, source: "start", label: "開始" });
  if (chapters) {
    for (const c of chapters.chapters) {
      raw.push({ timeSec: c.start, source: "chapter", label: c.title });
    }
  }
  const sortedSegments = [...cutplan.segments].sort((a, b) => a.start - b.start);
  for (const s of sortedSegments) {
    if (s.action === "cut" && s.end - s.start >= cfg.bigCutSec) {
      raw.push({ timeSec: s.end, source: "cut", label: "大カット" });
    }
  }
  raw.push({ timeSec: totalSec, source: "end", label: "終了" });

  raw.sort((a, b) => a.timeSec - b.timeSec);

  const merged: BgmAnchor[] = [];
  for (const a of raw) {
    const last = merged[merged.length - 1];
    if (last && a.timeSec - last.timeSec < cfg.minSlotSec) {
      if (SOURCE_PRIORITY[a.source] > SOURCE_PRIORITY[last.source]) {
        merged[merged.length - 1] = a;
      }
      continue;
    }
    merged.push(a);
  }
  return merged;
}

/** アンカー列を区間スロットへ。minSlotSec 未満のスロットは前後(直前優先。
 *  先頭スロットだけは直後)へ吸収する。keepSec は timeline の写像
 *  (validate.ts の visibleSec と同じ考え方。カット控除後の可視尺)で計算する。
 *  cfg.maxSlots を超えるぶんは打ち切る(区切りすぎ防止。末尾の未カバー区間は
 *  BGM を敷かない=無音のままになる。これは正当な出力) */
export function anchorsToSlots(
  anchors: BgmAnchor[],
  cutplan: CutPlan,
  cfg: BgmSlotCfg,
): BgmSlot[] {
  const sorted = [...anchors].sort((a, b) => a.timeSec - b.timeSec);

  interface Window {
    start: number;
    end: number;
    label: string;
  }

  const windows: Window[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i].timeSec;
    const end = sorted[i + 1].timeSec;
    if (end - start < 1e-6) continue;
    windows.push({ start, end, label: sorted[i].label });
  }
  if (windows.length === 0) return [];

  // 短すぎるスロットを直前のスロットへ吸収する
  const absorbed: Window[] = [];
  for (const w of windows) {
    if (w.end - w.start < cfg.minSlotSec && absorbed.length > 0) {
      absorbed[absorbed.length - 1] = { ...absorbed[absorbed.length - 1], end: w.end };
    } else {
      absorbed.push({ ...w });
    }
  }
  // 先頭スロットに吸収先(直前)が無い場合は直後へ吸収する
  if (absorbed.length > 1 && absorbed[0].end - absorbed[0].start < cfg.minSlotSec) {
    absorbed[1] = { start: absorbed[0].start, end: absorbed[1].end, label: absorbed[0].label };
    absorbed.shift();
  }

  const capped = absorbed.slice(0, cfg.maxSlots);

  const playback = playbackSegmentsOf(cutplan);
  const timeline = playback.length > 0 ? buildTimeline(playback) : [];
  const keepSecOf = (start: number, end: number): number =>
    timeline.length > 0
      ? remapInterval(start, end, timeline).reduce((s, iv) => s + (iv.end - iv.start), 0)
      : 0;

  let id = 1;
  return capped.map((w) => ({
    id: id++,
    start: w.start,
    end: w.end,
    label: w.label,
    keepSec: keepSecOf(w.start, w.end),
  }));
}

/** 実在音声ファイル一覧を LLM に見せる曲候補へ。id は1始まり。 */
export function buildBgmChoices(audioFiles: string[]): BgmChoice[] {
  let id = 1;
  return audioFiles.map((file) => ({ id: id++, file }));
}

/** assignments(番号ペア)を bgm.tracks[] へ変換する純関数。
 *  - 存在しない slotId / file 番号は捨てる(番号選択の安全網)。同じ slotId が
 *    複数来たら先着優先(後続は無視)。
 *  - file===null(無音)のスロットは track を作らない(覆わない区間=無音。
 *    types.ts Bgm の仕様)。
 *  - 隣接スロット(スロット配列上で連続)が同じ file 番号なら連結して1トラックへ
 *    (start は最初のスロットの start、end は最後のスロットの end)。
 *  - track の start/end はスロットの実時刻(LLM は触れない)。volumeDb 等は
 *    付けない(既定に任せる)。 */
export function assignmentsToTracks(
  assignments: BgmAssignment[],
  slots: BgmSlot[],
  choices: BgmChoice[],
): NonNullable<Bgm["tracks"]> {
  const slotsById = new Map(slots.map((s) => [s.id, s]));
  const choicesById = new Map(choices.map((c) => [c.id, c]));

  const fileBySlot = new Map<number, number | null>();
  for (const a of assignments) {
    if (!slotsById.has(a.slotId)) continue;
    if (a.file !== null && !choicesById.has(a.file)) continue;
    if (fileBySlot.has(a.slotId)) continue; // 先着優先
    fileBySlot.set(a.slotId, a.file);
  }

  const tracks: NonNullable<Bgm["tracks"]> = [];
  let run: { file: string; start: number; end: number } | null = null;
  for (const slot of slots) {
    const fileId = fileBySlot.get(slot.id);
    if (fileId === undefined || fileId === null) {
      if (run) {
        tracks.push(run);
        run = null;
      }
      continue;
    }
    const file = choicesById.get(fileId)!.file;
    if (run && run.file === file) {
      run.end = slot.end;
    } else {
      if (run) tracks.push(run);
      run = { file, start: slot.start, end: slot.end };
    }
  }
  if (run) tracks.push(run);
  return tracks;
}
