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
import { isCutplanApproved, isShortApproved } from "../lib/approval.ts";
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
import { decideFastPath, runFastRender } from "../lib/fastRender.ts";
import { resolveFastBaseCapability } from "../lib/fastBaseCapability.ts";
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
import { defaultShortProfileName, resolveProfile } from "../lib/profile.ts";
import { buildRenderProps } from "../lib/renderProps.ts";
import { renderCfgWithDesign } from "../lib/designAsset.ts";
import { prepareDesignAssetsForProps } from "../lib/designStill.ts";
import {
  compositionDurationInFrames,
  compositionDurationSec,
} from "../lib/renderFrameMath.ts";
import { loadShort, loadShorts } from "../lib/shorts.ts";
import { mergeIntervals, playbackSegmentsOf } from "../lib/timeline.ts";
import { timed } from "../lib/timing.ts";
import { resolveVideoEncoder } from "../lib/videoEncode.ts";
import { hasCamera } from "../types.ts";
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
import type { Region } from "../types.ts";

/** ワイプ焼き込みの幾何(Main.tsx の wipeLayer と一致させる。camera 前提)。
 * ww = config の wipeWidthPx、wh はカメラ領域のアスペクトで決まる高さ */
function wipeGeom(manifest: Manifest, cfg: Config): { ww: number; wh: number } | null {
  const cam = manifest.video.cameraRegion;
  if (!cam) return null;
  const ww = cfg.render.wipeWidthPx;
  return { ww, wh: Math.round((ww * cam.h) / cam.w) };
}

/** OffthreadVideo フレームキャッシュ上限の既定(MB)。config.yaml の
 * render.offthreadVideoCacheMb で上書きできる(0 で Remotion 既定に戻す) */
const DEFAULT_OFFTHREAD_VIDEO_CACHE_MB = 512;

/** delayRender の猶予(ms)。Remotion 既定の30秒は、メモリ逼迫時にフォント等の
 * アセット取得が OffthreadVideo のフレーム抽出と同じ bundle サーバの待ち行列に
 * 詰まって「Loading Noto Sans JP ... not cleared after 28000ms」で落ちる実例が
 * あった(docs/perf.md フェーズ9)ため延長する。正常時の挙動・速度には無関係
 * (タイムアウトの発火条件だけが変わる) */
const DELAY_RENDER_TIMEOUT_MS = 120_000;

/** Remotion CLI 呼び出しに共通で付けるリソース系フラグ(本編・チャンク・
 * ショートの全 render 経路で同じものを使う)。いずれも出力の画・音には
 * 影響しないため renderKey には含めない(変更が final.mp4 再生成を誘発しない)。
 * - キャッシュ上限: Remotion 既定(利用可能メモリの半分)は 16GB 機で
 *   compositor が数GBまで成長しマシン全体を重くする。512MB でも速度は不変
 *   (実測は docs/perf.md フェーズ7・9)
 * - concurrency: 省略時は Remotion 既定(コア数の半分)のまま */
export function remotionResourceArgs(cfg: Config): string[] {
  const cacheMb = cfg.render.offthreadVideoCacheMb ?? DEFAULT_OFFTHREAD_VIDEO_CACHE_MB;
  const args = [`--timeout=${DELAY_RENDER_TIMEOUT_MS}`];
  if (cacheMb > 0) {
    args.push(`--offthreadvideo-cache-size-in-bytes=${Math.round(cacheMb * 1024 * 1024)}`);
  }
  if (cfg.render.concurrency) args.push(`--concurrency=${cfg.render.concurrency}`);
  return args;
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
  // デザイン(背景 + 画面パネル + カメラ円)有効時は、ベースの幾何が
  // 「画面全面 + 右下 flush ワイプ」ではないので焼き込めない(Remotion 側の
  // design 描画へフォールバック。高速パスも同時に落ちる。§src/lib/design.ts)
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
        "preview で確認のうえ `node src/cli.ts approve <dir>` で承認してください" +
        "(GUI ならチェックボックス)。",
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
  const cutPath = join(dir, "cut.mp4");
  const cutKeepsPath = join(dir, "cut.keeps.json");
  const sourceStat = statSync(join(dir, manifest.source));
  const cacheKey = buildCutCacheKey({
    keeps,
    manifest,
    cfg,
    sourceMtimeMs: sourceStat.mtimeMs,
    sourceSize: sourceStat.size,
    composite,
  });
  const cachedKey = existsSync(cutKeepsPath)
    ? (JSON.parse(readFileSync(cutKeepsPath, "utf8")) as CutCacheKey)
    : null;
  if (existsSync(cutPath) && cachedKey && cutCacheKeyEquals(cachedKey, cacheKey)) {
    console.log("cut.mp4 を再利用します(カット・音声設定に変更なし)");
  } else {
    await cutFullRes(dir, manifest, keeps, cutPath, cfg, { composite });
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

  const profile = resolveProfile(manifest.video.screenRegion, "default");
  let props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays: overlaysIn,
    renderCfg: renderCfgWithDesign(dir, cfg),
    width: profile.width,
    height: profile.height,
    videoFile: "cut.mp4",
    bgm,
    bgmFallbackFile: bgmFile,
    silences,
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
  props = await prepareDesignAssetsForProps({
    dir,
    props,
    warn: (message) => console.warn(`警告: ${message}`),
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
      resourceArgs: remotionResourceArgs(cfg),
    });
    if (chunked) {
      writeFileSync(renderKeyPath, JSON.stringify(renderKey, null, 2));
      return outPath;
    }
  }

  // render 高速パス(opt-in)。fastPath=false のとき本ブロックには一切入らない
  // =既存挙動とバイト等価。適格なら FAST/SLOW ハイブリッド合成で final.mp4 を作り、
  // 成功したら full-skip キーを書き chunk cache を種付けして返す。非適格・失敗は
  // 1行ログを出して下の通常フルレンダーへ落ちる(誤爆より保守)。
  if (cfg.render.fastPath) {
    const base = resolveFastBaseCapability({ props, composite });
    const decision = decideFastPath({ props, cfg, base });
    if (!decision.activate) {
      console.log(`render 高速パス: 非適用(${decision.reason}) → 通常レンダー`);
    } else {
      if (!base.ok) throw new Error("高速パス能力判定の内部不整合");
      const ok = await runFastRender({
        dir, props, plan: decision.plan, base, cutPath, propsPath, outPath,
        hardwareAcceleration, repoRoot, resourceArgs: remotionResourceArgs(cfg),
      });
      if (ok) {
        writeFileSync(renderKeyPath, JSON.stringify(renderKey, null, 2));
        if (chunkSec > 0) {
          await seedChunkCache({
            dir, props, cutStat: { mtimeMs: cutStat.mtimeMs, size: cutStat.size },
            outPath, chunkSec,
          });
        }
        return outPath;
      }
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
        ...remotionResourceArgs(cfg),
      ],
      { cwd: repoRoot, label: "remotion" },
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
 * 承認ゲート(strict): isShortApproved(name 別の承認レコード。本編の承認は
 * 流用しない)。boolean short.approved にはフォールバックしない。
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
    const gate = isShortApproved(dir, short);
    if (!gate.ok) {
      console.log(`スキップ: ショート "${short.name}"(${gate.reason})`);
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
  const gate = isShortApproved(dir, short);
  if (!gate.ok) {
    throw new Error(
      `ショート "${short.name}" を render できません: ${gate.reason}\n` +
        `preview で確認のうえ \`node src/cli.ts approve <dir> --short ${short.name}\` で` +
        "承認してください(GUI ならチェックボックス)。",
    );
  }
  const name = short.name;
  const shortKeeps = mergeIntervals(short.ranges).map((k) => ({ ...k, speed: 1 }));

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
  // 本編とショートで肌色が変わる事故を防ぐ)。blurs は継承しない(座標が
  // 本編の出力px基準に束縛され、ショートの座標系とは一致しないため。
  // 座標がずれた矩形を黙って継承する方が危険という判断。Main.tsx 側も
  // !props.layout でゲートし二重に塞いでいる)
  const overlaysPath = join(dir, "overlays.json");
  const mainOverlays: Overlays = existsSync(overlaysPath)
    ? (JSON.parse(readFileSync(overlaysPath, "utf8")) as Overlays)
    : {};
  const profile = resolveProfile(
    manifest.video.screenRegion,
    short.profile ?? defaultShortProfileName(hasCamera(manifest)),
  );
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
        ...remotionResourceArgs(cfg),
      ],
      { cwd: repoRoot, label: "remotion" },
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
  /** remotionResourceArgs(cfg) の結果(キャッシュ上限・timeout 等)。
   * フルレンダーと同じ上限をチャンク再レンダーにも適用する */
  resourceArgs: string[];
}): Promise<boolean> {
  const { dir, props, propsPath, cutStat, hardwareAcceleration, repoRoot, outPath, resourceArgs } = args;
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

  const totalFrames = compositionDurationInFrames(props.durationSec, props.fps);
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
          ...resourceArgs,
          `--frames=${from}-${to - 1}`,
          "--muted",
        ],
        { cwd: repoRoot, label: "remotion" },
      ),
    );
  }

  const assembledVideo = join(chunksDir, ".assembled-video.mp4");
  const tempFinal = join(dir, ".final.tmp.mp4");
  try {
    await concatChunks(chunkFiles, assembledVideo);
    await muxVideoAudio(assembledVideo, audioPath, tempFinal);
    const verify = await verifyAssembled(
      tempFinal,
      totalFrames,
      compositionDurationSec(props.durationSec, props.fps),
      props.fps,
    );
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

  const totalFrames = compositionDurationInFrames(props.durationSec, props.fps);
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
  keeps: { start: number; end: number; speed: number }[],
  output: string,
  cfg: Config,
  opts: { composite?: boolean } = {},
): Promise<void> {
  const input = join(dir, manifest.source);
  const source = audioSourceOf(manifest, cfg);

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
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      output,
    ]),
  );
}
