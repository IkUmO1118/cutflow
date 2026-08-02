import { cliCmd } from "../lib/cliName.ts";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isCutplanApproved } from "../lib/approval.ts";
import {
  verifyPlayableVideo,
} from "../lib/chunkCache.ts";
import {
  publishAsTransaction,
} from "../lib/renderTransaction.ts";
import { buildCutCacheKey, cutCacheKeyEquals } from "../lib/cutCache.ts";
import { colorTagArgs, colorTagsOfProbe, type ColorTags } from "../lib/colorTags.ts";
import { run } from "../lib/exec.ts";
import { probe } from "../lib/ffmpeg.ts";
import { renderEngine } from "./renderEngine.ts";
import {
  audioSourceOf,
  keepAudioParts,
  measuredLoudnormFilter,
} from "../lib/loudness.ts";
import {
  buildRenderCacheKey,
  materialFilesOf,
  renderCacheKeyEquals,
} from "../lib/renderKey.ts";
import { resolveCanvas } from "../lib/profile.ts";
import { buildRenderProps } from "../lib/renderProps.ts";
import { renderCfgWithDesign } from "../lib/designAsset.ts";
import { prepareDesignAssetsForProps } from "../lib/designStill.ts";
import {
  compositionDurationInFrames,
  compositionDurationSec,
} from "../lib/renderFrameMath.ts";
import { playbackSegmentsOf } from "../lib/timeline.ts";
import { readCursorSidecar } from "./planEffects.ts";
import type { CursorDwellSample } from "../lib/cursorAnchors.ts";
import { timed, timedSync, setTimingSink, clearTimingSink } from "../lib/timing.ts";
import {
  RenderReportCollector,
  hashInputSnapshot,
  writeRenderReport,
  type OutputProbe,
} from "../lib/renderReport.ts";
import { logStage } from "../lib/obs.ts";
import { resolveVideoEncoder } from "../lib/videoEncode.ts";
import { hasCamera } from "../types.ts";
import type { CutCacheKey } from "../lib/cutCache.ts";
import type { RenderCacheKey } from "../lib/renderKey.ts";
import type { Config } from "../lib/config.ts";
import type {
  AutoCuts,
  Bgm,
  CutPlan,
  Manifest,
  Overlays,
  Transcript,
} from "../types.ts";
import type { RenderProps } from "../lib/renderPropsTypes.ts";
import type { Region } from "../types.ts";

/** ワイプ焼き込みの幾何(Main.tsx の wipeLayer と一致させる。camera 前提)。
 * ww = config の wipeWidthPx、wh はカメラ領域のアスペクトで決まる高さ */
function wipeGeom(manifest: Manifest, cfg: Config): { ww: number; wh: number } | null {
  const cam = manifest.video.cameraRegion;
  if (!cam) return null;
  const ww = cfg.render.wipeWidthPx;
  return { ww, wh: Math.round((ww * cam.h) / cam.w) };
}

/** 出力px矩形の交差判定 */
function rectsIntersect(a: Region, b: Region): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * ワイプ(カメラ)を cut.mp4 に焼き込んで Remotion のベース映像抽出を2回→1回に
 * 減らせる収録か(docs/plans/perf-render-single-extraction.md)。camera があり、
 * zoom / wipeFull が無く、ワイプ矩形と交差する blur も無いときだけ true。
 * 不適格なら従来の拡張キャンバス(3840)ベース+2抽出へフォールバック(挙動 bit 等価)。
 */
export function canBurnWipe(manifest: Manifest, overlays: Overlays, cfg: Config): boolean {
  if (!hasCamera(manifest)) return false;
  // 非 landscape キャンバスは profile.layout でパネル合成する。従来の
  // screen 全面+右下 wipe を cut.mp4 に焼く高速経路とは幾何が異なる。
  if (manifest.canvas !== undefined && manifest.canvas !== "landscape") return false;
  // デザイン(背景 + 画面パネル + カメラ円)有効時は、ベースの幾何が
  // 「画面全面 + 右下 flush ワイプ」ではないので焼き込めない(Remotion 側の
  // design描画か、静的assetを使うdesign FAST基底で合成する。§src/lib/design.ts)
  if (cfg.render.design?.enabled) return false;
  if ((overlays.zooms?.length ?? 0) > 0) return false;
  if ((overlays.wipeFull?.length ?? 0) > 0) return false;
  const g = wipeGeom(manifest, cfg);
  if (!g) return false;
  const sr = manifest.video.screenRegion;
  const wipeRect: Region = { x: sr.w - g.ww, y: sr.h - g.wh, w: g.ww, h: g.wh };
  return !(overlays.blurs ?? []).some((b) => rectsIntersect(b.rect, wipeRect));
}

/**
 * 最終レンダー。2段構成:
 * 1. ffmpeg で cutplan の keep 区間をフル解像度のまま結合 → cut.mp4
 * 2. Remotion で画面クロップ+ワイプ+テロップを合成 → final.mp4
 *
 * カット(トリム・結合)を決定的な ffmpeg に寄せることで、Remotion 側は
 * 「1本の動画の上に重ねるだけ」の単純なタイムラインになる
 * (OffthreadVideo に細かいシークをさせない。速度と安定性のため)。
 *
 * 承認ゲート(strict): approvals.json に「現内容の keep 集合のハッシュと
 * 一致する承認レコード」が無ければ拒否する。boolean cutplan.approved には
 * フォールバックしない(src/lib/approval.ts の isCutplanApproved を参照)。
 */
export async function render(dir: string, cfg: Config): Promise<string> {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const cutplan = JSON.parse(
    readFileSync(join(dir, "cutplan.json"), "utf8"),
  ) as CutPlan;
  const gate = isCutplanApproved(dir, cutplan);
  if (!gate.ok) {
    throw new Error(
      `render できません: ${gate.reason}\n` +
        `preview で確認のうえ \`${cliCmd()} approve <dir>\` で承認してください` +
        "(GUI ならチェックボックス)。",
    );
  }

  // render.report.json(直近の render() 試行の構造化サマリ)。timing.ts の
  // グローバルシンクへ収集し、成功/失敗どちらでも最後に1回だけ書く
  const collector = new RenderReportCollector();
  collector.concurrency = cfg.render.concurrency ?? null;
  setTimingSink((e) => collector.recordStage(e));
  try {
    return await runRenderMain(dir, cfg, manifest, cutplan, collector);
  } catch (e) {
    collector.markFailed(e);
    throw e;
  } finally {
    clearTimingSink();
    try {
      writeRenderReport(dir, collector.finish());
    } catch (e) {
      logStage("render.report", "書込失敗: " + (e instanceof Error ? e.message : String(e)));
    }
  }
}

/**
 * render() の実処理本体(承認ゲート通過後)。render.report.json 用の
 * collector を受け取り、engine 経路・キャッシュ再利用・入力ハッシュ・
 * 出力プローブを収集しながら本編を合成する。
 */
async function runRenderMain(
  dir: string,
  cfg: Config,
  manifest: Manifest,
  cutplan: CutPlan,
  collector: RenderReportCollector,
): Promise<string> {
  const transcript = JSON.parse(
    readFileSync(join(dir, "transcript.json"), "utf8"),
  ) as Transcript;
  const overlaysPath = join(dir, "overlays.json");
  const overlaysIn: Overlays = existsSync(overlaysPath)
    ? (JSON.parse(readFileSync(overlaysPath, "utf8")) as Overlays)
    : {};

  // エディタの分割編集で同じ境界のまま割れている keep は1つに繋いで扱う
  // (preview.ts と同じ規則。カット後タイムラインへの写像は割れ方に依らない)
  const keeps = playbackSegmentsOf(cutplan);
  if (keeps.length === 0) {
    throw new Error("keep 区間が0件です(cutplan.json を確認してください)");
  }

  // ワイプを cut.mp4 に焼き込めるなら Remotion のベース抽出が2回→1回で済む(高速化)。
  // zoom/wipeFull があると焼き込めない=従来の 3840 ベース+2抽出へフォールバック
  const composite = canBurnWipe(manifest, overlaysIn, cfg);
  if (composite) console.log("ワイプを cut.mp4 に焼き込みます(ベース抽出1回の高速レンダー)");

  // 1. keep 区間をフル解像度で結合(音声はマイク+システム音声のミックス、
  //    ラウドネス正規化込み)。keeps・音声設定・元収録ファイルが前回の
  //    render から変わっていなければ cut.mp4 を再利用し、ffmpeg cut
  //    (loudnorm実測込み)をスキップする(cut.keeps.json がキャッシュキー。
  //    削除すれば常にフル再生成に戻る)
  const audioOnly = manifest.layout === "stills";
  const cutPath = join(dir, audioOnly ? "cut.m4a" : "cut.mp4");
  const cutKeepsPath = join(dir, "cut.keeps.json");
  const sourcePath = join(dir, manifest.source);
  const sourceStat = statSync(sourcePath);
  const colorTags = audioOnly ? undefined : colorTagsOfProbe(await probe(sourcePath));
  const cacheKey = buildCutCacheKey({
    keeps,
    manifest,
    cfg,
    sourceMtimeMs: sourceStat.mtimeMs,
    sourceSize: sourceStat.size,
    composite,
    colorTags,
  });
  const cachedKey = existsSync(cutKeepsPath)
    ? (JSON.parse(readFileSync(cutKeepsPath, "utf8")) as CutCacheKey)
    : null;
  if (existsSync(cutPath) && cachedKey && cutCacheKeyEquals(cachedKey, cacheKey)) {
    console.log(`${audioOnly ? "cut.m4a" : "cut.mp4"} を再利用します(カット・音声設定に変更なし)`);
    collector.cutReused = true;
  } else {
    await publishAsTransaction({
      finalPath: cutPath,
      inputs: [
        { path: sourcePath, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
      ],
      produce: (tmp) => cutFullRes(dir, manifest, keeps, tmp, cfg, { composite, colorTags }),
      verify: (tmp) => audioOnly ? verifyPlayableAudio(tmp) : verifyPlayableVideo(tmp),
      commit: () => writeFileSync(cutKeepsPath, JSON.stringify(cacheKey, null, 2)),
    });
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

  // D7: <recording base>.cursor.json(D1)があれば zoom 区間へ実測カーソル
  // トラックを載せる下地(追従ズームは母艦後段。無ければ従来とバイト等価)
  const cursorSidecar = readCursorSidecar(dir, manifest);
  const cursorSamples: CursorDwellSample[] | null = cursorSidecar
    ? cursorSidecar.samples.map((s) => ({
        recTimeMs: s.recTimeMs,
        cx: s.cx,
        cy: s.cy,
        inBounds: s.inBounds,
        leftButtonPressed: s.leftButtonPressed,
      }))
    : null;

  const profile = resolveCanvas(manifest);
  let props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays: overlaysIn,
    renderCfg: renderCfgWithDesign(dir, cfg),
    width: profile.width,
    height: profile.height,
    profile,
    videoFile: "cut.mp4",
    bgm,
    bgmFallbackFile: bgmFile,
    silences,
    cursorSamples,
    overlayExists: (f) => existsSync(join(dir, f)),
    warn: (msg) => console.warn(`警告: ${msg}`),
  });
  // composite 時: ベースは焼き込み済み 1920x1080 の単一映像。canvas/screenRegion を
  // その寸法に、wipeBurnedIn を立てて Main.tsx のワイプレイヤーを畳む。cameraRegion は
  // 残す(字幕の reserve が使う=焼き込みワイプへの重なりを防ぐ)
  if (composite) {
    const sr = manifest.video.screenRegion;
    props.canvas = { w: sr.w, h: sr.h };
    props.screenRegion = { x: 0, y: 0, w: sr.w, h: sr.h };
    props.wipeBurnedIn = true;
  }
  props = await timed("design静的資産準備", () =>
    prepareDesignAssetsForProps({
      dir,
      props,
      warn: (message) => console.warn(`警告: ${message}`),
    }),
  );
  const propsPath = join(dir, "render.props.json");
  writeFileSync(propsPath, JSON.stringify(props, null, 2));

  // 3. エンジンレンダー。
  // hardwareAcceleration: if-possible(既定)は使える環境では GPU エンコーダ
  // (macOS は VideoToolbox)を使い、無ければソフトウェアへ自動フォールバックする
  const outPath = join(dir, "final.mp4");
  const hardwareAcceleration = cfg.render.hardwareAcceleration ?? "if-possible";

  // final.mp4 全スキップキャッシュ(render.key.json)。props(テロップ・演出・
  // BGM配置)・cut.mp4・参照素材ファイル・hardwareAcceleration が前回の render
  // と全て一致すれば Remotion 実行そのものを丸ごとスキップする(cut.mp4 再利用
  // と同じ「成功後にのみキーを書く」中断安全パターン。削除すれば常にフル再生成
  // に戻る)
  const renderKeyPath = join(dir, "render.key.json");
  const cutStat = statSync(cutPath);
  const renderKey = buildRenderCacheKey({
    props,
    dir,
    cut: { mtimeMs: cutStat.mtimeMs, size: cutStat.size },
    hardwareAcceleration,
    statFile: (p) => {
      const s = statSync(p);
      return { mtimeMs: s.mtimeMs, size: s.size };
    },
  });
  collector.inputHash = hashInputSnapshot(renderKey);
  const cachedRenderKey = existsSync(renderKeyPath)
    ? (JSON.parse(readFileSync(renderKeyPath, "utf8")) as RenderCacheKey)
    : null;
  if (
    existsSync(outPath) &&
    cachedRenderKey &&
    renderCacheKeyEquals(cachedRenderKey, renderKey)
  ) {
    console.log("final.mp4 を再利用します(編集内容・素材に変更なし)");
    collector.setPath("full-skip");
    collector.finalFullSkip = true;
    collector.output = probeOutput(outPath, props);
    return outPath;
  }

  await timed("エンジン書き出し 合計", () =>
    renderEngine(dir, cfg, manifest, cutplan, transcript, overlaysIn, cutPath, outPath),
  );
  collector.setPath("engine");
  collector.output = probeOutput(outPath, props);
  writeFileSync(renderKeyPath, JSON.stringify(renderKey, null, 2));
  return outPath;
}

/** 出力ファイル(final.mp4 等)の実測プローブ。render.report.json の
 * output フィールドに載せる(サイズ・想定尺・想定フレーム数) */
function probeOutput(outPath: string, props: RenderProps): OutputProbe {
  return {
    path: outPath,
    sizeBytes: existsSync(outPath) ? statSync(outPath).size : 0,
    durationSec: compositionDurationSec(props.durationSec, props.fps),
    frameCount: compositionDurationInFrames(props.durationSec, props.fps),
  };
}

/** props が参照する素材ファイルの mtime/size 一覧(audioKey の入力) */
function materialStatsOf(
  dir: string,
  props: RenderProps,
): { file: string; mtimeMs: number; size: number }[] {
  return materialFilesOf(props).map((file) => {
    const s = statSync(join(dir, file));
    return { file, mtimeMs: s.mtimeMs, size: s.size };
  });
}

/** 収録フォルダ内の BGM ファイルを探す(render とエディタで共通の規約) */
export function findBgm(dir: string): string | null {
  return (
    ["bgm.mp3", "bgm.m4a", "bgm.wav"].find((f) => existsSync(join(dir, f))) ??
    null
  );
}

/** stills の cut.m4a が音声ストリームを持つ再生可能ファイルか確認する。 */
async function verifyPlayableAudio(file: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file,
    ]);
    const value = JSON.parse(stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
    if (!value.streams?.some((stream) => stream.codec_type === "audio")) {
      return { ok: false, reason: "音声ストリームがありません" };
    }
    if (!(Number(value.format?.duration) > 0)) return { ok: false, reason: "duration が不正です" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `ffprobe に失敗しました: ${(error as Error).message}` };
  }
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
  keeps: { start: number; end: number; speed: number }[],
  output: string,
  cfg: Config,
  opts: { composite?: boolean; colorTags?: ColorTags } = {},
): Promise<void> {
  const input = join(dir, manifest.source);
  const source = audioSourceOf(manifest, cfg);
  const audioOnly = manifest.layout === "stills";
  const colorTags = audioOnly ? undefined : (opts.colorTags ?? colorTagsOfProbe(await probe(input)));

  const videoParts = keeps.map(
    (k, i) => `[0:v]trim=start=${k.start}:end=${k.end},setpts=${
      k.speed === 1 ? "PTS-STARTPTS" : `(PTS-STARTPTS)/${k.speed}`
    }[v${i}]`,
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

  if (audioOnly) {
    const labels = keeps.map((_, i) => `[a${i}]`).join("");
    const parts = [
      ...audioParts,
      `${labels}concat=n=${keeps.length}:v=0:a=1[ac]`,
      `[ac]${loudnorm}[aout]`,
    ];
    await timed("ffmpeg cut(音声のみ)", () =>
      run("ffmpeg", [
        "-y", "-v", "error", "-i", input,
        "-filter_complex", parts.join(";"),
        "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", output,
      ]),
    );
    return;
  }

  // composite: 連結後の拡張キャンバス [vc] から画面クロップ + カメラワイプ(右下 flush)を
  // 出力解像度の1本 [vout] に焼き込む(Main.tsx の wipeLayer と同じ幾何)。これで
  // Remotion 側のベース映像抽出が2回→1回に減る(cut.mp4 自体も 3840→1920 で軽くなる)
  const g = opts.composite ? wipeGeom(manifest, cfg) : null;
  const cam = manifest.video.cameraRegion;
  const compositeParts =
    g && cam
      ? (() => {
          const sr = manifest.video.screenRegion;
          return [
            `[vc]split=2[s0][s1]`,
            `[s0]crop=${sr.w}:${sr.h}:${sr.x}:${sr.y}[scr]`,
            `[s1]crop=${cam.w}:${cam.h}:${cam.x}:${cam.y},scale=${g.ww}:${g.wh}[cw]`,
            `[scr][cw]overlay=${sr.w - g.ww}:${sr.h - g.wh}[vout]`,
          ];
        })()
      : [];
  const videoOut = compositeParts.length > 0 ? "[vout]" : "[vc]";

  const interleaved = keeps.flatMap((_, i) => [`[v${i}]`, `[a${i}]`]).join("");
  const parts = [
    ...videoParts,
    ...audioParts,
    `${interleaved}concat=n=${keeps.length}:v=1:a=1[vc][ac]`,
    ...compositeParts,
    `[ac]${loudnorm}[aout]`,
  ];

  // 中間ファイルなので世代劣化を抑えるため高ビットレートで出す
  // (M5 のハードウェアエンコーダなら高速。loudnorm は内部で
  // 192kHz にアップサンプルするため 48kHz に戻す)
  const cutCodecArgs =
    resolveVideoEncoder(cfg) === "libx264"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"] // 高品質中間
      : ["-c:v", "h264_videotoolbox", "-b:v", "20000k"];
  await timed("ffmpeg cut", () =>
    run("ffmpeg", [
      "-y", "-v", "error",
      "-i", input,
      "-filter_complex", parts.join(";"),
      "-map", videoOut, "-map", "[aout]",
      ...cutCodecArgs,
      ...colorTagArgs(colorTags!),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      output,
    ]),
  );
}
