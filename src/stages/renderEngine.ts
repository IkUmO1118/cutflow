// src/stages/renderEngine.ts — M4 Phase1: エンジン書き出しの CLI 側実装。
// src/lib/engineSession.ts の共有ヘッドレス Chrome セッションを使い、
// フレームごとの CDP スクリーンショットを ffmpeg に流して中間体 mp4 を生成、
// 既存音声ベッドと mux して final.mp4 を出力する。
//
// 音声は既存の BGM ミックス経路をそのまま流用し、WebAudio 経由では扱わない
// (決定性と GPU 経路分離のため)。
import {
  existsSync, mkdtempSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRenderProps } from "../lib/renderProps.ts";
import { mixFastAudio } from "../lib/bgmMix.ts";
import { mixInsertAudio } from "../lib/insertMix.ts";
import { run } from "../lib/exec.ts";
import { timed } from "../lib/timing.ts";
import { renderCfgWithDesign } from "../lib/designAsset.ts";
import { prepareDesignAssetsForProps } from "../lib/designStill.ts";
import { resolveProfile } from "../lib/profile.ts";
import { compositionDurationInFrames } from "../lib/renderFrameMath.ts";
import { createEngineSession } from "../lib/engineSession.ts";
import { startFramePipe } from "../lib/framePipe.ts";
import { sourceUrlsOf } from "../lib/engineStill.ts";
import type { Config } from "../lib/config.ts";
import type { RenderProps } from "../lib/renderPropsTypes.ts";
import type {
  CutPlan, Manifest, Overlays, Transcript, Bgm, AutoCuts,
} from "../types.ts";

export interface EngineRenderResult {
  intermediatePath: string;
  finalPath: string;
  frameCount: number;
}

export async function renderEngineFromProps(args: {
  dir: string;
  props: RenderProps;
  cutPath: string;
  outPath: string;
  label?: string;
}): Promise<EngineRenderResult> {
  const { dir, props, cutPath, outPath } = args;
  const totalFrames = compositionDurationInFrames(props.durationSec, props.fps);
  const fps = props.fps;
  const outputWidth = props.width;
  const outputHeight = props.height;

  console.log(`エンジン書き出し: ${totalFrames}フレーム ${fps}fps ${outputWidth}x${outputHeight}`);

  // Source URL マップ (engineDev.ts と同じパターン)
  const sourceUrls = sourceUrlsOf(props);

  const session = await createEngineSession(dir, { props, sourceUrls });

  try {
    const tempDir = mkdtempSync(join(tmpdir(), "framewright-engine-export-"));
    const intermediatePath = join(tempDir, "intermediate.mp4");

    // ffmpeg pipeline: image2pipe stdin → intermediate mp4
    const framePipe = startFramePipe({ fps, outPath: intermediatePath });

    console.log(`フレーム書き出し中(${totalFrames}フレーム)…`);
    const progressInterval = Math.max(1, Math.floor(totalFrames / 20));

    for (let f = 0; f < totalFrames; f++) {
      const tOut = f / fps;
      const pngBase64 = await session.renderAndCapture(tOut);
      const pngBuf = Buffer.from(pngBase64, "base64");
      await framePipe.write(pngBuf);

      if (f > 0 && f % progressInterval === 0) {
        process.stderr.write(`  進行 ${((f / totalFrames) * 100).toFixed(0)}% (${f}/${totalFrames})\r`);
      }
    }
    process.stderr.write(`  進行 100% (${totalFrames}/${totalFrames})\n`);
    await framePipe.finish();

    // 音声ベッド + final mux
    const audioM4a = join(tempDir, "audio.m4a");
    const hasInserts = (props.inserts?.length ?? 0) > 0;
    await timed("エンジン audio", () =>
      hasInserts
        ? mixInsertAudio({ dir, props, cutPath, outM4a: audioM4a })
        : mixFastAudio({ dir, props, cutPath, outM4a: audioM4a }),
    );

    await timed("エンジン mux", () =>
      run("ffmpeg", [
        "-y", "-v", "error",
        "-i", intermediatePath,
        "-i", audioM4a,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-movflags", "+faststart",
        outPath,
      ]),
    );

    console.log(`エンジン書き出し完了: ${outPath}`);
    return { intermediatePath, finalPath: outPath, frameCount: totalFrames };
  } finally {
    await session.close();
  }
}

export async function renderEngine(
  dir: string,
  cfg: Config,
  manifest: Manifest,
  cutplan: CutPlan,
  transcript: Transcript,
  overlaysIn: Overlays,
  cutPath: string,
  outPath: string,
): Promise<EngineRenderResult> {
  const keeps = cutplan.segments.filter((s) => s.action === "keep");

  const bgmPath = join(dir, "bgm.json");
  const bgm = existsSync(bgmPath) ? (JSON.parse(readFileSync(bgmPath, "utf8")) as Bgm) : null;
  const bgmFile = ["bgm.mp3", "bgm.m4a", "bgm.wav"].find((f) => existsSync(join(dir, f))) ?? null;

  const autoCutsPath = join(dir, "cuts.auto.json");
  const silences = existsSync(autoCutsPath)
    ? (JSON.parse(readFileSync(autoCutsPath, "utf8")) as AutoCuts).silences
    : null;

  const profile = resolveProfile(manifest.video.screenRegion, "default");
  const isStills = manifest.layout === "stills";
  const sourceFile = isStills ? "" : manifest.source;

  let props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays: overlaysIn,
    renderCfg: renderCfgWithDesign(dir, cfg),
    width: profile.width,
    height: profile.height,
    videoFile: sourceFile,
    videoIsSource: !isStills,
    bgm,
    bgmFallbackFile: bgmFile,
    silences,
    overlayExists: (f) => existsSync(join(dir, f)),
    warn: (msg) => console.warn(`警告: ${msg}`),
  });

  props = await timed("design静的資産準備", () =>
    prepareDesignAssetsForProps({
      dir,
      props,
      warn: (message) => console.warn(`警告: ${message}`),
    }),
  );

  return renderEngineFromProps({
    dir,
    props,
    cutPath,
    outPath,
    label: "本編",
  });
}
