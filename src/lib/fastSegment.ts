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
import { capNum, DEFAULT_LAYER_ORDER } from "../types.ts";
import type { FastSpan } from "./fastPlan.ts";
import type { WarmAssets } from "../stages/frames.ts";
import type { Caption, RenderProps } from "../../remotion/props.ts";
import type { CaptionStillProps } from "../../remotion/CaptionStill.tsx";

const FRAME_EPS = 1e-6;

export const FAST_SEGMENT_DIR = "render.fast/segments";

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
  captions: { pngPath: string; enableWindows: EnableWindow[] }[];
}

// ---- 純関数: フレーム換算 ----

// Main.tsx はフレーム f (t=f/fps) でテロップを表示する条件を
// start<=t<end としている(lookupCaption)。ceil(sec*fps - EPS) は
// 「t>=sec となる最小の整数フレーム」を浮動小数誤差に強い形で求める式
// (sec がちょうど frame/fps のとき丸め誤差で1フレームずれるのを防ぐ)。
// 返り値は絶対フレーム番号の半開区間 [from,to)。
function captionFrameRange(startSec: number, endSec: number, fps: number): [number, number] {
  return [Math.ceil(startSec * fps - FRAME_EPS), Math.ceil(endSec * fps - FRAME_EPS)];
}

// 区間 [from,to) から hides(隠す区間の集合)を標準的な区間減算で除く。
// hides は昇順である必要はない(順に減算していくだけで良い)。
function subtractHides(from: number, to: number, hides: [number, number][]): [number, number][] {
  let segs: [number, number][] = [[from, to]];
  for (const [hf, ht] of hides) {
    const next: [number, number][] = [];
    for (const [a, b] of segs) {
      if (ht <= a || hf >= b) {
        next.push([a, b]);
        continue;
      }
      if (hf > a) next.push([a, Math.min(hf, b)]);
      if (ht < b) next.push([Math.max(ht, a), b]);
    }
    segs = next;
  }
  return segs.filter(([a, b]) => b > a);
}

/** span 内で表示されるテロップと、その enable 窓(セグメント内ローカル・
 * フレーム番号)を解決する。Main.tsx の z-order(layerOrder)+可視性判定
 * (lookupCaption: トラックごとに最新1件だけを表示)を静的解析で再現する。
 *
 * 既知の制約(v1・意図的に対応しない。P3/P5 で見直す): 同一トラックの
 * テロップは独立に処理する。Main.tsx はフレームごとにトラック内で1件
 * だけを表示する(lookupCaption)ため、整形されたデータ(同一トラック内で
 * 時間的に重ならない)なら本関数の出力は Main.tsx の表示と一致するが、
 * 手編集で同一トラック内に時間重なりを作った場合は本関数(重なった両方を
 * 独立に overlay する)と Main.tsx(片方だけ表示)の結果が食い違いうる。
 * PSNR ガードにより破綻すれば SLOW へフォールバックする設計なので v1 では
 * 許容する。 */
export function resolveFastCaptions(props: RenderProps, span: FastSpan): FastCaptionPlacement[] {
  const fps = props.fps;
  const order = props.layerOrder ?? DEFAULT_LAYER_ORDER;
  const hides = (props.hideCaption ?? []).map((h) => captionFrameRange(h.start, h.end, fps));
  const out: FastCaptionPlacement[] = [];
  for (const id of order) {
    const track = capNum(id);
    if (track === null) continue;
    const onTrack = props.captions
      .filter((c) => (c.track ?? 1) === track)
      .map((c) => {
        const [rf, rt] = captionFrameRange(c.start, c.end, fps);
        return { c, from: Math.max(rf, span.fromFrame), to: Math.min(rt, span.toFrame) };
      })
      .filter((x) => x.to > x.from)
      .sort((a, b) => a.from - b.from || a.to - b.to);
    for (const x of onTrack) {
      if (x.c.style?.anim || x.c.style?.karaoke) {
        throw new Error(
          `FAST span[${span.fromFrame},${span.toFrame}) に anim/karaoke テロップが混入(start=${x.c.start})`,
        );
      }
      const windows: EnableWindow[] = subtractHides(x.from, x.to, hides).map(
        ([a, b]) => [a - span.fromFrame, b - span.fromFrame - 1],
      );
      if (windows.length > 0) out.push({ caption: x.c, enableWindows: windows });
    }
  }
  return out;
}

// ---- 純関数: filtergraph / argv 組み立て ----

export function buildFastSegmentFilter(spec: FastSegmentSpec): string {
  // setpts=N/fps/TB は「フレーム番号 N で CFR に再スタンプ」する(PTS-STARTPTS
  // では cut.mp4 の可変フレームレート=実測 avg 29.94fps がそのまま残り、
  // frame 数は正しいのに container duration が伸びて concat 後に Remotion
  // セグメント(厳密 30fps CFR)と食い違い verifyAssembled の duration 判定で
  // 落ちる)。N は frame 序数なので trim 済みフレームの内容・順序・overlay の
  // n ベース enable 窓は不変=描画は完全に同じで、タイムスタンプだけを厳密
  // 30fps に揃える。これで各セグメントが frames/fps ちょうどの尺になり、
  // FAST(ffmpeg)+SLOW(Remotion)の混在 concat でも duration が一致する。
  const base = `[0:v]trim=start_frame=${spec.fromFrame}:end_frame=${spec.toFrame},setpts=N/${spec.fps}/TB,${BASE_COLOR_FILTER}`;
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
