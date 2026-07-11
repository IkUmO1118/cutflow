// SD-T0: style-profile コマンドのオーケストレータ(薄い殻)。
// §docs/plans/2026-07-12-sd-t0-style-profile-design.md
//
// 任意の --from パス(収録フォルダ or 素の動画/plain フォルダ)を読み、
// own-project(manifest+cutplan あり)/bare-video を判定して
// src/lib/styleProfile.ts の純関数(observeOwnProject/observeBareVideo/
// mergeObservations)を呼び、channel(最初の --from の親ディレクトリ)の
// style.probe/<name>.json に書く。収録フォルダの編集ファイルは一切書かない
// (読むのは describeJson・av.probe・plan.raw.txt・bgm 存在チェックだけ)。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { Config } from "../lib/config.ts";
import { describeJson } from "./describe.ts";
import { AV_DIR, SOUND_FILE } from "./av.ts";
import type { SoundReport, MotionReport } from "./av.ts";
import {
  observeOwnProject,
  observeBareVideo,
  mergeObservations,
  parsePlanRaw,
} from "../lib/styleProfile.ts";
import type { ProjectObservation, StyleProfile } from "../lib/styleProfile.ts";
import { probe as ffprobe, summarizeProbe } from "../lib/ffmpeg.ts";

/** channel(--from の親ディレクトリ)直下に profile を書く生成ディレクトリ */
export const STYLE_PROBE_DIR = "style.probe";

/** motion.json のファイル名。av.ts は MOTION_FILE を export していないため
 * リテラルで持つ(SOUND_FILE/AV_DIR は export 済みなので import) */
const MOTION_FILE = "motion.json";

const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".mov"]);

export interface StyleProfileResult {
  profile: StyleProfile;
  outPath: string;
  warnings: string[];
}

/** manifest.json + cutplan.json を持つディレクトリなら own-project、
 * それ以外(動画ファイルそのもの・plain フォルダ)は bare-video */
function classifyInput(abs: string): "own-project" | "bare-video" {
  if (!statSync(abs).isDirectory()) return "bare-video";
  if (existsSync(join(abs, "manifest.json")) && existsSync(join(abs, "cutplan.json"))) {
    return "own-project";
  }
  return "bare-video";
}

/** abs がファイルならそれ。ディレクトリなら中の動画ファイル(mkv/mp4/mov)を
 * 名前昇順で先頭1件(決定論)。無ければ null */
function resolveVideoFile(abs: string): string | null {
  if (statSync(abs).isFile()) return abs;
  const entries = readdirSync(abs)
    .filter((f) => VIDEO_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort();
  return entries.length > 0 ? join(abs, entries[0]) : null;
}

function emptyProbe(): { durationSec: null; width: null; height: null; fps: null; hasAudio: boolean } {
  return { durationSec: null, width: null, height: null, fps: null, hasAudio: false };
}

async function summarizeFfprobeFile(
  file: string,
): Promise<{ durationSec: number | null; width: number | null; height: number | null; fps: number | null; hasAudio: boolean }> {
  const p = summarizeProbe(await ffprobe(file));
  return {
    durationSec: p.durationSec ?? null,
    width: p.width ?? null,
    height: p.height ?? null,
    fps: p.fps ?? null,
    hasAudio: p.hasAudio,
  };
}

function readJsonOpt<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

function readTextOpt(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** --name を安全なファイル名へ(英数-_ のみ・空→"default") */
function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "default";
  const cleaned = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned === "" ? "default" : cleaned;
}

export async function styleProfile(
  opts: { from: string[]; name?: string },
  cfg: Config,
): Promise<StyleProfileResult> {
  if (!opts.from || opts.from.length === 0) {
    throw new Error("--from を1つ以上指定してください");
  }
  const name = sanitizeName(opts.name ?? "default");
  const warnings: string[] = [];
  const observations: ProjectObservation[] = [];

  for (const raw of opts.from) {
    const abs = resolve(raw);
    if (!existsSync(abs)) throw new Error(`--from のパスがありません: ${abs}`);
    const kind = classifyInput(abs);

    if (kind === "own-project") {
      const proj = describeJson(abs, cfg);
      const sound = readJsonOpt<SoundReport>(join(abs, AV_DIR, SOUND_FILE));
      const motion = readJsonOpt<MotionReport>(join(abs, AV_DIR, MOTION_FILE));
      if (!sound) {
        warnings.push(`${abs}: av.probe/sound.json 未生成 → audio 統計は欠落(先に \`av ${abs}\`)`);
      }
      const planText = readTextOpt(join(abs, "plan.raw.txt"));
      const planRaw = planText ? parsePlanRaw(planText) : null;
      if (planText !== null && planRaw === null) {
        warnings.push(
          `${abs}: plan.raw.txt を解析できず補正デルタは欠落(cuts-only の plan.raw か形式不正)`,
        );
      }
      const bgmPresent =
        existsSync(join(abs, "bgm.json")) ||
        ["bgm.mp3", "bgm.m4a", "bgm.wav"].some((f) => existsSync(join(abs, f)));
      observations.push(
        observeOwnProject({
          path: abs,
          proj,
          sound,
          motion,
          planRaw,
          bgmPresent,
        }),
      );
    } else {
      const videoFile = resolveVideoFile(abs);
      if (!videoFile) warnings.push(`${abs}: 動画ファイルを特定できず ffprobe 統計は欠落`);
      const probeStats = videoFile ? await summarizeFfprobeFile(videoFile) : emptyProbe();
      const probeDir = videoFile ? dirname(videoFile) : abs;
      const sound = readJsonOpt<SoundReport>(join(probeDir, AV_DIR, SOUND_FILE));
      const motion = readJsonOpt<MotionReport>(join(probeDir, AV_DIR, MOTION_FILE));
      observations.push(observeBareVideo({ path: abs, probe: probeStats, sound, motion }));
    }
  }

  const profile = mergeObservations(name, observations);

  // channel = 最初の --from の親ディレクトリ(learn.ts / readRules の dirname(dir) 規約)
  const channel = dirname(resolve(opts.from[0]));
  const outDir = join(channel, STYLE_PROBE_DIR);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(profile, null, 2));

  return { profile, outPath, warnings };
}

function fmtNum(n: number | null): string {
  return n === null ? "n/a" : String(n);
}

function fmtSec(n: number | null): string {
  return n === null ? "n/a" : `${n}s`;
}

function fmtBool(b: boolean | null): string {
  return b === null ? "n/a" : b ? "yes" : "no";
}

/** stdout 向けの人間可読レポート行(§2.4) */
export function formatStyleProfileReport(result: StyleProfileResult): string[] {
  const { profile, outPath, warnings } = result;
  const lines: string[] = [];

  lines.push(
    `style-profile: name=${profile.name} provenance=${profile.provenance} ` +
      `projects=${profile.sampleSize.projects} videos=${profile.sampleSize.videos} ` +
      `shots=${profile.sampleSize.shots} captions=${profile.sampleSize.captions}`,
  );

  const cd = profile.cutDensity;
  lines.push(
    `  cut: avgShot ${fmtSec(cd.avgShotSec)} (median ${fmtNum(cd.medianShotSec)}, ` +
      `p10 ${fmtNum(cd.shotSecP10)}, p90 ${fmtNum(cd.shotSecP90)}) / ` +
      `${fmtNum(cd.sceneChangesPerMin)} changes/min / aggressiveness=${cd.cutAggressiveness ?? "n/a"} ` +
      `[conf ${cd.meta.confidence}]`,
  );

  const cap = profile.captions;
  lines.push(
    `  caption: coverage ${fmtNum(cap.coverageRatio)} / avgDisplay ${fmtSec(cap.avgDisplaySec)} / ` +
      `density=${cap.density ?? "n/a"} / position=${cap.positionHint ?? "n/a"} [conf ${cap.meta.confidence}]`,
  );

  const audio = profile.audio;
  lines.push(
    `  audio: I ${fmtNum(audio.integratedLufs)} LUFS / TP ${fmtNum(audio.truePeakDbtp)} dBFS / ` +
      `silence ${fmtNum(audio.silenceCount)} (ratio ${fmtNum(audio.silenceRatio)}) / ` +
      `bgm=${fmtBool(audio.bgmLikely)} [conf ${audio.meta.confidence}]`,
  );

  const st = profile.structure;
  lines.push(
    `  structure: ${fmtNum(st.chapterCount)} chapters / hook ${fmtSec(st.hookSec)} / ` +
      `cta=${fmtBool(st.ctaLikely)} [conf ${st.meta.confidence}]`,
  );

  if (profile.correctionDelta && profile.correctionDelta.cuts && profile.correctionDelta.chapters && profile.correctionDelta.titles) {
    const d = profile.correctionDelta;
    lines.push(
      `  delta: cuts ${d.cuts!.proposed}→${d.cuts!.final} / ` +
        `chapters ${d.chapters!.proposed}→${d.chapters!.final} (titles kept ${d.chapters!.titlesKeptVerbatim}) / ` +
        `titles ${d.titles!.proposed}→${d.titles!.final} (kept ${d.titles!.keptVerbatim}) / ` +
        `description=${d.description} [conf ${d.meta.confidence}]`,
    );
  }

  lines.push(`プロファイルを ${outPath} に書きました。`);
  for (const w of warnings) lines.push(`警告: ${w}`);
  return lines;
}
