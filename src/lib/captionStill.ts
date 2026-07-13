// lib/captionStill.ts — render 高速パスが使う、単一の静的テロップを透過 PNG
// として書き出す薄いラッパー。frames.ts と同じ bundle+headless Chrome 経路
// (WarmAssets)を再利用し、内容が変わらなければ同じ出力を再利用する
// 内容アドレス方式のキャッシュ(render.fast/captions/<key>.png)を持つ。
// P1 はこのライブラリだけを定義する(render.ts への配線は P3)。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import type { WarmAssets } from "../stages/frames.ts";
import type { CaptionStillProps } from "../../remotion/CaptionStill.tsx";

export const CAPTION_STILL_DIR = "render.fast/captions";

/** テロップ静止画の内容アドレスキー。テキスト・解決済みスタイル・位置
 * (pos/anchor/captionDefaultPos/cameraRegion の有無/wipe/出力解像度)の
 * すべてを含める(全画面 PNG は配置に依存するため。program §9 の簡略版から
 * 意図的に逸脱している=決定済みの refinement) */
export function captionStillKey(p: CaptionStillProps): string {
  const canon = {
    w: p.width,
    h: p.height,
    wipe: p.wipe,
    cam: p.cameraRegion ? 1 : 0,
    dpos: p.captionDefaultPos ?? null,
    defaults: p.defaults,
    text: p.caption.text,
    style: p.caption.style ?? null,
    pos: p.caption.pos ?? null,
    anchor: p.caption.anchor ?? null,
    hasWords: (p.caption.words?.length ?? 0) > 0,
    track: p.caption.track,
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

export function captionStillPath(dir: string, p: CaptionStillProps): string {
  return join(dir, CAPTION_STILL_DIR, `${captionStillKey(p)}.png`);
}

/** 1件のテロップ静止画を(キャッシュに無ければ)レンダーし、絶対パスを返す。
 * imageFormat: "png" は straight alpha(ffmpeg overlay に必要)。
 * bundle/browser は呼び出し側が warm() 等で用意した WarmAssets を注入する */
export async function renderCaptionStill(args: {
  dir: string;
  caption: CaptionStillProps;
  warm: WarmAssets;
}): Promise<string> {
  const { dir, caption, warm } = args;
  const outPath = captionStillPath(dir, caption);
  if (existsSync(outPath)) return outPath;
  mkdirSync(dirname(outPath), { recursive: true });
  const inputProps = caption as unknown as Record<string, unknown>;
  const composition = await selectComposition({
    serveUrl: warm.serveUrl,
    id: "CaptionStill",
    inputProps,
    puppeteerInstance: warm.browser,
    logLevel: "warn",
  });
  await renderStill({
    composition,
    serveUrl: warm.serveUrl,
    output: outPath,
    frame: 0,
    inputProps,
    imageFormat: "png",
    puppeteerInstance: warm.browser,
    overwrite: true,
    logLevel: "warn",
  });
  return outPath;
}

/** bundle+browser を自前で用意・破棄する簡便版(frames.ts の frames() と同じ形)。
 * 複数のテロップ静止画をまとめて撮る呼び出し側はこれで WarmAssets を作り、
 * fn の中で renderCaptionStill を繰り返し呼べる */
export async function withCaptionStillAssets<T>(
  dir: string,
  fn: (warm: WarmAssets) => Promise<T>,
): Promise<T> {
  await ensureBrowser();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const serveUrl = await bundle({
    entryPoint: join(repoRoot, "remotion", "index.ts"),
    publicDir: dir,
    symlinkPublicDir: true,
  });
  const browser = await openBrowser("chrome");
  try {
    return await fn({ serveUrl, browser });
  } finally {
    await browser.close({ silent: true });
  }
}
