import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../lib/exec.ts";
import {
  buildTimeline,
  remapInterval,
  snapToOutput,
} from "../lib/timeline.ts";
import type { Config } from "../lib/config.ts";
import type { Chapters, CutPlan, Manifest, Transcript } from "../types.ts";
import type { Caption, ChapterCard, RenderProps } from "../../remotion/props.ts";

/**
 * 最終レンダー。2段構成:
 * 1. ffmpeg で cutplan の keep 区間をフル解像度のまま結合 → cut.mp4
 * 2. Remotion で画面クロップ+ワイプ+字幕+章カードを合成 → final.mp4
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
  const chaptersPath = join(dir, "chapters.json");
  const chaptersIn: Chapters = existsSync(chaptersPath)
    ? (JSON.parse(readFileSync(chaptersPath, "utf8")) as Chapters)
    : { chapters: [] };

  const keeps = cutplan.segments.filter((s) => s.action === "keep");
  if (keeps.length === 0) {
    throw new Error("keep 区間が0件です(cutplan.json を確認してください)");
  }

  // 1. keep 区間をフル解像度で結合(音声はマイクトラック、ラウドネス正規化込み)
  const cutPath = join(dir, "cut.mp4");
  await cutFullRes(dir, manifest, keeps, cutPath, cfg.render.targetLufs);

  // 2. 字幕・章の時刻をカット後のタイムラインに変換して props を作る
  const timeline = buildTimeline(keeps);
  const captions: Caption[] = transcript.segments.flatMap((s) =>
    remapInterval(s.start, s.end, timeline).map((iv) => ({
      start: iv.start,
      end: iv.end,
      text: s.text.trim(),
    })),
  ).filter((c) => c.text.length > 0);

  const chapterCards: ChapterCard[] = chaptersIn.chapters
    .map((c) => {
      const start = snapToOutput(c.start, timeline);
      if (start === null) {
        console.warn(`警告: 章「${c.title}」は全区間カットされたため除外します`);
        return null;
      }
      return { start, title: c.title };
    })
    .filter((c) => c !== null);

  // 収録フォルダに bgm.* があれば BGM として合成する
  const bgmFile =
    ["bgm.mp3", "bgm.m4a", "bgm.wav"].find((f) => existsSync(join(dir, f))) ??
    null;
  if (bgmFile) console.log(`BGM を合成します: ${bgmFile}`);

  const durationSec = keeps.reduce((sum, k) => sum + (k.end - k.start), 0);
  const props: RenderProps = {
    videoFile: "cut.mp4",
    bgm: bgmFile
      ? {
          file: bgmFile,
          volumeDb: cfg.render.bgm.volumeDb,
          fadeOutSec: cfg.render.bgm.fadeOutSec,
        }
      : null,
    durationSec: Math.round(durationSec * 100) / 100,
    fps: Math.round(manifest.video.fps) || 30,
    width: cfg.ingest.screenRegion.w,
    height: cfg.ingest.screenRegion.h,
    canvas: { w: manifest.video.width, h: manifest.video.height },
    screenRegion: manifest.video.screenRegion,
    cameraRegion: manifest.video.cameraRegion,
    wipe: { widthPx: cfg.render.wipeWidthPx, marginPx: cfg.render.wipeMarginPx },
    caption: { fontSizePx: cfg.render.captionFontSizePx },
    chapterCardSec: cfg.render.chapterCardSec,
    captions,
    chapters: chapterCards,
  };
  const propsPath = join(dir, "render.props.json");
  writeFileSync(propsPath, JSON.stringify(props, null, 2));

  // 3. Remotion レンダー(リポジトリ直下で実行。初回は headless Chrome を自動取得)
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const outPath = join(dir, "final.mp4");
  await run(
    "npx",
    [
      "remotion", "render",
      "remotion/index.ts", "Main", outPath,
      "--props", propsPath,
      "--public-dir", dir,
      "--codec", "h264",
    ],
    { cwd: repoRoot },
  );
  return outPath;
}

/**
 * keep 区間を trim+concat し、音声をラウドネス正規化してフル解像度の
 * cut.mp4 を作る。正規化はツーパス方式:ワンパスの loudnorm は流しながら
 * 調整するため、入力が目標から遠いと数dB届かない(実測で確認済み)。
 * 1パス目で音声のみ実測し、2パス目に実測値を渡して線形正規化する。
 */
async function cutFullRes(
  dir: string,
  manifest: Manifest,
  keeps: { start: number; end: number }[],
  output: string,
  targetLufs: number,
): Promise<void> {
  const input = join(dir, manifest.source);
  const mic = manifest.audio.micStream;

  const videoParts: string[] = [];
  const audioParts: string[] = [];
  const vLabels: string[] = [];
  const aLabels: string[] = [];
  keeps.forEach((k, i) => {
    videoParts.push(
      `[0:v]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`,
    );
    audioParts.push(
      `[0:a:${mic}]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS[a${i}]`,
    );
    vLabels.push(`[v${i}]`);
    aLabels.push(`[a${i}]`);
  });
  const audioConcat = `${aLabels.join("")}concat=n=${keeps.length}:v=0:a=1[ac]`;

  // 1パス目: カット後音声のラウドネス実測(音声のみなので数秒で終わる)
  const loudnormBase = `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`;
  const { stderr } = await run("ffmpeg", [
    "-i", input,
    "-filter_complex",
    [...audioParts, audioConcat, `[ac]${loudnormBase}:print_format=json[aout]`].join(";"),
    "-map", "[aout]",
    "-f", "null", "-",
  ]);
  const m = parseLoudnormJson(stderr);

  // 2パス目: 実測値を渡した線形正規化で本エンコード
  const interleaved = keeps.flatMap((_, i) => [`[v${i}]`, `[a${i}]`]).join("");
  const parts = [
    ...videoParts,
    ...audioParts,
    `${interleaved}concat=n=${keeps.length}:v=1:a=1[vc][ac]`,
    `[ac]${loudnormBase}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
      `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
      `:offset=${m.target_offset}:linear=true[aout]`,
  ];

  // 中間ファイルなので世代劣化を抑えるため高ビットレートで出す
  // (M5 のハードウェアエンコーダなら高速。loudnorm は内部で
  // 192kHz にアップサンプルするため 48kHz に戻す)
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", input,
    "-filter_complex", parts.join(";"),
    "-map", "[vc]", "-map", "[aout]",
    "-c:v", "h264_videotoolbox", "-b:v", "20000k",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    output,
  ]);
}

/** loudnorm が stderr に出す実測 JSON を取り出す */
function parseLoudnormJson(stderr: string): {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
} {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("loudnorm の実測結果が取得できませんでした");
  }
  return JSON.parse(stderr.slice(start, end + 1));
}
