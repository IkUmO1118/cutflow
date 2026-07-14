// lib/fastRender.ts — render 高速パスのハイブリッド組み立て(P3)。
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec.ts";
import { concatChunks, muxVideoAudio, verifyAssembled } from "./chunkCache.ts";
import { mixFastAudio } from "./bgmMix.ts";
import { mixInsertAudio } from "./insertMix.ts";
import { fastPlan } from "./fastPlan.ts";
import { renderFastSegment, fastSegmentPath, FAST_SEGMENT_DIR } from "./fastSegment.ts";
import { withCaptionStillAssets } from "./captionStill.ts";
import { resolveFastPathCfg } from "./config.ts";
import type { FastBaseCapability } from "./fastBaseCapability.ts";
import type { FastPlan, FastSpan } from "./fastPlan.ts";
import type { Config } from "./config.ts";
import type { RenderProps } from "../../remotion/props.ts";

export type FastPathDecision =
  | { activate: true; plan: FastPlan }
  | { activate: false; reason: string };

export function decideFastPath(args: {
  props: RenderProps;
  cfg: Config;
  base: FastBaseCapability;
}): FastPathDecision {
  const { props, cfg, base } = args;
  const { enabled, minCoverage } = resolveFastPathCfg(cfg);
  if (!enabled) return { activate: false, reason: "fastPath 無効" };
  if (!base.ok) return { activate: false, reason: base.reason };
  // P1-1は能力ゲートだけを導入する。design/plain graphがrunFastRenderへ
  // 接続される前に誤って既存composite graphを使わないための内部境界。
  if (base.mode !== "composite") {
    return { activate: false, reason: `${base.mode}基底graph未接続` };
  }
  const plan = fastPlan(props);
  if (!plan.eligible) return { activate: false, reason: `適格外: ${plan.wholeFallback.join("/")}` };
  if (!plan.audioFastEligible) return { activate: false, reason: `音声適格外: ${plan.audioFallback.join("/")}` };
  if (plan.coverageRatio < minCoverage) {
    return { activate: false, reason: `被覆率 ${(plan.coverageRatio * 100).toFixed(1)}% < 閾値 ${(minCoverage * 100).toFixed(0)}%` };
  }
  return { activate: true, plan };
}

export function buildSlowSegmentRemotionArgs(args: {
  propsPath: string; publicDir: string; outPath: string; fromFrame: number; toFrame: number;
  hardwareAcceleration: string; resourceArgs: string[];
}): string[] {
  const { propsPath, publicDir, outPath, fromFrame, toFrame, hardwareAcceleration, resourceArgs } = args;
  return [
    "remotion", "render", "remotion/index.ts", "Main", outPath,
    "--props", propsPath, "--public-dir", publicDir,
    "--codec", "h264", "--hardware-acceleration", hardwareAcceleration,
    ...resourceArgs, `--frames=${fromFrame}-${toFrame - 1}`, "--muted",
  ];
}

export interface FastJob { index: number; span: FastSpan; outPath: string; }
export function orderedFastJobs(dir: string, plan: FastPlan): FastJob[] {
  return plan.spans.map((span, index) => ({ index, span, outPath: fastSegmentPath(dir, index) }));
}

export async function runFastRender(args: {
  dir: string; props: RenderProps; plan: FastPlan; cutPath: string; propsPath: string;
  outPath: string; hardwareAcceleration: string; repoRoot: string; resourceArgs: string[];
}): Promise<boolean> {
  const { dir, props, plan, cutPath, propsPath, outPath, hardwareAcceleration, repoRoot, resourceArgs } = args;
  const fastDir = join(dir, "render.fast");
  const segDir = join(dir, FAST_SEGMENT_DIR);
  const assembledVideo = join(fastDir, ".assembled-video.mp4");
  const audioM4a = join(fastDir, "audio.m4a");
  const tempFinal = join(dir, ".final.fast.tmp.mp4");
  try {
    rmSync(segDir, { recursive: true, force: true });
    mkdirSync(segDir, { recursive: true });
    const jobs = orderedFastJobs(dir, plan);
    await withCaptionStillAssets(dir, async (warm) => {
      for (const job of jobs) {
        if (job.span.kind === "fast") {
          await renderFastSegment({ dir, props, span: job.span, index: job.index, warm });
        } else {
          await run("npx", buildSlowSegmentRemotionArgs({
            propsPath, publicDir: dir, outPath: job.outPath,
            fromFrame: job.span.fromFrame, toFrame: job.span.toFrame, hardwareAcceleration, resourceArgs,
          }), { cwd: repoRoot, label: "remotion" });
        }
      }
    });
    await concatChunks(jobs.map((j) => j.outPath), assembledVideo);
    // 挿入があれば PCM 領域でベース・挿入・BGM を1本に組み立てる insert-mix
    // (design-T4.md §3-D)。挿入が無い収録は従来どおり mixFastAudio のまま
    // (P4 で LUFS 検証済みの経路を触らないための意図的な二経路)
    await (plan.audioMode === "insert-mix"
      ? mixInsertAudio({ dir, props, cutPath, outM4a: audioM4a })
      : mixFastAudio({ dir, props, cutPath, outM4a: audioM4a }));
    await muxVideoAudio(assembledVideo, audioM4a, tempFinal);
    const verify = await verifyAssembled(
      tempFinal,
      plan.totalFrames,
      plan.totalFrames / props.fps,
      props.fps,
    );
    if (!verify.ok) {
      console.warn(`render 高速パス: 検証に失敗したためフルレンダーへ: ${verify.reason}`);
      rmSync(fastDir, { recursive: true, force: true });
      return false;
    }
    renameSync(tempFinal, outPath);
    const slowCount = jobs.filter((j) => j.span.kind === "slow").length;
    console.log(`render 高速パス: FAST ${jobs.length - slowCount} / SLOW ${slowCount} セグメント(被覆 ${(plan.coverageRatio * 100).toFixed(1)}%, 音声 ${plan.audioMode})`);
    return true;
  } catch (err) {
    console.warn(`render 高速パス: 失敗したためフルレンダーへ: ${(err as Error).message}`);
    rmSync(fastDir, { recursive: true, force: true });
    return false;
  } finally {
    rmSync(assembledVideo, { force: true });
    rmSync(audioM4a, { force: true });
    rmSync(tempFinal, { force: true });
  }
}
