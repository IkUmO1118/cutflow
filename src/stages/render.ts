import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCutCacheKey, cutCacheKeyEquals } from "../lib/cutCache.ts";
import { run } from "../lib/exec.ts";
import {
  audioSourceOf,
  keepAudioParts,
  measuredLoudnormFilter,
} from "../lib/loudness.ts";
import { buildRenderProps } from "../lib/renderProps.ts";
import { mergeIntervals } from "../lib/timeline.ts";
import { timed } from "../lib/timing.ts";
import type { CutCacheKey } from "../lib/cutCache.ts";
import type { Config } from "../lib/config.ts";
import type {
  AutoCuts,
  Bgm,
  CutPlan,
  Manifest,
  Overlays,
  Transcript,
} from "../types.ts";

/**
 * 最終レンダー。2段構成:
 * 1. ffmpeg で cutplan の keep 区間をフル解像度のまま結合 → cut.mp4
 * 2. Remotion で画面クロップ+ワイプ+テロップを合成 → final.mp4
 *
 * カット(トリム・結合)を決定的な ffmpeg に寄せることで、Remotion 側は
 * 「1本の動画の上に重ねるだけ」の単純なタイムラインになる
 * (OffthreadVideo に細かいシークをさせない。速度と安定性のため)。
 *
 * cutplan.json の approved が true でなければ実行を拒否する(承認ゲート)。
 */
export async function render(dir: string, cfg: Config): Promise<string> {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const cutplan = JSON.parse(
    readFileSync(join(dir, "cutplan.json"), "utf8"),
  ) as CutPlan;
  if (!cutplan.approved) {
    throw new Error(
      "cutplan.json の approved が false です。preview で確認し、" +
        "問題なければ approved を true にしてから再実行してください(承認ゲート)",
    );
  }
  const transcript = JSON.parse(
    readFileSync(join(dir, "transcript.json"), "utf8"),
  ) as Transcript;
  const overlaysPath = join(dir, "overlays.json");
  const overlaysIn: Overlays = existsSync(overlaysPath)
    ? (JSON.parse(readFileSync(overlaysPath, "utf8")) as Overlays)
    : {};

  // エディタの分割編集で同じ境界のまま割れている keep は1つに繋いで扱う
  // (preview.ts と同じ規則。カット後タイムラインへの写像は割れ方に依らない)
  const keeps = mergeIntervals(cutplan.segments.filter((s) => s.action === "keep"));
  if (keeps.length === 0) {
    throw new Error("keep 区間が0件です(cutplan.json を確認してください)");
  }

  // 1. keep 区間をフル解像度で結合(音声はマイク+システム音声のミックス、
  //    ラウドネス正規化込み)。keeps・音声設定・元収録ファイルが前回の
  //    render から変わっていなければ cut.mp4 を再利用し、ffmpeg cut
  //    (loudnorm実測込み)をスキップする(cut.keeps.json がキャッシュキー。
  //    削除すれば常にフル再生成に戻る)
  const cutPath = join(dir, "cut.mp4");
  const cutKeepsPath = join(dir, "cut.keeps.json");
  const sourceStat = statSync(join(dir, manifest.source));
  const cacheKey = buildCutCacheKey({
    keeps,
    manifest,
    cfg,
    sourceMtimeMs: sourceStat.mtimeMs,
    sourceSize: sourceStat.size,
  });
  const cachedKey = existsSync(cutKeepsPath)
    ? (JSON.parse(readFileSync(cutKeepsPath, "utf8")) as CutCacheKey)
    : null;
  if (existsSync(cutPath) && cachedKey && cutCacheKeyEquals(cachedKey, cacheKey)) {
    console.log("cut.mp4 を再利用します(カット・音声設定に変更なし)");
  } else {
    await cutFullRes(dir, manifest, keeps, cutPath, cfg);
    writeFileSync(cutKeepsPath, JSON.stringify(cacheKey, null, 2));
  }

  // 2. テロップ・演出の時刻をカット後のタイムラインに変換して props を作る
  // (組み立てはエディタのプレビューと共有: src/lib/renderProps.ts)

  // BGM: bgm.json があれば区間ごとに配置、無ければ収録フォルダ直下の bgm.* を
  // 全編1曲で流す(後方互換)
  const bgmPath = join(dir, "bgm.json");
  const bgm = existsSync(bgmPath)
    ? (JSON.parse(readFileSync(bgmPath, "utf8")) as Bgm)
    : null;
  const bgmFile = findBgm(dir);
  if (bgm) console.log(`BGM を合成します: bgm.json(${bgm.tracks?.length ?? 0} 区間)`);
  else if (bgmFile) console.log(`BGM を合成します: ${bgmFile}`);

  // BGM ダッキング用の無音区間(cuts.auto.json は中間生成物なので無くても動く)
  const autoCutsPath = join(dir, "cuts.auto.json");
  const silences = existsSync(autoCutsPath)
    ? (JSON.parse(readFileSync(autoCutsPath, "utf8")) as AutoCuts).silences
    : null;

  const props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays: overlaysIn,
    renderCfg: cfg.render,
    width: cfg.ingest.screenRegion.w,
    height: cfg.ingest.screenRegion.h,
    videoFile: "cut.mp4",
    bgm,
    bgmFallbackFile: bgmFile,
    silences,
    overlayExists: (f) => existsSync(join(dir, f)),
    warn: (msg) => console.warn(`警告: ${msg}`),
  });
  const propsPath = join(dir, "render.props.json");
  writeFileSync(propsPath, JSON.stringify(props, null, 2));

  // 3. Remotion レンダー(リポジトリ直下で実行。初回は headless Chrome を自動取得)
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const outPath = join(dir, "final.mp4");
  await timed("Remotion", () =>
    run(
      "npx",
      [
        "remotion", "render",
        "remotion/index.ts", "Main", outPath,
        "--props", propsPath,
        "--public-dir", dir,
        "--codec", "h264",
      ],
      { cwd: repoRoot },
    ),
  );
  return outPath;
}

/** 収録フォルダ内の BGM ファイルを探す(render とエディタで共通の規約) */
export function findBgm(dir: string): string | null {
  return (
    ["bgm.mp3", "bgm.m4a", "bgm.wav"].find((f) => existsSync(join(dir, f))) ??
    null
  );
}

/**
 * keep 区間を trim+concat し、音声をラウドネス正規化してフル解像度の
 * cut.mp4 を作る。音声はマイク+システム音声のミックス(src/lib/loudness.ts。
 * 正規化は実測ツーパス方式で preview.mp4 と共通。エディタで聞く音量・
 * 音の構成と最終出力が一致する)
 */
async function cutFullRes(
  dir: string,
  manifest: Manifest,
  keeps: { start: number; end: number }[],
  output: string,
  cfg: Config,
): Promise<void> {
  const input = join(dir, manifest.source);
  const source = audioSourceOf(manifest, cfg);

  const videoParts = keeps.map(
    (k, i) => `[0:v]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`,
  );
  const audioParts = keepAudioParts(source, keeps);

  const loudnorm = await timed("loudnorm 実測", () =>
    measuredLoudnormFilter({
      input,
      source,
      keeps,
      targetLufs: cfg.render.targetLufs,
    }),
  );

  const interleaved = keeps.flatMap((_, i) => [`[v${i}]`, `[a${i}]`]).join("");
  const parts = [
    ...videoParts,
    ...audioParts,
    `${interleaved}concat=n=${keeps.length}:v=1:a=1[vc][ac]`,
    `[ac]${loudnorm}[aout]`,
  ];

  // 中間ファイルなので世代劣化を抑えるため高ビットレートで出す
  // (M5 のハードウェアエンコーダなら高速。loudnorm は内部で
  // 192kHz にアップサンプルするため 48kHz に戻す)
  await timed("ffmpeg cut", () =>
    run("ffmpeg", [
      "-y", "-v", "error",
      "-i", input,
      "-filter_complex", parts.join(";"),
      "-map", "[vc]", "-map", "[aout]",
      "-c:v", "h264_videotoolbox", "-b:v", "20000k",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      output,
    ]),
  );
}
