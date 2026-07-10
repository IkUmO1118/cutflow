import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../lib/config.ts";
import { resolveAvCfg } from "../lib/config.ts";
import { run } from "../lib/exec.ts";
import { detectSilence } from "../lib/ffmpeg.ts";
import { audioSourceOf } from "../lib/loudness.ts";
import { loadShort } from "../lib/shorts.ts";
import { buildTimeline, mergeIntervals, toSourceTime, type TimelineEntry } from "../lib/timeline.ts";
import { buildRenderProps } from "../lib/renderProps.ts";
import {
  aggregateMaxByWindow,
  keepsHash,
  mapSamplesToOutput,
  parseAstats,
  parseAstatsMetadata,
  parseEbur128,
  parseFreezedetect,
  parseScdet,
  type AstatsEnvelopeSample,
} from "../lib/avParse.ts";
import {
  buildConcatAudioFilter,
  buildMotionMetricFilter,
  buildMotionStripFilter,
  buildSingleTrackConcatFilter,
} from "../lib/avFilters.ts";
import { buildProxy, isProxyStale } from "./proxy.ts";
import { findBgm } from "./render.ts";
import type { Bgm, CutPlan, Interval, Manifest, Overlays, Transcript } from "../types.ts";

const AV_DIR = "av.probe";
const MOTION_FILE = "motion.json";
const SOUND_FILE = "sound.json";
const STRIP_FILE = "motion.strip.png";
const SCHEMA_VERSION = 1;

export interface AvOptions {
  range?: { startSec: number; endSec: number };
  everySec?: number;
  short?: string;
  fullRes?: boolean;
  motionOnly?: boolean;
  soundOnly?: boolean;
}

export interface MotionReport {
  schemaVersion: number;
  capturedAt: string;
  key: Record<string, unknown>;
  range: { startSec: number; endSec: number };
  short: string | null;
  base: "proxy" | "source";
  strip: {
    file: string;
    cols: number;
    rows: number;
    tiles: { index: number; outSec: number; sourceSec: number }[];
  };
  motion: { outSec: number; sourceSec: number; sceneScore: number }[];
  frozen: { outSec: number; endOutSec: number; lenSec: number }[];
}

export interface SoundReport {
  schemaVersion: number;
  capturedAt: string;
  key: Record<string, unknown>;
  range: { startSec: number; endSec: number };
  short: string | null;
  mix: {
    integratedLufs: number;
    loudnessRangeLu: number;
    truePeakDbtp: number;
    clipping: { peakDbfs: number; clippedSamples: number };
    envelope: { outSec: number; sourceSec: number; shortTermLufs: number }[];
  } | null;
  silences: { outSec: number; endOutSec: number; lenSec: number }[];
  tracks: {
    windowSec: number;
    samples: {
      outSec: number;
      sourceSec: number;
      micRmsDb: number;
      systemRmsDb: number | null;
      louder: "mic" | "system" | "tie" | null;
    }[];
  } | null;
  bgm: {
    spans: { startOutSec: number; endOutSec: number; volumeDb: number; file: string }[];
    duckSpans: { startOutSec: number; endOutSec: number; duckDb: number }[];
  };
}

export interface AvResult {
  motion?: MotionReport;
  sound?: SoundReport;
}

export async function av(dir: string, opts: AvOptions, cfg: Config): Promise<AvResult> {
  const readJson = <T>(file: string, fallback: T | null): T => {
    const p = join(dir, file);
    if (!existsSync(p)) {
      if (fallback !== null) return fallback;
      throw new Error(`${file} がありません`);
    }
    return JSON.parse(readFileSync(p, "utf8")) as T;
  };
  const readOptionalJson = <T>(file: string): T | null => {
    const p = join(dir, file);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  };
  const manifest = readJson<Manifest>("manifest.json", null);
  const transcript = readJson<Transcript>("transcript.json", { language: "ja", model: "", segments: [] });
  const bgm = readOptionalJson<Bgm>("bgm.json");
  let keeps: Interval[];
  let overlays: Overlays;
  if (opts.short) {
    const short = loadShort(dir, opts.short);
    keeps = mergeIntervals(short.ranges);
    overlays = { captionTracks: short.captionTracks };
  } else {
    const cutplan = readJson<CutPlan>("cutplan.json", null);
    keeps = mergeIntervals(cutplan.segments.filter((s) => s.action === "keep"));
    overlays = readJson<Overlays>("overlays.json", {});
  }
  if (keeps.length === 0) throw new Error("keep 区間が0件です");

  const timeline = buildTimeline(keeps);
  const totalDurationSec = round2(keeps.reduce((sum, keep) => sum + (keep.end - keep.start), 0));
  const range = normalizeRange(opts.range, totalDurationSec);
  const rangedKeeps = sliceKeepsByOutputRange(timeline, range);
  if (rangedKeeps.length === 0) throw new Error("指定 range に対応する keep 区間がありません");

  const avCfg = resolveAvCfg(cfg);
  const everySec = opts.everySec ?? avCfg.everySec;
  if (!Number.isFinite(everySec) || everySec <= 0) {
    throw new Error(`every の値が不正です: ${opts.everySec}`);
  }
  const outDir = join(dir, AV_DIR);
  mkdirSync(outDir, { recursive: true });

  const result: AvResult = {};
  if (opts.soundOnly !== true) {
    const motion = await collectMotion({
      dir,
      manifest,
      timeline,
      keepsHash: keepsHash(rangedKeeps),
      outDir,
      range,
      short: opts.short ?? null,
      fullRes: opts.fullRes === true,
      rootCfg: cfg,
      cfg: avCfg,
      everySec,
      rangedKeeps,
    });
    result.motion = motion;
  }
  if (opts.motionOnly !== true) {
    const sound = await collectSound({
      dir,
      manifest,
      transcript,
      bgm,
      overlays,
      timeline,
      keeps,
      rangedKeeps,
      range,
      short: opts.short ?? null,
      outDir,
      cfg,
      avCfg,
    });
    result.sound = sound;
  }
  return result;
}

async function collectMotion(args: {
  dir: string;
  manifest: Manifest;
  timeline: TimelineEntry[];
  keepsHash: string;
  outDir: string;
  range: { startSec: number; endSec: number };
  short: string | null;
  fullRes: boolean;
  rootCfg: Config;
  cfg: ReturnType<typeof resolveAvCfg>;
  everySec: number;
  rangedKeeps: Interval[];
}): Promise<MotionReport> {
  const { dir, manifest, timeline, keepsHash: keepsDigest, outDir, range, short, fullRes, rootCfg, cfg, everySec, rangedKeeps } = args;
  const baseFile = fullRes ? join(dir, manifest.source) : join(dir, "proxy.mp4");
  if (!fullRes) {
    if (!existsSync(baseFile) || isProxyStale(dir, rootCfg)) await buildProxy(dir, rootCfg);
  }
  const baseStat = statSync(baseFile);
  const tileCount = sampleTimes(range, everySec).length;
  const rows = Math.max(1, Math.ceil(tileCount / cfg.cols));
  const key = {
    base: { file: fullRes ? manifest.source : "proxy.mp4", mtimeMs: baseStat.mtimeMs, size: baseStat.size },
    keepsHash: keepsDigest,
    range,
    short,
    everySec,
    cols: cfg.cols,
    freeze: cfg.freeze,
    scdetThreshold: cfg.scdetThreshold,
  };
  const jsonPath = join(outDir, MOTION_FILE);
  const stripPath = join(outDir, STRIP_FILE);
  const cached = readCached<MotionReport>(jsonPath, key);
  if (cached && existsSync(stripPath)) return cached;

  const stripFilter = buildMotionStripFilter({
    segments: rangedKeeps,
    everySec,
    cols: cfg.cols,
    rows,
    stripWidthPx: cfg.stripWidthPx,
  });
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    baseFile,
    "-filter_complex",
    stripFilter,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    stripPath,
  ]);

  const metricFilters = buildMotionMetricFilter({
    segments: rangedKeeps,
    scdetThreshold: cfg.scdetThreshold,
    freezeNoiseDb: cfg.freeze.noiseDb,
    freezeDurationSec: cfg.freeze.durationSec,
  });
  const motionRun = await run(
    "ffmpeg",
    ["-hide_banner", "-i", baseFile, "-filter_complex", metricFilters.scdet, "-map", "[out]", "-f", "null", "-"],
    { allowFailure: true },
  );
  const freezeRun = await run(
    "ffmpeg",
    ["-hide_banner", "-i", baseFile, "-filter_complex", metricFilters.freeze, "-map", "[out]", "-f", "null", "-"],
    { allowFailure: true },
  );

  const durationSec = round2(range.endSec - range.startSec);
  const motionBuckets = aggregateMaxByWindow(parseScdet(motionRun.stderr), durationSec, everySec);
  const motion = mapSamplesToOutput(motionBuckets, timeline, range.startSec).map((sample) => ({
    outSec: sample.outSec,
    sourceSec: sample.sourceSec,
    sceneScore: round3(sample.value),
  }));
  const frozen = mapSamplesToOutput(
    parseFreezedetect(freezeRun.stderr).map((span) => ({ t: span.start, endT: span.end })),
    timeline,
    range.startSec,
  ).map((span) => ({
    outSec: span.outSec,
    endOutSec: round2(range.startSec + span.endT),
    lenSec: round2(span.endT - span.t),
  }));

  const tiles = sampleTimes(range, everySec).flatMap((outSec, index) => {
    const sourceSec = toSourceTime(outSec, timeline);
    return sourceSec === null ? [] : [{ index, outSec, sourceSec }];
  });
  const report: MotionReport = {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    key,
    range,
    short,
    base: fullRes ? "source" : "proxy",
    strip: { file: join(AV_DIR, STRIP_FILE), cols: cfg.cols, rows, tiles },
    motion,
    frozen,
  };
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return report;
}

async function collectSound(args: {
  dir: string;
  manifest: Manifest;
  transcript: Transcript;
  bgm: Bgm | null;
  overlays: Overlays;
  timeline: TimelineEntry[];
  keeps: Interval[];
  rangedKeeps: Interval[];
  range: { startSec: number; endSec: number };
  short: string | null;
  outDir: string;
  cfg: Config;
  avCfg: ReturnType<typeof resolveAvCfg>;
}): Promise<SoundReport> {
  const { dir, manifest, transcript, bgm, overlays, timeline, keeps, rangedKeeps, range, short, outDir, cfg, avCfg } = args;
  const sourceFile = join(dir, manifest.source);
  const sourceStat = statSync(sourceFile);
  const source = audioSourceOf(manifest, cfg);
  const key = {
    source: { file: manifest.source, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
    keepsHash: keepsHash(rangedKeeps),
    audio: {
      systemMix: source.systemStream !== null,
      systemVolumeDb: source.systemVolumeDb,
      denoiseMic: source.denoiseMic,
      noiseFloorDb: source.noiseFloorDb,
      targetLufs: cfg.render.targetLufs,
    },
    range,
    short,
    windowSec: avCfg.windowSec,
  };
  const jsonPath = join(outDir, SOUND_FILE);
  const cached = readCached<SoundReport>(jsonPath, key);
  if (cached) return cached;

  let mix: SoundReport["mix"] = null;
  let silences: SoundReport["silences"] = [];
  let tracks: SoundReport["tracks"] = null;
  if (manifest.audio.micStream !== undefined) {
    const mixFilter = buildConcatAudioFilter(source, rangedKeeps);
    const ebur = await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "verbose",
      "-i",
      sourceFile,
      "-filter_complex",
      `${mixFilter};[mix]ebur128=peak=true:framelog=verbose[aout]`,
      "-map",
      "[aout]",
      "-f",
      "null",
      "-",
    ]);
    const astats = await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-i",
        sourceFile,
        "-filter_complex",
        `${mixFilter};[mix]astats=metadata=0:reset=1[aout]`,
        "-map",
        "[aout]",
        "-f",
        "null",
        "-",
      ],
      { allowFailure: true },
    );
    const eburStats = parseEbur128(ebur.stderr);
    const astatsStats = parseAstats(astats.stderr);
    mix = {
      integratedLufs: eburStats.integratedLufs,
      loudnessRangeLu: eburStats.loudnessRangeLu,
      truePeakDbtp: eburStats.truePeakDbtp,
      clipping: { peakDbfs: astatsStats.peakDbfs, clippedSamples: astatsStats.clippedSamples },
      envelope: mapSamplesToOutput(eburStats.envelope, timeline, range.startSec).map((sample) => ({
        outSec: sample.outSec,
        sourceSec: sample.sourceSec,
        shortTermLufs: sample.shortTermLufs,
      })),
    };

    const silenceAudio = join(outDir, ".av-silence.wav");
    try {
      await run("ffmpeg", [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        sourceFile,
        "-filter_complex",
        mixFilter,
        "-map",
        "[mix]",
        "-ac",
        "1",
        "-ar",
        "16000",
        silenceAudio,
      ]);
      silences = (await detectSilence(silenceAudio, cfg.detect.silenceDb, cfg.detect.minSilenceSec)).map((span) => ({
        outSec: round2(range.startSec + span.start),
        endOutSec: round2(range.startSec + span.end),
        lenSec: round2(span.end - span.start),
      }));
    } finally {
      rmSync(silenceAudio, { force: true });
    }

    const micSamples = await collectTrackRms(sourceFile, manifest.audio.micStream, rangedKeeps, avCfg.windowSec);
    const systemSamples =
      source.systemStream === null
        ? null
        : await collectTrackRms(sourceFile, source.systemStream, rangedKeeps, avCfg.windowSec);
    tracks = {
      windowSec: avCfg.windowSec,
      samples: combineTrackSamples(micSamples, systemSamples, timeline, range.startSec),
    };
  }

  const props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays: { ...overlays, inserts: [] },
    renderCfg: cfg.render,
    width: manifest.video.screenRegion.w,
    height: manifest.video.screenRegion.h,
    videoFile: manifest.source,
    videoIsSource: true,
    bgm,
    bgmFallbackFile: findBgm(dir),
    silences: null,
    overlayExists: (file) => existsSync(join(dir, file)),
    warn: () => {},
  });
  const report: SoundReport = {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    key,
    range,
    short,
    mix,
    silences,
    tracks,
    bgm: {
      spans: props.bgm.map((track) => ({
        startOutSec: track.start,
        endOutSec: track.end,
        volumeDb: track.volumeDb,
        file: track.file,
      })),
      duckSpans: props.bgm.flatMap((track) =>
        track.duck ? track.duck.spans.map((span) => ({
          startOutSec: span.start,
          endOutSec: span.end,
          duckDb: track.duck!.duckDb,
        })) : [],
      ),
    },
  };
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return report;
}

async function collectTrackRms(
  sourceFile: string,
  streamIndex: number,
  keeps: Interval[],
  windowSec: number,
): Promise<AstatsEnvelopeSample[]> {
  const filter = buildSingleTrackConcatFilter(
    streamIndex,
    keeps,
    `astats=metadata=1:reset=1:length=${windowSec},ametadata=print:file=-`,
  );
  const result = await run("ffmpeg", [
    "-hide_banner",
    "-i",
    sourceFile,
    "-filter_complex",
    filter,
    "-map",
    "[aout]",
    "-f",
    "null",
    "-",
  ]);
  return parseAstatsMetadata(result.stdout);
}

function combineTrackSamples(
  micSamples: AstatsEnvelopeSample[],
  systemSamples: AstatsEnvelopeSample[] | null,
  timeline: TimelineEntry[],
  outOffsetSec: number,
): NonNullable<NonNullable<SoundReport["tracks"]>["samples"]> {
  return mapSamplesToOutput(micSamples, timeline, outOffsetSec).map((mic, index) => {
    const sys = systemSamples?.[index];
    const systemRmsDb = sys ? sys.rmsDb : null;
    let louder: "mic" | "system" | "tie" | null = null;
    if (systemRmsDb === null) louder = "mic";
    else if (Math.abs(mic.rmsDb - systemRmsDb) < 0.1) louder = "tie";
    else louder = mic.rmsDb > systemRmsDb ? "mic" : "system";
    return {
      outSec: mic.outSec,
      sourceSec: mic.sourceSec,
      micRmsDb: mic.rmsDb,
      systemRmsDb,
      louder,
    };
  });
}

function normalizeRange(
  range: { startSec: number; endSec: number } | undefined,
  totalDurationSec: number,
): { startSec: number; endSec: number } {
  const startSec = Math.max(0, range?.startSec ?? 0);
  const endSec = Math.min(totalDurationSec, range?.endSec ?? totalDurationSec);
  if (!(endSec > startSec)) throw new Error(`range が不正です: ${startSec}-${endSec}`);
  return { startSec: round2(startSec), endSec: round2(endSec) };
}

function sliceKeepsByOutputRange(
  timeline: TimelineEntry[],
  range: { startSec: number; endSec: number },
): Interval[] {
  return timeline.flatMap((entry) => {
    const start = Math.max(entry.outputStart, range.startSec);
    const end = Math.min(entry.outputEnd, range.endSec);
    if (end <= start) return [];
    return [{
      start: round2(entry.sourceStart + (start - entry.outputStart) * entry.speed),
      end: round2(entry.sourceStart + (end - entry.outputStart) * entry.speed),
    }];
  });
}

function sampleTimes(range: { startSec: number; endSec: number }, everySec: number): number[] {
  const out: number[] = [];
  for (let t = range.startSec; t <= range.endSec + 0.0001; t += everySec) out.push(round2(t));
  return out;
}

function readCached<T extends { key: unknown }>(file: string, key: unknown): T | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as T;
  return JSON.stringify(parsed.key) === JSON.stringify(key) ? parsed : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function formatAvSummary(result: AvResult): string[] {
  const lines: string[] = [];
  if (result.motion) {
    lines.push(
      `motion: ${result.motion.motion.length}サンプル / frozen ${result.motion.frozen.length}件 / strip ${result.motion.strip.file}`,
    );
  }
  if (result.sound) {
    const mix = result.sound.mix;
    lines.push(
      mix
        ? `sound: I ${mix.integratedLufs.toFixed(1)} LUFS / TP ${mix.truePeakDbtp.toFixed(1)} dBFS / silence ${result.sound.silences.length}件`
        : "sound: 音声ストリームなし",
    );
  }
  return lines;
}
