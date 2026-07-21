// E1(+E2): 演出アンカー候補の生成(番号選択・人間承認)の純関数群。
// §docs/plans/2026-07-11-e1-e2-effect-anchor-candidates-design.md
//
// plan-materials(M1)と同じ「番号 → 実体」変換の思想: LLM には
// (anchorId × effect) のペアだけを選ばせ、時刻・矩形・強度はすべて
// コード側(このファイル)が知覚(OCR/motion)由来の実在値から組み立てる。
import { collectWords, candidateText } from "./candidates.ts";
import { buildTimeline, mergeIntervals, playbackSegmentsOf, toSourceTime } from "./timeline.ts";
import type { CutPlan, Overlays, Region, Transcript } from "../types.ts";

/** 演出を置ける候補。rect は知覚由来の実矩形(LLM は触らない)。
 *  rect が無い(発話のみ由来)アンカーは zoom/blur/annotation の対象にできない */
export interface EffectAnchor {
  id: number; // 1始まりの通し番号
  start: number; // 元収録の秒
  end: number; // 元収録の秒
  rect?: Region; // 出力px。OCR box / scene 変化領域
  source: "ocr" | "motion" | "speech";
  text: string; // OCR テキスト or 実残存発話・演出の意味づけ
}

/** LLM が返す1判断。番号+種別だけ(座標・時刻・色は含めない) */
export interface EffectDecision {
  anchorId: number;
  effect: "zoom" | "blur" | "annotation" | "none";
  /** 判断状況の分類。plan.reasonIds.enabled=true の応答だけが持つ(opt-in)。 */
  effectReasonId?: string;
  reason: string;
}

/** none は配置を作らないが、判断記録が無制限に膨らまないよう別予算で絞る。
 * disabled は入力配列そのものを返し、導入前経路の参照同一性も保つ。 */
export function limitNoneDecisions(
  decisions: EffectDecision[],
  anchorCount: number,
  enabled: boolean,
): EffectDecision[] {
  if (!enabled) return decisions;
  const normalizedAnchorCount = Math.max(0, anchorCount);
  const maxNone = Math.min(
    normalizedAnchorCount,
    Math.max(12, Math.ceil(normalizedAnchorCount * 0.1)),
  );
  let keptNone = 0;
  return decisions.filter((decision) => {
    if (decision.effect !== "none") return true;
    if (keptNone >= maxNone) return false;
    keptNone++;
    return true;
  });
}

export interface EffectPlacementCfg {
  maxDecisions: number; // 1回で作る演出の上限(出しすぎ防止)
  anchorWindowSec: number; // アンカー時刻の前後に張る窓(zoom/blur の表示尺)
  minSceneScore: number; // motion アンカーにする sceneScore 下限
  minOcrBoxAreaPx: number; // OCR box をアンカーにする最小面積(小さい文字を除外)
  minZoomRect: { w: number; h: number }; // zoom rect の最小サイズ(拡大しすぎ防止)
  defaultBlurStrength: number; // blur の既定強度(0..1)
}

/** decisionsToOverlays が rect の clamp に使う出力解像度込みの cfg。
 *  出力解像度は収録ごとに違う(manifest 由来)ので config.yaml 由来の
 *  EffectPlacementCfg とは別に、呼び出し側(planEffects.ts)が合成する */
export type EffectOverlayCfg = EffectPlacementCfg & { outW: number; outH: number };

/** frames --ocr が書く `frames/out<秒>s.ocr.json` のうち buildEffectAnchors が
 *  読む部分だけを抜き出した形。sourceSec は元収録の秒(サイドカーが書く時点で
 *  変換済みなので無変換で使える)。box は本編 screenRegion 出力px
 *  (frames --ocr / overlays の rect と同じ座標系) */
export interface OcrSidecar {
  sourceSec: number;
  lines: { text: string; box: Region }[];
}

/** av.probe/motion.json のうち buildEffectAnchors が読む部分だけを抜き出した形。
 *  motion[].sourceSec は元収録の秒(直接使える)。frozen は outSec/endOutSec
 *  (カット後の秒)しか持たないため、cutplan から組んだ timeline で
 *  元収録の秒へ変換してから使う */
export interface MotionLike {
  motion: { outSec: number; sourceSec: number; sceneScore: number }[];
  frozen: { outSec: number; endOutSec: number; lenSec: number }[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 2つの区間が時間的に重なるか(接触は重なりとみなさない) */
function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

interface Draft {
  start: number;
  end: number;
  rect?: Region;
  source: "ocr" | "motion" | "speech";
  text: string;
  sortAt: number;
}

/** OCR/motion/transcript から演出アンカーを決定論生成する。cutplan の keep 区間
 *  内に落ちる候補だけを採用する(cut span からはアンカーを作らない)。
 *  - OCR 由来: 各 OCR line を、box が cfg.minOcrBoxAreaPx 以上のものだけ採用
 *    (rect=line.box、text=line.text、source="ocr")。
 *  - motion 由来: sceneScore が cfg.minSceneScore を超えるサンプル時刻
 *    (rect 無し)。密なサンプルが生む近接ウィンドウは重なりをマージして
 *    1アンカーにまとめる。frozen(長い静止)区間も候補に含める。
 *  - speech 由来: cfg.anchorWindowSec 以上ある keep span ごとに1アンカー
 *    (rect 無し=意味づけ用。実際に残る語だけを連結するテキスト)。
 *  id は時系列順の1始まり連番。 */
export function buildEffectAnchors(
  cutplan: CutPlan,
  transcript: Transcript,
  ocrSidecars: OcrSidecar[],
  motion: MotionLike | null,
  cfg: EffectPlacementCfg,
): EffectAnchor[] {
  const keeps = mergeIntervals(
    cutplan.segments
      .filter((s) => s.action === "keep")
      .map((s) => ({ start: s.start, end: s.end })),
  ).sort((a, b) => a.start - b.start);

  const half = cfg.anchorWindowSec / 2;

  /** t が落ちる keep interval(cut span なら null=アンカーを作らない) */
  const containingKeep = (t: number): { start: number; end: number } | null =>
    keeps.find((k) => t >= k.start && t <= k.end) ?? null;

  const drafts: Draft[] = [];

  // --- OCR 由来: 各 line を box が十分大きいものだけアンカー化
  for (const sidecar of ocrSidecars) {
    const keep = containingKeep(sidecar.sourceSec);
    if (!keep) continue;
    for (const line of sidecar.lines) {
      const area = line.box.w * line.box.h;
      if (area < cfg.minOcrBoxAreaPx) continue;
      const start = Math.max(keep.start, round2(sidecar.sourceSec - half));
      const end = Math.min(keep.end, round2(sidecar.sourceSec + half));
      if (end <= start) continue;
      drafts.push({ start, end, rect: line.box, source: "ocr", text: line.text, sortAt: sidecar.sourceSec });
    }
  }

  if (motion) {
    // --- motion 由来: sceneScore が下限を超えるサンプル時刻。
    //     重なるウィンドウはマージして1アンカーにまとめる(重複時刻はマージ)
    interface MotionWindow {
      start: number;
      end: number;
      maxScore: number;
    }
    const rawWindows: MotionWindow[] = [];
    for (const m of motion.motion) {
      if (m.sceneScore <= cfg.minSceneScore) continue;
      const keep = containingKeep(m.sourceSec);
      if (!keep) continue;
      const start = Math.max(keep.start, round2(m.sourceSec - half));
      const end = Math.min(keep.end, round2(m.sourceSec + half));
      if (end <= start) continue;
      rawWindows.push({ start, end, maxScore: m.sceneScore });
    }
    rawWindows.sort((a, b) => a.start - b.start);
    const merged: MotionWindow[] = [];
    for (const w of rawWindows) {
      const last = merged[merged.length - 1];
      if (last && w.start < last.end) {
        last.end = Math.max(last.end, w.end);
        last.maxScore = Math.max(last.maxScore, w.maxScore);
      } else {
        merged.push({ ...w });
      }
    }
    for (const w of merged) {
      drafts.push({
        start: w.start,
        end: w.end,
        source: "motion",
        text: `シーン変化(score ${w.maxScore.toFixed(2)})`,
        sortAt: w.start,
      });
    }

    // --- frozen(長い静止)区間: outSec/endOutSec(カット後の秒)しか持たないので
    //     cutplan から組んだ timeline で元収録の秒へ変換する
    const timeline = buildTimeline(playbackSegmentsOf(cutplan));
    for (const fr of motion.frozen) {
      const srcStart = toSourceTime(fr.outSec, timeline);
      const srcEnd = toSourceTime(fr.endOutSec, timeline);
      if (srcStart === null || srcEnd === null) continue;
      const keep = containingKeep(srcStart);
      if (!keep) continue;
      const start = Math.max(keep.start, srcStart);
      const end = Math.min(keep.end, srcEnd);
      if (end <= start) continue;
      drafts.push({ start, end, source: "motion", text: `静止(${fr.lenSec.toFixed(1)}秒)`, sortAt: start });
    }
  }

  // --- speech 由来: 十分な尺の keep span ごとに1アンカー(rect無し=意味づけ用)
  const words = collectWords(transcript);
  for (const k of keeps) {
    if (k.end - k.start < cfg.anchorWindowSec) continue;
    const text =
      candidateText(k, words) ??
      transcript.segments
        .filter((s) => s.start < k.end && s.end > k.start)
        .map((s) => s.text.trim())
        .filter((t) => t.length > 0)
        .join(" ");
    drafts.push({ start: k.start, end: k.end, source: "speech", text, sortAt: k.start });
  }

  drafts.sort((a, b) => a.sortAt - b.sortAt);
  return drafts.map((d, i) => ({
    id: i + 1,
    start: d.start,
    end: d.end,
    ...(d.rect ? { rect: d.rect } : {}),
    source: d.source,
    text: d.text,
  }));
}

/** rect の w/h を outW/outH 以内に縮め、x/y を範囲内へ収める(画面外はみ出しを防ぐ) */
function clampRect(rect: Region, outW: number, outH: number): Region {
  const w = Math.min(rect.w, outW);
  const h = Math.min(rect.h, outH);
  const x = Math.min(Math.max(rect.x, 0), Math.max(0, outW - w));
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, outH - h));
  return { x: round2(x), y: round2(y), w: round2(w), h: round2(h) };
}

/** rect が min より小さければ中心を保ったまま min サイズへ広げる(拡大しすぎ防止) */
function growToMinZoom(rect: Region, min: { w: number; h: number }): Region {
  if (rect.w >= min.w && rect.h >= min.h) return rect;
  const w = Math.max(rect.w, min.w);
  const h = Math.max(rect.h, min.h);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { x: round2(cx - w / 2), y: round2(cy - h / 2), w: round2(w), h: round2(h) };
}

/** decisions(番号+種別)を overlays の zooms/blurs/annotations へ変換する純関数。
 *  - 存在しない anchorId は捨てる(番号選択の安全網)。
 *  - effect==="none" は何も生成しない。
 *  - rect の無いアンカーへ zoom/blur/annotation が来たら捨てる(座標が無いので
 *    安全に置けない)。
 *  - zoom: 時間衝突する zoom は先着優先で間引く(validate は zoom 重なりを
 *    エラーにするため)。rect は cfg.minZoomRect 未満なら中心保存で拡大。
 *  - blur: { start, end, rect, strength: cfg.defaultBlurStrength }。
 *  - annotation: box のみ { type:"box", start, end, rect }(色・太さは既定)。
 *  - すべての rect は出力解像度内へ clamp する(blur の画面外は validate エラー)。
 *  - maxDecisions で打ち切る(採用できた件数ベース)。 */
export function decisionsToOverlays(
  decisions: EffectDecision[],
  anchors: EffectAnchor[],
  cfg: EffectOverlayCfg,
): Pick<Overlays, "zooms" | "blurs" | "annotations"> {
  const anchorsById = new Map(anchors.map((a) => [a.id, a]));
  const zooms: NonNullable<Overlays["zooms"]> = [];
  const blurs: NonNullable<Overlays["blurs"]> = [];
  const annotations: NonNullable<Overlays["annotations"]> = [];
  let accepted = 0;

  for (const d of decisions) {
    if (accepted >= cfg.maxDecisions) break;
    if (d.effect === "none") continue;
    const anchor = anchorsById.get(d.anchorId);
    if (!anchor || !anchor.rect) continue;

    if (d.effect === "zoom") {
      const candidate = { start: anchor.start, end: anchor.end };
      if (zooms.some((z) => overlaps(z, candidate))) continue;
      const rect = clampRect(growToMinZoom(anchor.rect, cfg.minZoomRect), cfg.outW, cfg.outH);
      zooms.push({
        start: anchor.start,
        end: anchor.end,
        rect,
        ...(d.effectReasonId !== undefined ? { reasonId: d.effectReasonId } : {}),
      });
      accepted++;
    } else if (d.effect === "blur") {
      const rect = clampRect(anchor.rect, cfg.outW, cfg.outH);
      blurs.push({
        start: anchor.start,
        end: anchor.end,
        rect,
        strength: cfg.defaultBlurStrength,
        ...(d.effectReasonId !== undefined ? { reasonId: d.effectReasonId } : {}),
      });
      accepted++;
    } else if (d.effect === "annotation") {
      const rect = clampRect(anchor.rect, cfg.outW, cfg.outH);
      annotations.push({
        type: "box",
        start: anchor.start,
        end: anchor.end,
        rect,
        ...(d.effectReasonId !== undefined ? { reasonId: d.effectReasonId } : {}),
      });
      accepted++;
    }
  }

  return {
    ...(zooms.length > 0 ? { zooms } : {}),
    ...(blurs.length > 0 ? { blurs } : {}),
    ...(annotations.length > 0 ? { annotations } : {}),
  };
}
