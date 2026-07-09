import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
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
import type { DeterministicReviewObservation, SideObservation } from "../lib/reviewObservation.ts";
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
  shortName: string | null;
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
  shortName?: string;
  secondaryObservation?: "none" | "vlm";
  provider?: SecondaryObservationProvider;
  hooks?: ReviewHooks;
}

interface ReviewRenderContext {
  manifest: Manifest;
  fps: number;
  durationSec: number;
  props: Record<string, unknown>;
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
  const shortName = opts.shortName ?? null;
  const fullRes = spec.frames.some((frame) => frame.fullRes === true);
  const beforeCtx = buildReviewRenderContext(dir, cfg, base, shortName, fullRes);
  const afterCtx = buildReviewRenderContext(dir, cfg, candidate, shortName, fullRes);
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
    shorts: candidate.shorts,
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
      shortName,
      baseHash: digest(base),
      candidateHash: digest(candidate),
      specHash: digest({ spec, shortName }),
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
  shortName: string | null,
  fullRes = false,
): ReviewRenderContext {
  const ctx = resolveSnapshotRenderContext({ dir, cfg, snapshot, fullRes, ...(shortName ? { shortName } : {}) });
  const inserts = (ctx.overlays.inserts ?? []).filter((insert) => existsSync(join(dir, insert.file)));
  return {
    manifest: ctx.manifest,
    fps: ctx.props.fps,
    durationSec: ctx.props.durationSec,
    props: ctx.props as unknown as Record<string, unknown>,
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
  await ensureBrowser();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const serveUrl = await bundle({
    entryPoint: join(repoRoot, "remotion", "index.ts"),
    publicDir: dir,
    symlinkPublicDir: true,
  });
  const browser = await openBrowser("chrome");
  try {
    const beforeComp = await selectComposition({
      serveUrl,
      id: "Main",
      inputProps: beforeCtx.props,
      puppeteerInstance: browser,
      logLevel: "warn",
    });
    const afterComp = await selectComposition({
      serveUrl,
      id: "Main",
      inputProps: afterCtx.props,
      puppeteerInstance: browser,
      logLevel: "warn",
    });
    const out: ReviewStill[] = [];
    for (const frame of frames) {
      out.push(await renderStillPair({
        outDir,
        frame,
        beforeCtx,
        afterCtx,
        beforeComp,
        afterComp,
        serveUrl,
        browser,
        runOcr,
        warnings,
      }));
    }
    return out;
  } finally {
    await browser.close({ silent: true });
  }
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
      props: args.beforeCtx.props,
    });
    await args.hooks!.renderStill!({
      side: "after",
      outFile: afterFile,
      outSec: after.outSec,
      props: args.afterCtx.props,
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

async function renderStillPair(args: {
  outDir: string;
  frame: NormalizedReviewFrameRequest;
  beforeCtx: ReviewRenderContext;
  afterCtx: ReviewRenderContext;
  beforeComp: Awaited<ReturnType<typeof selectComposition>>;
  afterComp: Awaited<ReturnType<typeof selectComposition>>;
  serveUrl: string;
  browser: Awaited<ReturnType<typeof openBrowser>>;
  runOcr: typeof defaultRunOcr;
  warnings: string[];
}): Promise<ReviewStill> {
  const { outDir, frame, beforeCtx, afterCtx, beforeComp, afterComp, serveUrl, browser, runOcr, warnings } = args;
  const before = resolveFrameTarget(frame, beforeCtx);
  const after = resolveFrameTarget(frame, afterCtx);
  const beforeFile = join(outDir, "before", fileLabel(frame, before.outSec));
  const afterFile = join(outDir, "after", fileLabel(frame, after.outSec));
  await renderStill({
    composition: beforeComp,
    serveUrl,
    output: beforeFile,
    frame: Math.round(before.outSec * beforeCtx.fps),
    inputProps: beforeCtx.props,
    puppeteerInstance: browser,
    overwrite: true,
    logLevel: "warn",
  });
  await renderStill({
    composition: afterComp,
    serveUrl,
    output: afterFile,
    frame: Math.round(after.outSec * afterCtx.fps),
    inputProps: afterCtx.props,
    puppeteerInstance: browser,
    overwrite: true,
    logLevel: "warn",
  });
  const beforeSide: ReviewStillSide = {
    outSec: before.outSec,
    sourceSec: before.sourceSec,
    file: rel(beforeFile),
    ...(before.note ? { note: before.note } : {}),
  };
  const afterSide: ReviewStillSide = {
    outSec: after.outSec,
    sourceSec: after.sourceSec,
    file: rel(afterFile),
    ...(after.note ? { note: after.note } : {}),
  };
  if (frame.ocr) {
    const region = { x: 0, y: 0, w: beforeCtx.manifest.video.screenRegion.w, h: beforeCtx.manifest.video.screenRegion.h };
    const beforeOcr = await runOcr(beforeFile, region, { warn: (message) => warnings.push(message) });
    const afterOcr = await runOcr(afterFile, region, { warn: (message) => warnings.push(message) });
    if (beforeOcr) {
      const file = join(outDir, "ocr", `before-${fileStem(frame, before.outSec)}.json`);
      writeFileSync(file, JSON.stringify(beforeOcr, null, 2), "utf8");
      beforeSide.ocrFile = rel(file);
    }
    if (afterOcr) {
      const file = join(outDir, "ocr", `after-${fileStem(frame, after.outSec)}.json`);
      writeFileSync(file, JSON.stringify(afterOcr, null, 2), "utf8");
      afterSide.ocrFile = rel(file);
    }
  }
  return { requested: frame, before: beforeSide, after: afterSide };
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
  await ensureBrowser();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const serveUrl = await bundle({
    entryPoint: join(repoRoot, "remotion", "index.ts"),
    publicDir: dirname(args.outDir),
    symlinkPublicDir: true,
  });
  const browser = await openBrowser("chrome");
  try {
    if (args.clip.includeBefore) {
      await renderClipDefault({
        outFile: beforeFile,
        ctx: args.beforeCtx,
        frameRange: [beforeRange.startFrame, beforeRange.endFrame],
        serveUrl,
        browser,
      });
    }
    if (args.clip.includeAfter) {
      await renderClipDefault({
        outFile: afterFile,
        ctx: args.afterCtx,
        frameRange: [afterRange.startFrame, afterRange.endFrame],
        serveUrl,
        browser,
      });
    }
  } catch (error) {
    args.warnings.push(`review clip の生成に失敗しました: ${(error as Error).message}`);
  } finally {
    await browser.close({ silent: true });
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
  outFile: string;
  ctx: ReviewRenderContext;
  frameRange: [number, number];
  serveUrl: string;
  browser: Awaited<ReturnType<typeof openBrowser>>;
}): Promise<void> {
  const composition = await selectComposition({
    serveUrl: args.serveUrl,
    id: "Main",
    inputProps: args.ctx.props,
    puppeteerInstance: args.browser,
    logLevel: "warn",
  });
  await renderMedia({
    composition,
    serveUrl: args.serveUrl,
    outputLocation: args.outFile,
    codec: "h264",
    frameRange: args.frameRange,
    inputProps: args.ctx.props,
    puppeteerInstance: args.browser,
    overwrite: true,
    logLevel: "warn",
  });
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
  const region = { x: 0, y: 0, w: ctx.manifest.video.screenRegion.w, h: ctx.manifest.video.screenRegion.h };
  const result = await args.runOcr(imageFile, region, { warn: (message) => args.warnings.push(message) });
  if (!result) return {};
  const file = join(args.outDir, "ocr", `${side}-out${outSec.toFixed(2)}s.json`);
  writeFileSync(file, JSON.stringify(result, null, 2), "utf8");
  return { ocrFile: rel(file) };
}
