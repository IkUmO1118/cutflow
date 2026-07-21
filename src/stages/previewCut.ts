import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run } from "../lib/exec.ts";
import { parseFps, probe, type ProbeResult } from "../lib/ffmpeg.ts";
import { atempoFilters } from "../lib/loudness.ts";
import {
  PREVIEW_CUT_AUDIO_ARGS,
  PREVIEW_CUT_FILE,
  PREVIEW_CUT_KEY_FILE,
  buildPreviewCutCacheKey,
  inspectPreviewCutFreshness,
  type PreviewCutCacheKey,
  type PreviewCutSidecar,
} from "../lib/previewCutCache.ts";
import {
  captureSnapshot,
  publishAsTransaction,
  type PublishTransactionOptions,
} from "../lib/renderTransaction.ts";
import { playbackSegmentsOf, type PlaybackSegment } from "../lib/timeline.ts";
import { videoEncodeArgs } from "../lib/videoEncode.ts";
import { isProxyStale } from "./proxy.ts";
import type { Config } from "../lib/config.ts";
import { manifestCompositionFps, type CutPlan, type Manifest } from "../types.ts";

interface PreviewCutProbeExpectation {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  videoFrames: number;
}

const AAC_FRAME_SAMPLES = 1024;
const PREVIEW_CUT_AUDIO_SAMPLE_RATE = 48000;

export interface PreviewCutFrameSegment {
  sourceStartFrame: number;
  sourceEndFrame: number;
  outputFrames: number;
  speed: number;
}

export interface PreviewCutResult {
  path: string;
  reused: boolean;
  key: PreviewCutCacheKey;
}

export interface PreviewCutDependencies {
  run?: typeof run;
  probe?: typeof probe;
  isProxyStale?: typeof isProxyStale;
  publish?: (opts: PublishTransactionOptions) => Promise<void>;
  writeSidecar?: (path: string, sidecar: PreviewCutSidecar) => void;
}

function validateKeeps(keeps: PlaybackSegment[]): void {
  if (keeps.length === 0) throw new Error("keep 区間が0件です(cutplan を確認してください)");
  for (const keep of keeps) {
    if (!Number.isFinite(keep.start) || !Number.isFinite(keep.end) ||
        !Number.isFinite(keep.speed) || keep.start < 0 ||
        keep.end <= keep.start || keep.speed <= 0) {
      throw new Error("preview cut に無効な keep 区間が含まれています");
    }
  }
}

/**
 * source start は Main.tsx の Math.round(videoStart*fps)、output span は
 * frameSpans と同じ累積境界の Math.round へ合わせる。各区間を最低1 frameに
 * する規則もSequenceと同じで、秒trim由来の区間別driftを生成前に消す。
 */
export function previewCutFrameSegments(
  keeps: readonly PlaybackSegment[],
  fps: number,
): PreviewCutFrameSegment[] {
  let outputSec = 0;
  return keeps.map((keep) => {
    const sourceStartFrame = Math.round(keep.start * fps);
    const outputStartFrame = Math.round(Math.round(outputSec * 100) / 100 * fps);
    outputSec += (keep.end - keep.start) / keep.speed;
    const outputEndFrame = Math.round(Math.round(outputSec * 100) / 100 * fps);
    const outputFrames = Math.max(1, outputEndFrame - outputStartFrame);
    return {
      sourceStartFrame,
      // Player は startFromFrames から composition frame ごとに speed 倍だけ
      // source を進める。独立した keep.end で先に切ると端数 speed で不足する
      // ため、実際の消費範囲に補間用の安全1 frameを加えて供給する。
      sourceEndFrame: Math.ceil(sourceStartFrame + outputFrames * keep.speed) + 1,
      outputFrames,
      speed: keep.speed,
    };
  });
}

export function previewCutCadenceCompatible(
  rFrameRate: string | undefined,
  compositionFps: number,
): boolean {
  const nominalFps = parseFps(rFrameRate);
  return nominalFps > 0 && Math.abs(nominalFps - compositionFps) < 1e-6;
}

/** frame数を厳密検査した後のcontainer/audio量子化だけを許す。 */
export function previewCutDurationTolerance(fps: number): number {
  return Math.max(0.1, 2 / fps + AAC_FRAME_SAMPLES / PREVIEW_CUT_AUDIO_SAMPLE_RATE);
}

/** ffprobe 結果の評価を純粋関数に分け、stream 数・寸法・尺許容差を固定する。 */
export function evaluatePreviewCutProbe(
  result: ProbeResult,
  expected: PreviewCutProbeExpectation,
): { ok: true } | { ok: false; reason: string } {
  const videos = result.streams.filter((stream) => stream.codec_type === "video");
  const audios = result.streams.filter((stream) => stream.codec_type === "audio");
  if (videos.length !== 1) {
    return { ok: false, reason: `video stream が1本ではありません(${videos.length}本)` };
  }
  if (audios.length !== 1) {
    return { ok: false, reason: `audio stream が1本ではありません(${audios.length}本)` };
  }
  const video = videos[0];
  if (video.width !== expected.width || video.height !== expected.height) {
    return {
      ok: false,
      reason: `proxy と解像度が一致しません(期待 ${expected.width}x${expected.height}、実測 ${video.width}x${video.height})`,
    };
  }
  const videoFrames = Number(video.nb_frames);
  if (!Number.isInteger(videoFrames) || videoFrames !== expected.videoFrames) {
    return {
      ok: false,
      reason: `video frame 数が期待値と一致しません(期待 ${expected.videoFrames}、実測 ${video.nb_frames ?? "不明"})`,
    };
  }
  const duration = Number(result.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, reason: "正の duration を取得できませんでした" };
  }
  const tolerance = previewCutDurationTolerance(expected.fps);
  if (Math.abs(duration - expected.durationSec) > tolerance + 1e-9) {
    return {
      ok: false,
      reason: `duration が期待値から外れています(期待 ${expected.durationSec}秒、実測 ${duration}秒、許容 ${tolerance}秒)`,
    };
  }
  return { ok: true };
}

function expectationFromProxy(
  proxyProbe: ProbeResult,
  keeps: PlaybackSegment[],
  compositionFps: number,
): PreviewCutProbeExpectation {
  const videos = proxyProbe.streams.filter((stream) => stream.codec_type === "video");
  const audios = proxyProbe.streams.filter((stream) => stream.codec_type === "audio");
  if (videos.length !== 1 || audios.length !== 1) {
    throw new Error("proxy.mp4 は video/audio stream を各1本持つ必要があります");
  }
  const video = videos[0];
  if (!video.width || !video.height) {
    throw new Error("proxy.mp4 の解像度を取得できませんでした");
  }
  if (!previewCutCadenceCompatible(video.r_frame_rate, compositionFps)) {
    throw new Error(
      `proxy.mp4 の cadence (${video.r_frame_rate ?? "不明"}) が composition fps (${compositionFps}) と互換ではありません`,
    );
  }
  const frameSegments = previewCutFrameSegments(keeps, compositionFps);
  const videoFrames = frameSegments.reduce((sum, segment) => sum + segment.outputFrames, 0);
  return {
    width: video.width,
    height: video.height,
    fps: compositionFps,
    durationSec: videoFrames / compositionFps,
    videoFrames,
  };
}

function filterGraph(segments: PreviewCutFrameSegment[], fps: number): string {
  const parts: string[] = [];
  const labels: string[] = [];
  segments.forEach((segment, index) => {
    const setpts = segment.speed === 1
      ? "PTS-STARTPTS"
      : `(PTS-STARTPTS)/${segment.speed}`;
    parts.push(
      `[0:v]trim=start_frame=${segment.sourceStartFrame}:end_frame=${segment.sourceEndFrame},` +
        `setpts=${setpts},fps=${fps},tpad=stop_mode=clone:stop=-1,` +
        `trim=end_frame=${segment.outputFrames},setpts=PTS-STARTPTS[v${index}]`,
    );
    const tempo = atempoFilters(segment.speed).map((rate) => `atempo=${rate}`).join(",");
    const sourceStart = segment.sourceStartFrame / fps;
    const outputDuration = segment.outputFrames / fps;
    parts.push(
      `[0:a:0]atrim=start=${sourceStart},asetpts=PTS-STARTPTS${
        tempo ? `,${tempo}` : ""
      },apad=pad_dur=${outputDuration},atrim=duration=${outputDuration},` +
        `asetpts=PTS-STARTPTS[a${index}]`,
    );
    labels.push(`[v${index}][a${index}]`);
  });
  parts.push(`${labels.join("")}concat=n=${segments.length}:v=1:a=1[vout][aout]`);
  return parts.join(";");
}

function writeSidecarAtomically(path: string, sidecar: PreviewCutSidecar): void {
  const temp = join(dirname(path), `.${basename(path)}.publish-${process.pid}.tmp.json`);
  try {
    writeFileSync(temp, JSON.stringify(sidecar, null, 2));
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * 非 stale の proxy.mp4 から keep+speed だけを焼いた editor preview 用連続映像を作る。
 * editable JSON と approvals は一切書かず、同一キーなら既存成果物を再利用する。
 */
export async function buildPreviewCut(
  dir: string,
  cfg: Config,
  cutplan: CutPlan,
  deps: PreviewCutDependencies = {},
): Promise<PreviewCutResult> {
  const proxyPath = join(dir, "proxy.mp4");
  const outputPath = join(dir, PREVIEW_CUT_FILE);
  const keyPath = join(dir, PREVIEW_CUT_KEY_FILE);
  const proxyIsStale = deps.isProxyStale ?? isProxyStale;
  if (proxyIsStale(dir, cfg)) {
    throw new Error("proxy.mp4 が古いため preview cut を生成できません");
  }

  const keeps = playbackSegmentsOf(cutplan);
  validateKeeps(keeps);
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const compositionFps = manifestCompositionFps(manifest);
  const proxySnapshot = captureSnapshot(proxyPath);
  const videoArgs = videoEncodeArgs(cfg);
  const key = buildPreviewCutCacheKey({
    cfg,
    cutplan,
    proxyFile: "proxy.mp4",
    proxyMtimeMs: proxySnapshot.mtimeMs,
    proxySize: proxySnapshot.size,
    compositionFps,
    videoArgs,
    audioArgs: PREVIEW_CUT_AUDIO_ARGS,
  });
  if (inspectPreviewCutFreshness({ dir, currentKey: key, proxyFresh: true }).fresh) {
    return { path: outputPath, reused: true, key };
  }

  const probeFile = deps.probe ?? probe;
  const expectation = expectationFromProxy(await probeFile(proxyPath), keeps, compositionFps);
  const frameSegments = previewCutFrameSegments(keeps, compositionFps);
  const runCommand = deps.run ?? run;
  const publish = deps.publish ?? publishAsTransaction;
  const writeSidecar = deps.writeSidecar ?? writeSidecarAtomically;
  await publish({
    finalPath: outputPath,
    inputs: [proxySnapshot],
    produce: async (tempPath) => {
      await runCommand("ffmpeg", [
        "-y", "-v", "error",
        "-i", proxyPath,
        "-filter_complex", filterGraph(frameSegments, expectation.fps),
        "-map", "[vout]", "-map", "[aout]",
        "-fps_mode", "cfr",
        ...videoArgs,
        ...PREVIEW_CUT_AUDIO_ARGS,
        tempPath,
      ]);
    },
    verify: async (tempPath) => evaluatePreviewCutProbe(await probeFile(tempPath), expectation),
    commit: () => {
      const outputStat = statSync(outputPath);
      writeSidecar(keyPath, {
        key,
        output: { mtimeMs: outputStat.mtimeMs, size: outputStat.size },
      });
    },
  });
  return { path: outputPath, reused: false, key };
}
