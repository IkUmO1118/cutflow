import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carveFinalToChunks,
  chunkFileName,
  concatChunks,
  extractAudio,
  muxVideoAudio,
  probeKeyframes,
  verifyAssembled,
} from "../lib/chunkCache.ts";
import {
  audioKey as buildAudioKey,
  carveBoundaries,
  chunkVideoKey,
  globalVideoKey,
} from "../lib/chunkPlan.ts";
import { buildCutCacheKey, cutCacheKeyEquals } from "../lib/cutCache.ts";
import { run } from "../lib/exec.ts";
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
import { resolveProfile } from "../lib/profile.ts";
import { buildRenderProps } from "../lib/renderProps.ts";
import { loadShort, loadShorts } from "../lib/shorts.ts";
import { mergeIntervals } from "../lib/timeline.ts";
import { timed } from "../lib/timing.ts";
import type { ChunksCacheKey, FileStat } from "../lib/chunkPlan.ts";
import type { CutCacheKey } from "../lib/cutCache.ts";
import type { RenderCacheKey } from "../lib/renderKey.ts";
import type { Config } from "../lib/config.ts";
import type {
  AutoCuts,
  Bgm,
  CutPlan,
  Manifest,
  Overlays,
  Short,
  Transcript,
} from "../types.ts";
import type { RenderProps } from "../../remotion/props.ts";

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

  const profile = resolveProfile(cfg, "default");
  const props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays: overlaysIn,
    renderCfg: cfg.render,
    width: profile.width,
    height: profile.height,
    videoFile: "cut.mp4",
    bgm,
    bgmFallbackFile: bgmFile,
    silences,
    overlayExists: (f) => existsSync(join(dir, f)),
    warn: (msg) => console.warn(`警告: ${msg}`),
  });
  const propsPath = join(dir, "render.props.json");
  writeFileSync(propsPath, JSON.stringify(props, null, 2));

  // 3. Remotion レンダー(リポジトリ直下で実行。初回は headless Chrome を自動取得)。
  // hardwareAcceleration: if-possible(既定)は使える環境では GPU エンコーダ
  // (macOS は VideoToolbox)を使い、無ければソフトウェアへ自動フォールバックする
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
  const cachedRenderKey = existsSync(renderKeyPath)
    ? (JSON.parse(readFileSync(renderKeyPath, "utf8")) as RenderCacheKey)
    : null;
  if (
    existsSync(outPath) &&
    cachedRenderKey &&
    renderCacheKeyEquals(cachedRenderKey, renderKey)
  ) {
    console.log("final.mp4 を再利用します(編集内容・素材に変更なし)");
    return outPath;
  }

  // チャンク差分レンダー(docs/render-chunk-cache.md)。render.chunkSec > 0 の
  // ときだけ試す。直前フルレンダーの render.chunks/ が使え、音声・全域 props
  // (layerOrder・wipe 幾何・keeps 等)が不変なら、変わったチャンクだけ
  // 再レンダーして concat + mux する(§4)。使えない/検証NGならフルレンダーへ
  // 落ちる(0/未設定なら render.chunks/ に一切触れず既存挙動と bit 一致)
  const chunkSec = cfg.render.chunkSec ?? 0;
  if (chunkSec > 0) {
    const chunked = await tryChunkRender({
      dir, props, propsPath, cutStat: { mtimeMs: cutStat.mtimeMs, size: cutStat.size },
      hardwareAcceleration, repoRoot, outPath,
    });
    if (chunked) {
      writeFileSync(renderKeyPath, JSON.stringify(renderKey, null, 2));
      return outPath;
    }
  }

  await timed("Remotion", () =>
    run(
      "npx",
      [
        "remotion", "render",
        "remotion/index.ts", "Main", outPath,
        "--props", propsPath,
        "--public-dir", dir,
        "--codec", "h264",
        "--hardware-acceleration", hardwareAcceleration,
      ],
      { cwd: repoRoot },
    ),
  );
  writeFileSync(renderKeyPath, JSON.stringify(renderKey, null, 2));

  if (chunkSec > 0) {
    await seedChunkCache({
      dir, props, cutStat: { mtimeMs: cutStat.mtimeMs, size: cutStat.size },
      outPath, chunkSec,
    });
  }
  return outPath;
}

/**
 * ショート1本のレンダー。shorts.json から name を1件読み、
 * shortKeeps(= mergeIntervals(short.ranges)。本編 cutplan とは独立。D2)を
 * keep 集合として cut.<name>.mp4 → shorts/<name>.mp4 を作る。
 * 承認ゲート: short.approved が true でなければ拒否する(本編 approved は流用しない)。
 */
export async function renderShort(dir: string, cfg: Config, name: string): Promise<string> {
  const short = loadShort(dir, name);
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const transcript = JSON.parse(
    readFileSync(join(dir, "transcript.json"), "utf8"),
  ) as Transcript;
  return renderOneShort(dir, cfg, manifest, transcript, short);
}

/**
 * approved な全ショートをレンダーする。未承認のショートは1行ログでスキップを
 * 明示する(黙って飛ばさない)。shorts.json 自体が無ければエラー
 */
export async function renderShorts(dir: string, cfg: Config): Promise<string[]> {
  const shorts = loadShorts(dir);
  if (!shorts) {
    throw new Error("shorts.json がありません(このフォルダにショートは未定義です)");
  }
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const transcript = JSON.parse(
    readFileSync(join(dir, "transcript.json"), "utf8"),
  ) as Transcript;
  const outputs: string[] = [];
  for (const short of shorts.shorts) {
    if (!short.approved) {
      console.log(`スキップ: ショート "${short.name}" は approved が false です`);
      continue;
    }
    outputs.push(await renderOneShort(dir, cfg, manifest, transcript, short));
  }
  return outputs;
}

/**
 * ショート1本の実処理。本編 render の2段構成(cutFullRes → buildRenderProps →
 * Remotion)をそのまま流用し、keep 集合だけショートの ranges に差し替える。
 * キャッシュは full-skip(render.<name>.key.json)+ cut 再利用
 * (cut.<name>.keeps.json)のみ。チャンク差分レンダーはショートには使わない(D4)
 */
async function renderOneShort(
  dir: string,
  cfg: Config,
  manifest: Manifest,
  transcript: Transcript,
  short: Short,
): Promise<string> {
  if (!short.approved) {
    throw new Error(
      `ショート "${short.name}" の approved が false です。縦動画を確認し、` +
        "問題なければ approved を true にしてから再実行してください(承認ゲート)",
    );
  }
  const name = short.name;
  const shortKeeps = mergeIntervals(short.ranges);

  const cutPath = join(dir, `cut.${name}.mp4`);
  const cutKeepsPath = join(dir, `cut.${name}.keeps.json`);
  const sourceStat = statSync(join(dir, manifest.source));
  const cacheKey = buildCutCacheKey({
    keeps: shortKeeps,
    manifest,
    cfg,
    sourceMtimeMs: sourceStat.mtimeMs,
    sourceSize: sourceStat.size,
  });
  const cachedKey = existsSync(cutKeepsPath)
    ? (JSON.parse(readFileSync(cutKeepsPath, "utf8")) as CutCacheKey)
    : null;
  if (existsSync(cutPath) && cachedKey && cutCacheKeyEquals(cachedKey, cacheKey)) {
    console.log(`cut.${name}.mp4 を再利用します(カット・音声設定に変更なし)`);
  } else {
    await cutFullRes(dir, manifest, shortKeeps, cutPath, cfg);
    writeFileSync(cutKeepsPath, JSON.stringify(cacheKey, null, 2));
  }

  // ショートは本編 overlays.json の素材/インサート/wipeFull/hideCaption と
  // bgm.json を継承しない(v1 スコープ注記。D2)。テロップは transcript を
  // 流用し、captionTracks だけショート専用の上書きを既存の解決機構に相乗りさせる。
  // colorFilter だけは例外的に継承する(演出ではなく収録の見た目補正なので、
  // 本編とショートで肌色が変わる事故を防ぐ)
  const overlaysPath = join(dir, "overlays.json");
  const mainOverlays: Overlays = existsSync(overlaysPath)
    ? (JSON.parse(readFileSync(overlaysPath, "utf8")) as Overlays)
    : {};
  const profile = resolveProfile(cfg, short.profile ?? "vertical");
  const shortOverlays: Overlays = {
    captionTracks: short.captionTracks,
    ...(mainOverlays.colorFilter ? { colorFilter: mainOverlays.colorFilter } : {}),
  };
  const props = buildRenderProps({
    manifest,
    keeps: shortKeeps,
    transcript,
    overlays: shortOverlays,
    renderCfg: cfg.render,
    width: profile.width,
    height: profile.height,
    profile,
    videoFile: `cut.${name}.mp4`,
    bgm: null,
    bgmFallbackFile: null,
    silences: null,
    overlayExists: (f) => existsSync(join(dir, f)),
    warn: (msg) => console.warn(`警告: ${msg}`),
  });
  const propsPath = join(dir, `render.${name}.props.json`);
  writeFileSync(propsPath, JSON.stringify(props, null, 2));

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const shortsDir = join(dir, "shorts");
  mkdirSync(shortsDir, { recursive: true });
  const outPath = join(shortsDir, `${name}.mp4`);
  const hardwareAcceleration = cfg.render.hardwareAcceleration ?? "if-possible";

  // full-skip キャッシュ(render.<name>.key.json)。本編と同じ判定ロジックを
  // name 別ファイルで流用する(チャンク差分レンダーはショートには入れない)
  const renderKeyPath = join(dir, `render.${name}.key.json`);
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
  const cachedRenderKey = existsSync(renderKeyPath)
    ? (JSON.parse(readFileSync(renderKeyPath, "utf8")) as RenderCacheKey)
    : null;
  if (
    existsSync(outPath) &&
    cachedRenderKey &&
    renderCacheKeyEquals(cachedRenderKey, renderKey)
  ) {
    console.log(`shorts/${name}.mp4 を再利用します(編集内容・素材に変更なし)`);
    return outPath;
  }

  await timed(`Remotion(${name})`, () =>
    run(
      "npx",
      [
        "remotion", "render",
        "remotion/index.ts", "Main", outPath,
        "--props", propsPath,
        "--public-dir", dir,
        "--codec", "h264",
        "--hardware-acceleration", hardwareAcceleration,
      ],
      { cwd: repoRoot },
    ),
  );
  writeFileSync(renderKeyPath, JSON.stringify(renderKey, null, 2));
  return outPath;
}

/** render.chunks/ 配下のパス一式 */
function chunkPaths(dir: string) {
  const chunksDir = join(dir, "render.chunks");
  return {
    chunksDir,
    keyPath: join(chunksDir, "chunks.key.json"),
    audioPath: join(chunksDir, "audio.m4a"),
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

/**
 * 直前フルレンダーの render.chunks/ が使えるか判定し、使えれば変わった
 * チャンクだけ再レンダーして final.mp4 を組み立てる(§4-2)。
 * 成功すれば true(final.mp4・chunks.key.json を書き終えている)。使えない
 * ときは静かに false(通常のフルレンダーへ委ねる)。実際にチャンクを
 * 再レンダーしたのに検証で落ちたときだけ 1 行ログを出し render.chunks/ を
 * 破棄する(黙ってフルレンダーに落ちない。§5)
 */
async function tryChunkRender(args: {
  dir: string;
  props: RenderProps;
  propsPath: string;
  cutStat: FileStat;
  hardwareAcceleration: string;
  repoRoot: string;
  outPath: string;
}): Promise<boolean> {
  const { dir, props, propsPath, cutStat, hardwareAcceleration, repoRoot, outPath } = args;
  const { chunksDir, keyPath, audioPath } = chunkPaths(dir);
  if (!existsSync(outPath) || !existsSync(keyPath) || !existsSync(audioPath)) return false;

  let cached: ChunksCacheKey;
  try {
    cached = JSON.parse(readFileSync(keyPath, "utf8")) as ChunksCacheKey;
  } catch {
    return false;
  }

  const materialStats = materialStatsOf(dir, props);
  const newAudioKey = buildAudioKey(props, cutStat, materialStats);
  if (newAudioKey !== cached.audioKey) return false;

  const newGlobalKey = globalVideoKey(props, cutStat);
  if (newGlobalKey !== cached.globalKey) return false;

  const totalFrames = Math.max(1, Math.round(props.durationSec * props.fps));
  if (totalFrames !== cached.totalFrames || props.fps !== cached.fps) return false;

  const { boundaries } = cached;
  const chunkCount = boundaries.length - 1;
  if (chunkCount <= 0 || chunkCount !== cached.chunkVideoKeys.length) return false;
  const chunkFiles = Array.from({ length: chunkCount }, (_, i) => join(chunksDir, chunkFileName(i)));
  if (!chunkFiles.every((f) => existsSync(f))) return false;

  const newChunkKeys = boundaries
    .slice(0, -1)
    .map((from, i) => chunkVideoKey(props, from, boundaries[i + 1], cutStat, props.fps));
  const changedIndices = newChunkKeys
    .map((key, i) => (key !== cached.chunkVideoKeys[i] ? i : -1))
    .filter((i) => i >= 0);

  for (const i of changedIndices) {
    const from = boundaries[i];
    const to = boundaries[i + 1];
    await timed(`チャンク${i}再レンダー(frame ${from}-${to - 1})`, () =>
      run(
        "npx",
        [
          "remotion", "render",
          "remotion/index.ts", "Main", chunkFiles[i],
          "--props", propsPath,
          "--public-dir", dir,
          "--codec", "h264",
          "--hardware-acceleration", hardwareAcceleration,
          `--frames=${from}-${to - 1}`,
          "--muted",
        ],
        { cwd: repoRoot },
      ),
    );
  }

  const assembledVideo = join(chunksDir, ".assembled-video.mp4");
  const tempFinal = join(dir, ".final.tmp.mp4");
  try {
    await concatChunks(chunkFiles, assembledVideo);
    await muxVideoAudio(assembledVideo, audioPath, tempFinal);
    const verify = await verifyAssembled(tempFinal, totalFrames, props.durationSec, props.fps);
    if (!verify.ok) {
      console.warn(`チャンク検証に失敗したためフル再生成します: ${verify.reason}`);
      rmSync(chunksDir, { recursive: true, force: true });
      return false;
    }
    renameSync(tempFinal, outPath);
    const newKey: ChunksCacheKey = {
      fps: props.fps,
      totalFrames,
      boundaries,
      globalKey: newGlobalKey,
      chunkVideoKeys: newChunkKeys,
      audioKey: newAudioKey,
    };
    writeFileSync(keyPath, JSON.stringify(newKey, null, 2));
    console.log(
      changedIndices.length === 0
        ? "チャンク差分レンダー: 変更チャンクなし(再連結のみ)"
        : `チャンク差分レンダー: ${changedIndices.length}/${chunkCount} チャンクを再レンダー`,
    );
    return true;
  } finally {
    rmSync(assembledVideo, { force: true });
    rmSync(tempFinal, { force: true });
  }
}

/**
 * フルレンダー直後、final.mp4 をチャンク差分レンダーのキャッシュとして
 * 種付けする(§4-3)。carve・音声抽出はいずれも `-c copy` で軽い。
 */
async function seedChunkCache(args: {
  dir: string;
  props: RenderProps;
  cutStat: FileStat;
  outPath: string;
  chunkSec: number;
}): Promise<void> {
  const { dir, props, cutStat, outPath, chunkSec } = args;
  const { chunksDir, keyPath, audioPath } = chunkPaths(dir);
  rmSync(chunksDir, { recursive: true, force: true });
  mkdirSync(chunksDir, { recursive: true });

  const totalFrames = Math.max(1, Math.round(props.durationSec * props.fps));
  const keyframeFrames = await probeKeyframes(outPath);
  const boundaries = carveBoundaries(keyframeFrames, totalFrames, chunkSec, props.fps);
  await carveFinalToChunks(outPath, boundaries, chunksDir);
  await extractAudio(outPath, audioPath);

  const materialStats = materialStatsOf(dir, props);
  const chunkVideoKeys = boundaries
    .slice(0, -1)
    .map((from, i) => chunkVideoKey(props, from, boundaries[i + 1], cutStat, props.fps));
  const key: ChunksCacheKey = {
    fps: props.fps,
    totalFrames,
    boundaries,
    globalKey: globalVideoKey(props, cutStat),
    chunkVideoKeys,
    audioKey: buildAudioKey(props, cutStat, materialStats),
  };
  writeFileSync(keyPath, JSON.stringify(key, null, 2));
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
