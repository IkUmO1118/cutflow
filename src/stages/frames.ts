// 指定時刻のフレームを最終合成と同じ見た目で PNG に書き出す知覚コマンド。
// AI(Claude Code)は動画を再生できないが画像は読めるので、テロップの位置・
// ワイプとの被り・素材の見え方をこれで自己確認する(人間の確認は preview /
// エディタが担い、これは「AI が自分の編集結果を見る目」)。
//
// 仕組み: render と同じ Remotion コンポジション(remotion/Main.tsx)を
// @remotion/renderer の Node API で1フレームずつレンダーする。バンドルと
// headless Chrome は1回だけ用意して全フレームで使い回す(CLI の
// `remotion still` を時刻ごとに spawn すると、その両方が枚数ぶん発生して
// 遅いため)。ベース映像はエディタのプレビューと同じ proxy.mp4
// (videoIsSource: true。無ければ自動生成)なので、cut.mp4 を作らずに
// 現在の cutplan/transcript/overlays が即反映される。
//
// frames/ 内の PNG は実行のたびに全削除してから書き直す。ファイル名が
// 出力秒ベースなので、cutplan 編集で時刻の写像が変わると旧ファイルが
// 別名のまま残り、AI が編集前の絵を読む事故が起きるため(全ファイル
// いつでも再生成できる中間生成物であり、消して困るものは無い)。

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  openBrowser,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { fmtT } from "../lib/fmt.ts";
import { defaultShortProfileName, resolveProfile } from "../lib/profile.ts";
import { buildRenderProps } from "../lib/renderProps.ts";
import { loadShort } from "../lib/shorts.ts";
import {
  buildTimeline,
  mergeIntervals,
  snapToOutput,
  toOutputTime,
  toSourceTime,
} from "../lib/timeline.ts";
import { runOcr } from "../lib/ocr.ts";
import { buildScreenStill } from "../lib/screenStill.ts";
import { buildProxy, isProxyStale } from "./proxy.ts";
import { hasCamera } from "../types.ts";
import type { TimelineEntry } from "../lib/timeline.ts";
import type { Config } from "../lib/config.ts";
import type { Profile } from "../lib/profile.ts";
import type { CutPlan, Interval, Manifest, Overlays, Transcript } from "../types.ts";

export interface FrameShot {
  /** 指定された時刻(秒。times は axis の軸 / captions・every は出力の秒) */
  requested: number;
  /** 実際にレンダーした出力(カット後)の秒 */
  outSec: number;
  /** 書き出した PNG(絶対パス) */
  file: string;
  /** スナップ・丸めの説明や、そのフレームに映っているテロップの内容 */
  note?: string;
  /** --ocr のとき書いた OCR サイドカー(絶対パス)。省略時は OCR なし
   * (非対応環境での劣化・挿入クリップ内でのスキップを含む) */
  ocrFile?: string;
}

/** 何のフレームを撮るか。times = 時刻指定 / captions = テロップ全件の
 * 一巡監査(各テロップの表示中間で1枚)/ every = 出力全体の定間隔サンプル */
export type FrameRequest =
  | { mode: "times"; times: number[]; axis: "source" | "output" }
  | { mode: "captions" }
  | { mode: "every"; stepSec: number };

export async function frames(
  dir: string,
  req: FrameRequest,
  cfg: Config,
  shortName?: string,
  ocr?: boolean,
): Promise<FrameShot[]> {
  const readJson = <T>(file: string, fallback: T | null): T => {
    const p = join(dir, file);
    if (!existsSync(p)) {
      if (fallback !== null) return fallback;
      throw new Error(`${file} がありません。先にパイプライン(run)を実行してください`);
    }
    return JSON.parse(readFileSync(p, "utf8")) as T;
  };
  const manifest = readJson<Manifest>("manifest.json", null);
  const transcript = readJson<Transcript>("transcript.json", null);

  // --short 指定時はショート専用の keep 集合(ranges)・captionTracks・
  // プロファイルを使う(本編 cutplan/overlays とは独立。D2)。
  // それ以外は従来どおり本編 cutplan.json ベース
  let keeps: Interval[];
  let overlays: Overlays;
  let profile: Profile;
  if (shortName) {
    const short = loadShort(dir, shortName);
    keeps = mergeIntervals(short.ranges);
    // colorFilter だけは本編から例外的に継承する(render.ts のショート経路と
    // 同じ理由。D2 の対象外)。blurs は継承しない(座標が本編の出力px基準に
    // 束縛され、ショートの座標系とは一致しないため。render.ts の同箇所と同じ)
    const mainOverlays = readJson<Overlays>("overlays.json", {});
    overlays = {
      captionTracks: short.captionTracks,
      ...(mainOverlays.colorFilter ? { colorFilter: mainOverlays.colorFilter } : {}),
    };
    profile = resolveProfile(
      manifest.video.screenRegion,
      short.profile ?? defaultShortProfileName(hasCamera(manifest)),
    );
  } else {
    const cutplan = readJson<CutPlan>("cutplan.json", null);
    keeps = mergeIntervals(cutplan.segments.filter((s) => s.action === "keep"));
    overlays = readJson<Overlays>("overlays.json", {});
    profile = resolveProfile(manifest.video.screenRegion, "default");
  }
  if (keeps.length === 0) {
    throw new Error(
      shortName
        ? `ショート "${shortName}" の ranges が0件です(shorts.json を確認してください)`
        : "keep 区間が0件です(cutplan.json を確認してください)",
    );
  }

  // ベース映像はエディタと同じ軽量プロキシ。無ければここで作る(収録ごとに1回)。
  // 焼き込み済みの設定(ラウドネス・システム音声・プレビュー幅・エンコーダ)か
  // 元収録ファイルが前回の生成から変わっていれば陳腐化しているので作り直す
  if (!existsSync(join(dir, "proxy.mp4"))) {
    console.log("proxy.mp4 がないので生成します(初回のみ・数十秒)...");
    await buildProxy(dir, cfg);
  } else if (isProxyStale(dir, cfg)) {
    console.log("proxy.mp4 が設定・元収録と食い違っているので作り直します...");
    await buildProxy(dir, cfg);
  }

  const props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays,
    renderCfg: cfg.render,
    width: profile.width,
    height: profile.height,
    profile,
    videoFile: "proxy.mp4",
    videoIsSource: true,
    bgm: null, // 静止画に音は無関係
    bgmFallbackFile: null,
    overlayExists: (f) => existsSync(join(dir, f)),
    warn: (msg) => console.warn(`警告: ${msg}`),
  });
  const outDir = join(dir, "frames");
  mkdirSync(outDir, { recursive: true });
  // 前回の実行が残した PNG・OCR サイドカーを全削除(冒頭コメント参照。
  // --ocr が古い .ocr.json を読む事故を PNG と同じ理由で防ぐ)
  for (const f of readdirSync(outDir)) {
    if (f.endsWith(".png") || f.endsWith(".ocr.json")) rmSync(join(outDir, f));
  }
  const propsPath = join(outDir, "props.json");
  writeFileSync(propsPath, JSON.stringify(props, null, 2));

  // 元収録の秒 ⇔ カット後の秒の対応表。--t の times モード(スナップ)にも、
  // --ocr のカット後秒→元収録秒(toSourceTime)にも同じものを使う
  const timeline = buildTimeline(
    keeps,
    (overlays.inserts ?? []).filter((i) => existsSync(join(dir, i.file))),
  );

  const maxOut = Math.max(0, props.durationSec - 1 / props.fps);
  const targets = buildTargets(req, props, maxOut, timeline);
  if (targets.length === 0) {
    throw new Error(
      req.mode === "captions"
        ? "テロップが0件です(transcript.json を確認してください)"
        : "撮るフレームが0件です",
    );
  }

  // 同じフレームに落ちる指定は1枚にまとめる(説明は結合して残す)
  const byFrame = new Map<number, Target>();
  for (const t of targets) {
    const frame = Math.round(t.outSec * props.fps);
    const prev = byFrame.get(frame);
    if (prev) prev.notes.push(...t.notes);
    else byFrame.set(frame, { ...t, notes: [...t.notes] });
  }
  const unique = [...byFrame.entries()].sort((a, b) => a[0] - b[0]);

  // バンドル(webpack)とブラウザは1回だけ用意して全フレームで使い回す。
  // 収録フォルダ(publicDir)はコピーせず symlink で参照する
  await ensureBrowser();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const serveUrl = await bundle({
    entryPoint: join(repoRoot, "remotion", "index.ts"),
    publicDir: dir,
    symlinkPublicDir: true,
  });
  const inputProps = props as unknown as Record<string, unknown>;
  const browser = await openBrowser("chrome");
  const shots: FrameShot[] = [];
  try {
    const composition = await selectComposition({
      serveUrl,
      id: "Main",
      inputProps,
      puppeteerInstance: browser,
      logLevel: "warn",
    });
    for (const [frame, t] of unique) {
      const outPath = join(outDir, `out${t.outSec.toFixed(2)}s.png`);
      await renderStill({
        composition,
        serveUrl,
        output: outPath,
        frame,
        inputProps,
        puppeteerInstance: browser,
        overwrite: true,
        logLevel: "warn",
      });
      const notes = [...t.notes];
      let ocrFile: string | undefined;
      if (ocr) {
        ocrFile = await ocrFrame(dir, manifest, timeline, t.outSec, outDir, notes, cfg);
      }
      const note = notes.join(" / ");
      shots.push({
        requested: t.requested,
        outSec: t.outSec,
        file: outPath,
        ...(note ? { note } : {}),
        ...(ocrFile ? { ocrFile } : {}),
      });
    }
  } finally {
    await browser.close({ silent: true });
  }
  return shots;
}

interface Target {
  requested: number;
  outSec: number;
  notes: string[];
}

/** リクエストを「出力秒のリスト」に展開する */
function buildTargets(
  req: FrameRequest,
  props: ReturnType<typeof buildRenderProps>,
  maxOut: number,
  timeline: TimelineEntry[],
): Target[] {
  const clamp = (sec: number) => Math.min(Math.max(0, sec), maxOut);

  if (req.mode === "captions") {
    // props.captions は出力秒へ変換・表示対象の絞り込みが済んだ「実際に
    // 描画されるテロップ」そのもの。ここから中間時刻を取れば transcript の
    // 再解釈(カット判定・時刻換算)を繰り返さずに全件を一巡できる
    return props.captions.map((c) => {
      const mid = clamp((c.start + c.end) / 2);
      const label =
        c.text.length > 24 ? `${c.text.slice(0, 24)}…` : c.text;
      return {
        requested: mid,
        outSec: mid,
        notes: [`テロップ${c.track > 1 ? `(track${c.track})` : ""}「${label}」`],
      };
    });
  }

  if (req.mode === "every") {
    if (!(req.stepSec > 0)) {
      throw new Error(`間隔は正の秒数で指定してください: ${req.stepSec}`);
    }
    const targets: Target[] = [];
    for (let t = 0; t < maxOut; t += req.stepSec) {
      targets.push({ requested: t, outSec: clamp(t), notes: [] });
    }
    targets.push({ requested: maxOut, outSec: maxOut, notes: ["最終フレーム"] });
    return targets;
  }

  // 元収録の秒 → カット後の秒(カット内なら直後の keep へスナップ)
  return req.times.map((t) => {
    let outSec: number;
    const notes: string[] = [];
    if (req.axis === "output") {
      outSec = t;
      if (outSec > maxOut) notes.push(`出力の長さ(${fmtT(props.durationSec)})を超えるため末尾へ丸め`);
    } else {
      const direct = toOutputTime(t, timeline);
      const snapped = direct ?? snapToOutput(t, timeline);
      if (snapped === null) {
        // 最後の keep より後ろのカット内 → 末尾フレームで代用
        outSec = maxOut;
        notes.push("カット区間内でスナップ先もないため最終フレームで代用");
      } else {
        outSec = snapped;
        if (direct === null) notes.push(`カット区間内のため直後の keep 先頭(出力 ${fmtT(snapped)})へスナップ`);
      }
    }
    return { requested: t, outSec: clamp(outSec), notes };
  });
}

/**
 * 1フレーム(出力秒 outSec)ぶんの画面 OCR。toSourceTime で元収録秒へ逆写像し、
 * フル解像度 screenRegion クロップ(screenStill.ts)→ Vision OCR(ocr.ts)の順で
 * 実行し `frames/out<sec>s.ocr.json` を書く。outSec が挿入クリップ内に落ちて
 * toSourceTime が null を返す場合(=その時刻に画面の生映像が無い)は OCR を
 * スキップし notes にその旨を追記するだけで、例外は投げない。非対応環境
 * (macOS 以外・swift 系が無い等)による劣化も同様に例外を投げず、
 * runOcr 内部の warn で警告するだけに留める(frames 本体の PNG 出力は
 * 常に成功で返す)。書いたサイドカーの絶対パスを返す(スキップ・劣化時は undefined)
 */
async function ocrFrame(
  dir: string,
  manifest: Manifest,
  timeline: TimelineEntry[],
  outSec: number,
  outDir: string,
  notes: string[],
  cfg: Config,
): Promise<string | undefined> {
  const sourceSec = toSourceTime(outSec, timeline);
  if (sourceSec === null) {
    notes.push("OCR: 挿入クリップ内のためスキップ(画面の生映像がありません)");
    return undefined;
  }
  const cropPath = join(tmpdir(), `cutflow-ocr-${process.pid}-${outSec.toFixed(2)}.png`);
  try {
    await buildScreenStill(dir, manifest, sourceSec, cropPath);
    const result = await runOcr(cropPath, manifest.video.screenRegion, {
      languages: cfg.ocr?.languages,
      warn: (msg) => console.warn(`警告: ${msg}`),
    });
    if (result === null) return undefined; // 非対応環境等(warn 済み)
    const ocrPath = join(outDir, `out${outSec.toFixed(2)}s.ocr.json`);
    writeFileSync(
      ocrPath,
      JSON.stringify({ outSec, sourceSec, ...result }, null, 2),
    );
    return ocrPath;
  } finally {
    if (existsSync(cropPath)) rmSync(cropPath);
  }
}
