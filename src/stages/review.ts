import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveAvCfg } from "../lib/config.ts";
import { resolveAiReviewCfg } from "../lib/config.ts";
import { run } from "../lib/exec.ts";
import { detectSilence, probe } from "../lib/ffmpeg.ts";
import { runOcr as defaultRunOcr } from "../lib/ocr.ts";
import { buildDeterministicObservation, structureObservationOf } from "../lib/reviewObservation.ts";
import {
  normalizeReviewSpec,
  validateReviewSpec,
  type EditSnapshot,
  type NormalizedReviewFrameRequest,
  type ReviewSpec,
} from "../lib/review.ts";
import { resolveSnapshotRenderContext } from "../lib/renderSnapshot.ts";
import { captureEngineStills, sourceUrlsOf } from "../lib/engineStill.ts";
import { createEngineSession } from "../lib/engineSession.ts";
import { startFramePipe } from "../lib/framePipe.ts";
import {
  parseAstats,
  parseEbur128,
  parseFreezedetect,
  parseScdet,
} from "../lib/avParse.ts";
import {
  buildTimeline,
  snapToOutput,
  toOutputTime,
  toSourceTime,
} from "../lib/timeline.ts";
import { validateDocs } from "./validate.ts";
import type { Config } from "../lib/config.ts";
import { outputSize } from "../lib/profile.ts";
import type { DeterministicReviewObservation, SideObservation } from "../lib/reviewObservation.ts";
import type { RenderProps } from "../lib/renderPropsTypes.ts";
import type { Manifest, Overlays } from "../types.ts";
import {
  MAX_SECONDARY_OUTPUT_TOKENS,
  type SecondaryObservation,
  type SecondaryObservationProvider,
  VlmSecondaryObservationProvider,
  selectSecondaryObservationFrames,
} from "../lib/vlmObservation.ts";
import { supportsImageReview } from "../lib/llm.ts";

const REVIEW_DIR = "review.probe";

export interface ReviewStillSide {
  outSec: number;
  sourceSec: number | null;
  file: string;
  ocrFile?: string;
  note?: string;
}

export interface ReviewStill {
  requested: NormalizedReviewFrameRequest;
  before: ReviewStillSide;
  after: ReviewStillSide;
}

export interface ReviewKey {
  proposalId?: string;
  baseHash: string;
  candidateHash: string;
  acceptedLabelsHash?: string;
  acceptedLabels?: string[];
  specHash: string;
}

export interface ReviewBundle {
  schemaVersion: 1;
  createdAt: string;
  key: ReviewKey;
  range: {
    source?: { startSec: number; endSec: number };
    beforeOutput?: { startSec: number; endSec: number };
    afterOutput?: { startSec: number; endSec: number };
  };
  stills: ReviewStill[];
  clips?: {
    beforeFile?: string;
    afterFile?: string;
  };
  observation: DeterministicReviewObservation;
  secondaryObservation?: SecondaryObservation;
  warnings: string[];
}

export interface ReviewHooks {
  renderStill?: (args: {
    side: "before" | "after";
    outFile: string;
    outSec: number;
    props: Record<string, unknown>;
  }) => Promise<void>;
  renderClip?: (args: {
    side: "before" | "after";
    outFile: string;
    startFrame: number;
    endFrame: number;
    props: Record<string, unknown>;
  }) => Promise<void>;
  analyzeMotion?: (file: string) => Promise<SideObservation["motion"] | null>;
  analyzeSound?: (file: string) => Promise<SideObservation["sound"] | null>;
  runOcr?: typeof defaultRunOcr;
}

export interface ReviewOptions {
  secondaryObservation?: "none" | "vlm";
  provider?: SecondaryObservationProvider;
  hooks?: ReviewHooks;
}

interface ReviewRenderContext {
  manifest: Manifest;
  fps: number;
  durationSec: number;
  props: RenderProps;
  timeline: ReturnType<typeof buildTimeline>;
}

export async function reviewEdit(
  dir: string,
  cfg: Config,
  base: EditSnapshot,
  candidate: EditSnapshot,
  spec: ReviewSpec,
  opts: ReviewOptions = {},
): Promise<ReviewBundle> {
  const specErrors = validateReviewSpec(spec);
  if (specErrors.length > 0) {
    throw new Error(specErrors.map((error) => `${error.where}: ${error.message}`).join(" / "));
  }
  const fullRes = spec.frames.some((frame) => frame.fullRes === true);
  const beforeCtx = buildReviewRenderContext(dir, cfg, base, fullRes);
  const afterCtx = buildReviewRenderContext(dir, cfg, candidate, fullRes);
  const normalized = normalizeReviewSpec(spec, {
    sourceDurationSec: beforeCtx.manifest.durationSec,
    baseOutputDurationSec: beforeCtx.durationSec,
    candidateOutputDurationSec: afterCtx.durationSec,
  });
  const candidateValidate = validateDocs(dir, {
    manifest: beforeCtx.manifest,
    cutplan: candidate.cutplan,
    transcript: candidate.transcript,
    overlays: candidate.overlays,
    bgm: candidate.bgm,
    chapters: null,
    meta: null,
    thumbnail: null,
  });
  const warnings = [...normalized.warnings];
  const outDir = join(dir, REVIEW_DIR);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "before"), { recursive: true });
  mkdirSync(join(outDir, "after"), { recursive: true });
  mkdirSync(join(outDir, "ocr"), { recursive: true });

  const runOcr = opts.hooks?.runOcr ?? defaultRunOcr;
  const stills = await renderReviewStills({
    dir,
    outDir,
    beforeCtx,
    afterCtx,
    frames: normalized.frames,
    hooks: opts.hooks,
    runOcr,
    warnings,
  });

  const needDerivedClip =
    normalized.clip !== null || normalized.observations.motion || normalized.observations.sound;
  const clipFiles = needDerivedClip
    ? await renderReviewClips({
        outDir,
        beforeCtx,
        afterCtx,
        clip: normalized.clip ?? {
          range: normalized.range,
          includeBefore: true,
          includeAfter: true,
        },
        keepArtifacts: normalized.clip !== null,
        hooks: opts.hooks,
        warnings,
      })
    : {};

  const beforeObservation = structureObservationOf(base, beforeCtx.props as never);
  const afterObservation = structureObservationOf(candidate, afterCtx.props as never);
  if (normalized.observations.motion) {
    beforeObservation.motion = clipFiles.beforeFile
      ? (await analyzeMotion(clipFiles.beforeFile, cfg, opts.hooks)) ?? undefined
      : undefined;
    afterObservation.motion = clipFiles.afterFile
      ? (await analyzeMotion(clipFiles.afterFile, cfg, opts.hooks)) ?? undefined
      : undefined;
  }
  if (normalized.observations.sound) {
    beforeObservation.sound = clipFiles.beforeFile
      ? (await analyzeSound(clipFiles.beforeFile, cfg, opts.hooks)) ?? undefined
      : undefined;
    afterObservation.sound = clipFiles.afterFile
      ? (await analyzeSound(clipFiles.afterFile, cfg, opts.hooks)) ?? undefined
      : undefined;
  }
  const requestedOcr = stills.some((still) => still.requested.ocr);
  const afterOcrLines = stills.flatMap((still) => still.after.ocrFile ? readOcrLines(join(dir, still.after.ocrFile)) : []);
  const beforeOcrLines = stills.flatMap((still) => still.before.ocrFile ? readOcrLines(join(dir, still.before.ocrFile)) : []);
  if (requestedOcr) {
    beforeObservation.ocr = { lines: beforeOcrLines };
    afterObservation.ocr = { lines: afterOcrLines };
  }
  const observation = buildDeterministicObservation({
    before: beforeObservation,
    after: afterObservation,
    validateErrors: candidateValidate.errors,
    unresolvedAfterFrames: stills.filter((still) => still.after.sourceSec === null).length,
    requestedOcr,
    ocrSupported: stills.some((still) => still.requested.ocr && still.after.ocrFile !== undefined),
  });
  warnings.push(...candidateValidate.warnings.map((warning) => `${warning.file} ${warning.where}: ${warning.message}`));
  let secondaryObservation: SecondaryObservation | undefined;
  if (opts.secondaryObservation === "vlm") {
    const aiReview = resolveAiReviewCfg(cfg);
    if (!aiReview.vlm) {
      warnings.push("VLM secondary observation は config editor.aiReview.vlm=false のため実行しませんでした");
    } else if (!supportsImageReview(cfg)) {
      warnings.push("現在のAI providerは画像secondary observationに対応していません");
    } else {
      try {
        const provider = opts.provider ?? new VlmSecondaryObservationProvider();
        const frames = selectSecondaryObservationFrames(
          stills.map((still) => ({
            requested: { reason: still.requested.reason },
            before: { file: join(dir, still.before.file), sourceSec: still.before.sourceSec, outSec: still.before.outSec },
            after: { file: join(dir, still.after.file), sourceSec: still.after.sourceSec, outSec: still.after.outSec },
          })),
          aiReview.maxImages,
        );
        if (frames.length === 0) {
          warnings.push("secondary observation 向け still がありませんでした");
        } else {
          secondaryObservation = await provider.observe({
            frames,
            primary: observation,
            task: {},
            budget: { maxImages: aiReview.maxImages, maxOutputTokens: MAX_SECONDARY_OUTPUT_TOKENS },
          }, cfg);
        }
      } catch (error) {
        warnings.push(`secondary observation に失敗しました: ${(error as Error).message}`);
      }
    }
  }
  const bundle: ReviewBundle = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    key: {
      baseHash: digest(base),
      candidateHash: digest(candidate),
      specHash: digest({ spec }),
    },
    range: {
      source: normalized.range.axis === "source" ? normalized.range : undefined,
      beforeOutput: mapRangeToOutput(normalized.range, beforeCtx.timeline),
      afterOutput: mapRangeToOutput(normalized.range, afterCtx.timeline),
    },
    stills,
    ...(normalized.clip !== null
      ? {
          clips: {
            ...(clipFiles.beforePublicFile ? { beforeFile: clipFiles.beforePublicFile } : {}),
            ...(clipFiles.afterPublicFile ? { afterFile: clipFiles.afterPublicFile } : {}),
          },
        }
      : {}),
    observation,
    ...(secondaryObservation ? { secondaryObservation } : {}),
    warnings,
  };
  const tmp = join(outDir, "index.json.tmp");
  writeFileSync(tmp, JSON.stringify(bundle, null, 2), "utf8");
  renameSync(tmp, join(outDir, "index.json"));
  return bundle;
}

function buildReviewRenderContext(
  dir: string,
  cfg: Config,
  snapshot: EditSnapshot,
  fullRes = false,
): ReviewRenderContext {
  const ctx = resolveSnapshotRenderContext({ dir, cfg, snapshot, fullRes });
  const inserts = (ctx.overlays.inserts ?? []).filter((insert) => existsSync(join(dir, insert.file)));
  return {
    manifest: ctx.manifest,
    fps: ctx.props.fps,
    durationSec: ctx.props.durationSec,
    props: ctx.props,
    timeline: buildTimeline(ctx.keeps, inserts),
  };
}

async function renderReviewStills(args: {
  dir: string;
  outDir: string;
  beforeCtx: ReviewRenderContext;
  afterCtx: ReviewRenderContext;
  frames: NormalizedReviewFrameRequest[];
  hooks?: ReviewHooks;
  runOcr: typeof defaultRunOcr;
  warnings: string[];
}): Promise<ReviewStill[]> {
  const { dir, outDir, beforeCtx, afterCtx, frames, hooks, runOcr, warnings } = args;
  if (hooks?.renderStill) {
    return renderReviewStillsWithHooks(args);
  }
  const targets = frames.map((frame) => {
    const before = resolveFrameTarget(frame, beforeCtx);
    const after = resolveFrameTarget(frame, afterCtx);
    const beforeFile = join(outDir, "before", fileLabel(frame, before.outSec));
    const afterFile = join(outDir, "after", fileLabel(frame, after.outSec));
    return { frame, before, after, beforeFile, afterFile };
  });
  if (targets.length === 0) return [];

  await captureEngineStills({
    dir,
    props: beforeCtx.props,
    durationSec: beforeCtx.durationSec,
    shots: targets.map((target) => ({ outSec: target.before.outSec, outFile: target.beforeFile })),
  });
  await captureEngineStills({
    dir,
    props: afterCtx.props,
    durationSec: afterCtx.durationSec,
    shots: targets.map((target) => ({ outSec: target.after.outSec, outFile: target.afterFile })),
  });

  const out: ReviewStill[] = [];
  for (const target of targets) {
    const beforeSide: ReviewStillSide = {
      outSec: target.before.outSec,
      sourceSec: target.before.sourceSec,
      file: rel(target.beforeFile),
      ...(target.before.note ? { note: target.before.note } : {}),
    };
    const afterSide: ReviewStillSide = {
      outSec: target.after.outSec,
      sourceSec: target.after.sourceSec,
      file: rel(target.afterFile),
      ...(target.after.note ? { note: target.after.note } : {}),
    };
    if (target.frame.ocr) {
      const region = { x: 0, y: 0, ...outputSize(beforeCtx.manifest) };
      const beforeOcr = await runOcr(target.beforeFile, region, { warn: (message) => warnings.push(message) });
      const afterOcr = await runOcr(target.afterFile, region, { warn: (message) => warnings.push(message) });
      if (beforeOcr) {
        const file = join(outDir, "ocr", `before-${fileStem(target.frame, target.before.outSec)}.json`);
        writeFileSync(file, JSON.stringify(beforeOcr, null, 2), "utf8");
        beforeSide.ocrFile = rel(file);
      }
      if (afterOcr) {
        const file = join(outDir, "ocr", `after-${fileStem(target.frame, target.after.outSec)}.json`);
        writeFileSync(file, JSON.stringify(afterOcr, null, 2), "utf8");
        afterSide.ocrFile = rel(file);
      }
    }
    out.push({ requested: target.frame, before: beforeSide, after: afterSide });
  }
  return out;
}

async function renderReviewStillsWithHooks(args: {
  dir: string;
  outDir: string;
  beforeCtx: ReviewRenderContext;
  afterCtx: ReviewRenderContext;
  frames: NormalizedReviewFrameRequest[];
  hooks?: ReviewHooks;
  runOcr: typeof defaultRunOcr;
  warnings: string[];
}): Promise<ReviewStill[]> {
  const out: ReviewStill[] = [];
  for (let index = 0; index < args.frames.length; index++) {
    const frame = args.frames[index];
    const before = resolveFrameTarget(frame, args.beforeCtx);
    const after = resolveFrameTarget(frame, args.afterCtx);
    const beforeFile = join(args.outDir, "before", `still-${index + 1}.png`);
    const afterFile = join(args.outDir, "after", `still-${index + 1}.png`);
    await args.hooks!.renderStill!({
      side: "before",
      outFile: beforeFile,
      outSec: before.outSec,
      props: args.beforeCtx.props as unknown as Record<string, unknown>,
    });
    await args.hooks!.renderStill!({
      side: "after",
      outFile: afterFile,
      outSec: after.outSec,
      props: args.afterCtx.props as unknown as Record<string, unknown>,
    });
    out.push({
      requested: frame,
      before: {
        outSec: before.outSec,
        sourceSec: before.sourceSec,
        file: rel(beforeFile),
        ...(frame.ocr ? await renderHookOcr("before", beforeFile, before.outSec, args) : {}),
        ...(before.note ? { note: before.note } : {}),
      },
      after: {
        outSec: after.outSec,
        sourceSec: after.sourceSec,
        file: rel(afterFile),
        ...(frame.ocr ? await renderHookOcr("after", afterFile, after.outSec, args) : {}),
        ...(after.note ? { note: after.note } : {}),
      },
    });
  }
  return out;
}

async function renderReviewClips(args: {
  outDir: string;
  beforeCtx: ReviewRenderContext;
  afterCtx: ReviewRenderContext;
  clip: { range: { axis: "source" | "output"; startSec: number; endSec: number }; includeBefore: boolean; includeAfter: boolean };
  keepArtifacts: boolean;
  hooks?: ReviewHooks;
  warnings: string[];
}): Promise<{
  beforeFile?: string;
  afterFile?: string;
  beforePublicFile?: string;
  afterPublicFile?: string;
}> {
  const beforeRange = resolveClipRange(args.clip.range, args.beforeCtx);
  const afterRange = resolveClipRange(args.clip.range, args.afterCtx);
  const beforeFile = join(args.outDir, "before", args.keepArtifacts ? "clip.mp4" : ".clip.tmp.mp4");
  const afterFile = join(args.outDir, "after", args.keepArtifacts ? "clip.mp4" : ".clip.tmp.mp4");
  if (args.hooks?.renderClip) {
    try {
      if (args.clip.includeBefore) {
        await args.hooks.renderClip({
          side: "before",
          outFile: beforeFile,
          startFrame: beforeRange.startFrame,
          endFrame: beforeRange.endFrame,
          props: args.beforeCtx.props,
        });
      }
      if (args.clip.includeAfter) {
        await args.hooks.renderClip({
          side: "after",
          outFile: afterFile,
          startFrame: afterRange.startFrame,
          endFrame: afterRange.endFrame,
          props: args.afterCtx.props,
        });
      }
    } catch (error) {
      args.warnings.push(`review clip の生成に失敗しました: ${(error as Error).message}`);
    }
    return {
      ...(args.clip.includeBefore && existsSync(beforeFile)
        ? { beforeFile, ...(args.keepArtifacts ? { beforePublicFile: rel(beforeFile) } : {}) }
        : {}),
      ...(args.clip.includeAfter && existsSync(afterFile)
        ? { afterFile, ...(args.keepArtifacts ? { afterPublicFile: rel(afterFile) } : {}) }
        : {}),
    };
  }
  try {
    if (args.clip.includeBefore) {
      await renderClipDefault({
        dir: dirname(args.outDir),
        outFile: beforeFile,
        ctx: args.beforeCtx,
        frameRange: [beforeRange.startFrame, beforeRange.endFrame],
      });
    }
    if (args.clip.includeAfter) {
      await renderClipDefault({
        dir: dirname(args.outDir),
        outFile: afterFile,
        ctx: args.afterCtx,
        frameRange: [afterRange.startFrame, afterRange.endFrame],
      });
    }
  } catch (error) {
    args.warnings.push(`review clip の生成に失敗しました: ${(error as Error).message}`);
  }
  if (!args.keepArtifacts) {
    return {
      ...(args.clip.includeBefore && existsSync(beforeFile) ? { beforeFile } : {}),
      ...(args.clip.includeAfter && existsSync(afterFile) ? { afterFile } : {}),
    };
  }
  return {
    ...(args.clip.includeBefore && existsSync(beforeFile) ? { beforeFile, beforePublicFile: rel(beforeFile) } : {}),
    ...(args.clip.includeAfter && existsSync(afterFile) ? { afterFile, afterPublicFile: rel(afterFile) } : {}),
  };
}

async function renderClipDefault(args: {
  dir: string;
  outFile: string;
  ctx: ReviewRenderContext;
  frameRange: [number, number];
}): Promise<void> {
  const session = await createEngineSession(args.dir, {
    props: args.ctx.props,
    sourceUrls: sourceUrlsOf(args.ctx.props),
  });
  const pipe = startFramePipe({ fps: args.ctx.fps, outPath: args.outFile });
  let finished = false;
  try {
    const [startFrame, endFrame] = args.frameRange;
    for (let f = startFrame; f <= endFrame; f++) {
      const pngBase64 = await session.renderAndCapture(f / args.ctx.fps);
      await pipe.write(Buffer.from(pngBase64, "base64"));
    }
    await pipe.finish();
    finished = true;
  } finally {
    await session.close();
    if (!finished) {
      try { await pipe.finish(); } catch { /* ignore cleanup failure */ }
    }
  }
}

function resolveFrameTarget(
  frame: NormalizedReviewFrameRequest,
  ctx: ReviewRenderContext,
): { outSec: number; sourceSec: number | null; note?: string } {
  if (frame.axis === "output") {
    return {
      outSec: clampToDuration(frame.atSec, ctx.durationSec),
      sourceSec: toSourceTime(clampToDuration(frame.atSec, ctx.durationSec), ctx.timeline),
    };
  }
  const direct = toOutputTime(frame.atSec, ctx.timeline);
  if (direct !== null) {
    return { outSec: clampToDuration(direct, ctx.durationSec), sourceSec: frame.atSec };
  }
  const snapped = snapToOutput(frame.atSec, ctx.timeline);
  if (snapped !== null) {
    return {
      outSec: clampToDuration(snapped, ctx.durationSec),
      sourceSec: null,
      note: `source ${frame.atSec.toFixed(2)}s は keep 外のため snap しました`,
    };
  }
  return {
    outSec: clampToDuration(frame.atSec, ctx.durationSec),
    sourceSec: null,
    note: `source ${frame.atSec.toFixed(2)}s を解決できませんでした`,
  };
}

function resolveClipRange(
  range: { axis: "source" | "output"; startSec: number; endSec: number },
  ctx: ReviewRenderContext,
): { startFrame: number; endFrame: number } {
  const startOut = range.axis === "output"
    ? clampToDuration(range.startSec, ctx.durationSec)
    : (snapToOutput(range.startSec, ctx.timeline) ?? 0);
  const endOut = range.axis === "output"
    ? clampToDuration(range.endSec, ctx.durationSec)
    : (snapToOutput(range.endSec, ctx.timeline) ?? ctx.durationSec);
  const startFrame = Math.max(0, Math.round(startOut * ctx.fps));
  const endFrame = Math.max(startFrame, Math.round(endOut * ctx.fps));
  return { startFrame, endFrame };
}

async function analyzeMotion(file: string, cfg: Config, hooks?: ReviewHooks): Promise<SideObservation["motion"] | undefined> {
  if (hooks?.analyzeMotion) return nullToUndefined(await hooks.analyzeMotion(file));
  const avCfg = resolveAvCfg(cfg);
  const scdet = await run(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-vf", `scdet=threshold=${avCfg.scdetThreshold}`, "-an", "-f", "null", "-"],
    { allowFailure: true },
  );
  const freeze = await run(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-vf", `freezedetect=n=${avCfg.freeze.noiseDb}dB:d=${avCfg.freeze.durationSec}`, "-an", "-f", "null", "-"],
    { allowFailure: true },
  );
  const scene = parseScdet(scdet.stderr);
  const frozen = parseFreezedetect(freeze.stderr);
  return {
    sceneChanges: scene.length,
    frozenSec: round2(frozen.reduce((sum, span) => sum + (span.end - span.start), 0)),
    meanSceneScore: scene.length > 0 ? round3(scene.reduce((sum, item) => sum + item.value, 0) / scene.length) : 0,
  };
}

async function analyzeSound(file: string, cfg: Config, hooks?: ReviewHooks): Promise<SideObservation["sound"] | undefined> {
  if (hooks?.analyzeSound) return nullToUndefined(await hooks.analyzeSound(file));
  const probed = await probe(file);
  if (!probed.streams.some((stream) => stream.codec_type === "audio")) return undefined;
  const ebur = await run(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "verbose", "-i", file, "-filter_complex", "[0:a]ebur128=peak=true:framelog=verbose[aout]", "-map", "[aout]", "-f", "null", "-"],
    { allowFailure: true },
  );
  const astats = await run(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-filter_complex", "[0:a]astats=metadata=0:reset=1[aout]", "-map", "[aout]", "-f", "null", "-"],
    { allowFailure: true },
  );
  const eburStats = parseEbur128(ebur.stderr);
  const astatsStats = parseAstats(astats.stderr);
  const silences = await detectSilence(file, cfg.detect.silenceDb, cfg.detect.minSilenceSec);
  return {
    integratedLufs: eburStats.integratedLufs,
    truePeakDbtp: eburStats.truePeakDbtp,
    silenceSec: round2(silences.reduce((sum, span) => sum + (span.end - span.start), 0)),
    clippingSamples: astatsStats.clippedSamples,
  };
}

function mapRangeToOutput(
  range: { axis: "source" | "output"; startSec: number; endSec: number },
  timeline: ReturnType<typeof buildTimeline>,
): { startSec: number; endSec: number } | undefined {
  if (range.axis === "output") return { startSec: range.startSec, endSec: range.endSec };
  const start = snapToOutput(range.startSec, timeline);
  const end = snapToOutput(range.endSec, timeline);
  if (start === null || end === null) return undefined;
  return { startSec: start, endSec: end };
}

function readOcrLines(file: string): string[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { lines?: { text: string }[] };
  return parsed.lines?.map((line) => line.text) ?? [];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fileLabel(frame: NormalizedReviewFrameRequest, outSec: number): string {
  return `${fileStem(frame, outSec)}.png`;
}

function fileStem(frame: NormalizedReviewFrameRequest, outSec: number): string {
  return `${frame.axis}-${outSec.toFixed(2)}s`;
}

function clampToDuration(sec: number, durationSec: number): number {
  return Math.max(0, Math.min(sec, Math.max(0, durationSec - 1 / 30)));
}

function rel(file: string): string {
  return file.slice(file.indexOf(`${REVIEW_DIR}/`));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

async function renderHookOcr(
  side: "before" | "after",
  imageFile: string,
  outSec: number,
  args: {
    dir: string;
    outDir: string;
    beforeCtx: ReviewRenderContext;
    afterCtx: ReviewRenderContext;
    runOcr: typeof defaultRunOcr;
    warnings: string[];
  },
): Promise<Pick<ReviewStillSide, "ocrFile">> {
  const ctx = side === "before" ? args.beforeCtx : args.afterCtx;
  const region = { x: 0, y: 0, ...outputSize(ctx.manifest) };
  const result = await args.runOcr(imageFile, region, { warn: (message) => args.warnings.push(message) });
  if (!result) return {};
  const file = join(args.outDir, "ocr", `${side}-out${outSec.toFixed(2)}s.json`);
  writeFileSync(file, JSON.stringify(result, null, 2), "utf8");
  return { ocrFile: rel(file) };
}
