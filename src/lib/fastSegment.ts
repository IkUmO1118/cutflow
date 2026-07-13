// lib/fastSegment.ts — render 高速パスの FAST スパン1本を ffmpeg だけで
// レンダーする(Remotion を起動しない・映像のみ・音声は別経路)。P2 は
// このライブラリだけを定義する(render.ts への配線は P3)。
//
// FAST スパンは「ベース映像 + 静的テロップ PNG だけで合成できる区間」
// (fastPlan.ts §4 適格表)。cut.mp4 から該当フレーム範囲を trim し、
// テロップ静止画(captionStill.ts が作る透過 PNG)を enable 窓付きで
// overlay するだけの単純な filtergraph で完結させる。
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "./exec.ts";
import { renderCaptionStill } from "./captionStill.ts";
import { buildCaptionIndex, lookupCaption } from "./captionIndex.ts";
import { capNum, DEFAULT_LAYER_ORDER } from "../types.ts";
import type { FastSpan } from "./fastPlan.ts";
import type { WarmAssets } from "../stages/frames.ts";
import type { Caption, RenderProps } from "../../remotion/props.ts";
import type { CaptionStillProps } from "../../remotion/CaptionStill.tsx";

export const FAST_SEGMENT_DIR = "render.fast/segments";

export type FastFpsRound = "zero" | "inf" | "down" | "up" | "near";

export const FAST_FPS_ROUND: FastFpsRound = "near";

/** ffmpeg 側の色空間補正。Remotion(sRGB/full-range 前提のブラウザ合成)と
 * 同じ見た目にするための固定チェーン(limited→full の展開 + BT.709 の
 * primaries を維持したまま SMPTE170M の伝達特性/行列で解釈させる)。
 * PSNR ガードで検証済みの組み合わせなので値を変えない */
export const BASE_COLOR_FILTER =
  "scale=in_range=limited:out_range=full,colorspace=all=smpte170m:iall=bt709:range=pc,format=yuvj420p";

/** セグメント内ローカル・フレーム番号の inclusive [from,to] 窓
 * (ffmpeg between(n,from,to) にそのまま渡せる形) */
export type EnableWindow = [number, number];

export interface FastCaptionPlacement {
  caption: Caption;
  enableWindows: EnableWindow[];
}

export interface FastSegmentSpec {
  cutPath: string;
  outPath: string;
  fromFrame: number;
  toFrame: number;
  fps: number;
  fpsRound?: FastFpsRound;
  captions: { pngPath: string; enableWindows: EnableWindow[] }[];
}

/** span 内で表示されるテロップと、その enable 窓(セグメント内ローカル・
 * フレーム番号)を解決する。Main.tsx の z-order(layerOrder)+可視性判定
 * (lookupCaption: 重複時は旧 .find 互換の配列順先勝ち)を frame scan で
 * 再現し、連続する同一 caption を1つの enable 窓にまとめる。 */
export function resolveFastCaptions(props: RenderProps, span: FastSpan): FastCaptionPlacement[] {
  const fps = props.fps;
  const order = props.layerOrder ?? DEFAULT_LAYER_ORDER;
  const index = buildCaptionIndex(props.captions);
  const out: FastCaptionPlacement[] = [];
  for (const id of order) {
    const track = capNum(id);
    if (track === null) continue;
    const placements = new Map<Caption, FastCaptionPlacement>();
    for (let frame = span.fromFrame; frame < span.toFrame; frame++) {
      const t = frame / fps;
      if ((props.hideCaption ?? []).some((h) => t >= h.start && t < h.end)) continue;
      const caption = lookupCaption(index, track, t);
      if (!caption) continue;
      if (caption.style?.anim || caption.style?.karaoke) {
        throw new Error(
          `FAST span[${span.fromFrame},${span.toFrame}) に anim/karaoke テロップが混入(start=${caption.start})`,
        );
      }
      let placement = placements.get(caption);
      if (!placement) {
        placement = { caption, enableWindows: [] };
        placements.set(caption, placement);
      }
      const localFrame = frame - span.fromFrame;
      const last = placement.enableWindows.at(-1);
      if (last && last[1] === localFrame - 1) last[1] = localFrame;
      else placement.enableWindows.push([localFrame, localFrame]);
    }
    out.push(...placements.values());
  }
  return out;
}

// ---- 純関数: filtergraph / argv 組み立て ----

export function buildFastSegmentFilter(spec: FastSegmentSpec): string {
  // fps は cut.mp4 の timestamp から CFR 格子を作る。そこで frame trim する
  // ことで、Remotion OffthreadVideo の時刻ベース選択と同じソースを選ぶ。
  // trim 後の setpts=N/fps/TB はセグメントローカル PTS を安定化し、FAST と
  // SLOW の混在 concat を frames/fps ちょうどの尺に揃えるためのもの。
  // overlay の n は fps+trim 後のローカル出力フレーム番号なので変わらない。
  const round = spec.fpsRound ?? FAST_FPS_ROUND;
  const base = `[0:v]setpts=PTS-STARTPTS,fps=fps=${spec.fps}:round=${round}:start_time=0,trim=start_frame=${spec.fromFrame}:end_frame=${spec.toFrame},setpts=N/${spec.fps}/TB,${BASE_COLOR_FILTER}`;
  if (spec.captions.length === 0) return `${base}[vout]`;
  const parts = [`${base}[b0]`];
  let prev = "b0";
  spec.captions.forEach((c, i) => {
    const inputIdx = i + 1;
    const outLabel = i === spec.captions.length - 1 ? "vout" : `o${i}`;
    const enable = c.enableWindows.map(([a, b]) => `between(n,${a},${b})`).join("+");
    parts.push(`[${prev}][${inputIdx}:v]overlay=x=0:y=0:format=auto:enable='${enable}'[${outLabel}]`);
    prev = outLabel;
  });
  return parts.join(";");
}

export function buildFastSegmentArgs(spec: FastSegmentSpec): string[] {
  const gop = Math.max(1, Math.round(spec.fps * 2));
  const args = ["-y", "-v", "error", "-i", spec.cutPath];
  for (const c of spec.captions) args.push("-i", c.pngPath);
  args.push(
    "-filter_complex",
    buildFastSegmentFilter(spec),
    "-map",
    "[vout]",
    "-an",
    "-c:v",
    "h264_videotoolbox",
    "-profile:v",
    "high",
    "-b:v",
    "8000k",
    "-video_track_timescale",
    "90000",
    "-color_range",
    "pc",
    "-colorspace",
    "smpte170m",
    "-g",
    String(gop),
    "-forced-idr",
    "1",
    "-force_key_frames",
    "expr:eq(n,0)",
    spec.outPath,
  );
  return args;
}
// クォーティング注意(直さないこと): run は execFile(シェルを経由しない)
// なので、enable='between(n,30,119)' の単引用符は shell が解釈するのでは
// なく ffmpeg 自身の filtergraph パーサがカンマを区切りと誤認しないよう
// 保護するためのもの。文字列にそのまま残す。

// ---- 出力パス ----

export function fastSegmentPath(dir: string, index: number): string {
  return join(dir, FAST_SEGMENT_DIR, `seg${String(index).padStart(3, "0")}.mp4`);
}

// ---- 不純関数: 実行 ----

export async function renderFastSegment(args: {
  dir: string;
  props: RenderProps;
  span: FastSpan;
  index: number;
  warm: WarmAssets;
}): Promise<string> {
  const { dir, props, span, index, warm } = args;
  if (span.kind !== "fast") throw new Error("renderFastSegment は fast span 専用です");
  const placements = resolveFastCaptions(props, span);
  const withPng: FastSegmentSpec["captions"] = [];
  for (const p of placements) {
    const stillProps: CaptionStillProps = {
      width: props.width,
      height: props.height,
      caption: p.caption,
      defaults: props.caption,
      captionDefaultPos: props.captionDefaultPos,
      cameraRegion: props.cameraRegion,
      wipe: props.wipe,
    };
    const pngPath = await renderCaptionStill({ dir, caption: stillProps, warm });
    withPng.push({ pngPath, enableWindows: p.enableWindows });
  }
  const outPath = fastSegmentPath(dir, index);
  mkdirSync(dirname(outPath), { recursive: true });
  await run(
    "ffmpeg",
    buildFastSegmentArgs({
      cutPath: join(dir, props.videoFile),
      outPath,
      fromFrame: span.fromFrame,
      toFrame: span.toFrame,
      fps: props.fps,
      captions: withPng,
    }),
  );
  return outPath;
}
