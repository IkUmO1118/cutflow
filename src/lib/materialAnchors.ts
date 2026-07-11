// M1(+M4): 素材配置候補の生成(番号選択・人間承認)の純関数群。
// §docs/plans/2026-07-11-m1-material-placement-candidates-design.md
//
// plan-shorts の numberSegments と同じ「番号 → 実体」変換の思想: LLM には
// (anchorId × materialId) のペアだけを選ばせ、時刻・ファイルパス・尺は
// すべてコード側(このファイル)が実在の値から組み立てる。
import { collectWords, candidateText } from "./candidates.ts";
import { mergeIntervals } from "./timeline.ts";
import type { CutPlan, Overlays, Transcript } from "../types.ts";
import type { MaterialsIndex } from "./materials.ts";

/** 素材を出せるスロット。keep span をそのままアンカーにする(時刻は実在) */
export interface MaterialAnchor {
  id: number; // 1始まりの通し番号
  start: number; // 元収録の秒(keep.start)
  end: number; // 元収録の秒(keep.end)
  transcriptText: string; // この span に実際に残る発話(候補の意味づけ)
}

/** LLM に見せる素材候補(materials.probe の実測メタだけ) */
export interface MaterialChoice {
  id: number; // 1始まりの通し番号
  file: string; // 収録フォルダ相対
  kind: "video" | "image";
  durationSec?: number; // 動画のみ。実尺(overlay の再生範囲 cap に使う)
  hasAudio?: boolean;
  ocrPreview?: string[]; // 素材内の画面文字(あれば)
  transcribePreview?: string; // 素材音声の発話(あれば)
}

/** LLM 応答の1配置。番号だけ(時刻・file は含めない) */
export interface Placement {
  anchorId: number;
  materialId: number;
  reason: string;
}

export interface MaterialPlacementCfg {
  minSpanSec: number; // アンカーにする keep span の最小尺
  maxPlacements: number; // 1回の生成で作る overlay の上限(出しすぎ防止)
  defaultVolume: number; // 既定 0(無音。素材音を被せない)
  defaultFit: "contain" | "cover";
  defaultRect?: { x: number; y: number; w: number; h: number }; // 省略=全画面
}

/** cutplan の keep span を時系列に並べてアンカー化。minSpanSec 未満の span は
 *  素材を置くには短すぎるので除外(タイル性は不要=アンカーは飛び飛びでよい)。
 *  transcriptText は candidateText(C8)と同じく「span 内に中点が入る語」だけを
 *  連結する(words が無ければ overlap segment の全文にフォールバック)。 */
export function buildAnchors(
  cutplan: CutPlan,
  transcript: Transcript,
  minSpanSec: number,
): MaterialAnchor[] {
  const keeps = mergeIntervals(
    cutplan.segments
      .filter((s) => s.action === "keep")
      .map((s) => ({ start: s.start, end: s.end })),
  ).sort((a, b) => a.start - b.start);

  const words = collectWords(transcript);
  const anchors: MaterialAnchor[] = [];
  let id = 1;
  for (const k of keeps) {
    if (k.end - k.start < minSpanSec) continue;
    const text =
      candidateText(k, words) ??
      transcript.segments
        .filter((s) => s.start < k.end && s.end > k.start)
        .map((s) => s.text.trim())
        .filter((t) => t.length > 0)
        .join(" ");
    anchors.push({ id: id++, start: k.start, end: k.end, transcriptText: text });
  }
  return anchors;
}

/** materials.probe を LLM 候補へ。present:false(dangling)と kind:"unknown"/"audio"
 *  は除外(overlays は video|image しか置けない)。参照済み(used:true)も
 *  候補に含めてよい(同じ素材を別区間へ再利用しうる)。 */
export function buildMaterialChoices(index: MaterialsIndex): MaterialChoice[] {
  let id = 1;
  return index.materials
    .filter((m) => m.present && (m.kind === "video" || m.kind === "image"))
    .map((m) => ({
      id: id++,
      file: m.file,
      kind: m.kind as "video" | "image",
      ...(m.probe?.durationSec !== undefined ? { durationSec: m.probe.durationSec } : {}),
      ...(m.probe?.hasAudio !== undefined ? { hasAudio: m.probe.hasAudio } : {}),
      ...(m.ocr?.preview?.length ? { ocrPreview: m.ocr.preview } : {}),
      ...(m.transcribe?.preview ? { transcribePreview: m.transcribe.preview } : {}),
    }));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 2つの区間が時間的に重なるか(接触は重なりとみなさない) */
function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** placements(番号ペア)を overlays[] エントリへ変換する純関数。
 *  - 存在しない anchorId / materialId は捨てる(番号選択の安全網)。
 *  - overlay の start/end はアンカーの実区間(LLM は触れない)。
 *  - 動画素材で実尺 < span 尺なら、end を start+実尺へ詰める(尺超過を作らない)。
 *  - 画像素材は span いっぱい表示(尺の概念なし)。
 *  - 同一 anchor に複数配置が来たら時間が重ならないよう間引く(先着優先)。
 *  - maxPlacements で打ち切る。 */
export function placementsToOverlays(
  placements: Placement[],
  anchors: MaterialAnchor[],
  choices: MaterialChoice[],
  cfg: MaterialPlacementCfg,
): NonNullable<Overlays["overlays"]> {
  const anchorsById = new Map(anchors.map((a) => [a.id, a]));
  const choicesById = new Map(choices.map((c) => [c.id, c]));

  const out: NonNullable<Overlays["overlays"]> = [];
  for (const p of placements) {
    if (out.length >= cfg.maxPlacements) break;
    const anchor = anchorsById.get(p.anchorId);
    const material = choicesById.get(p.materialId);
    if (!anchor || !material) continue;

    const spanSec = anchor.end - anchor.start;
    let end = anchor.end;
    if (material.kind === "video" && material.durationSec !== undefined && material.durationSec < spanSec) {
      end = round2(anchor.start + material.durationSec);
    }
    const candidate = { start: anchor.start, end };
    if (out.some((existing) => overlaps(existing, candidate))) continue;

    const item: NonNullable<Overlays["overlays"]>[number] = {
      start: candidate.start,
      end: candidate.end,
      file: material.file,
      fit: cfg.defaultFit,
      ...(cfg.defaultRect ? { rect: cfg.defaultRect } : {}),
    };
    if (material.kind === "video") {
      item.volume = cfg.defaultVolume;
    }
    out.push(item);
  }
  return out;
}
