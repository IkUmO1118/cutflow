// lib/overlayStill.ts — render 高速パスが使う、素材オーバーレイ1件を
// 「時間不変なレイヤー画」として透過 PNG に焼くラッパー。captionStill.ts と
// 同じ WarmAssets(bundle + headless Chrome)を再利用する。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import type { WarmAssets } from "../stages/frames.ts";
import type { OverlayItem } from "../../remotion/props.ts";
import type { OverlayStillProps } from "../../remotion/OverlayStill.tsx";

export const OVERLAY_STILL_DIR = "render.fast/overlays";

/** 時間変化する要素を剥がした「レイヤー画」用の素材。
 * fade / opacity / keyframes は ffmpeg 側が alpha として掛けるのでここでは 1 に固定。
 * startFrom は画像では Remotion も無視するので落とす(キャッシュキーの汚染防止) */
export function overlayStillItem(o: OverlayItem): OverlayItem {
  return {
    start: o.start, end: o.end, file: o.file, track: o.track, fit: o.fit,
    ...(o.rect ? { rect: o.rect } : {}),
  };
}

/** 素材レイヤー画の内容アドレスキー。ファイル内容ではなく
 * 「パス + mtime + size + fit + rect + 出力解像度」(captions/ の流儀に合わせる)。
 * fps / start / end / fade / opacity / keyframes / startFrom は出力に影響しないので含めない */
export function overlayStillKey(args: {
  dir: string; item: OverlayItem; width: number; height: number;
}): string {
  const { dir, item, width, height } = args;
  const st = statSync(join(dir, item.file));      // 存在しなければ throw → fastRender が catch → フルレンダー
  const canon = {
    w: width, h: height,
    file: item.file,
    mtimeMs: st.mtimeMs,
    size: st.size,
    fit: item.fit,
    rect: item.rect ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

export function overlayStillPath(args: {
  dir: string; item: OverlayItem; width: number; height: number;
}): string {
  return join(args.dir, OVERLAY_STILL_DIR, `${overlayStillKey(args)}.png`);
}

/** 1件の素材レイヤー画を(キャッシュに無ければ)レンダーし、絶対パスを返す */
export async function renderOverlayStill(args: {
  dir: string; item: OverlayItem; width: number; height: number; fps: number; warm: WarmAssets;
}): Promise<string> {
  const { dir, item, width, height, fps, warm } = args;
  const outPath = overlayStillPath({ dir, item, width, height });
  if (existsSync(outPath)) return outPath;
  mkdirSync(dirname(outPath), { recursive: true });
  const stillProps: OverlayStillProps = { width, height, item: overlayStillItem(item), fps };
  const inputProps = stillProps as unknown as Record<string, unknown>;
  const composition = await selectComposition({
    serveUrl: warm.serveUrl, id: "OverlayStill", inputProps,
    puppeteerInstance: warm.browser, logLevel: "warn",
  });
  await renderStill({
    composition, serveUrl: warm.serveUrl, output: outPath, frame: 0, inputProps,
    imageFormat: "png",           // straight alpha(ffmpeg overlay に必要)
    puppeteerInstance: warm.browser, overwrite: true, logLevel: "warn",
  });
  return outPath;
}
