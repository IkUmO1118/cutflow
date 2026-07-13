// lib/annotationStill.ts — render 高速パスが使う、注釈グラフィック1件を
// 「時間不変なレイヤー画」として透過 PNG に焼くラッパー。overlayStill.ts と
// 同じ WarmAssets(bundle + headless Chrome)を再利用する。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import { annotationStillItem } from "./annotation.ts";
import type { WarmAssets } from "../stages/frames.ts";
import type { ResolvedAnnotation } from "../../remotion/props.ts";
import type { AnnotationStillProps } from "../../remotion/AnnotationStill.tsx";

export const ANNOTATION_STILL_DIR = "render.fast/annotations";

// annotationStillItem(時刻/keyframes を剥がす純関数)の定義はブラウザ安全な
// annotation.ts に置く(remotion/AnnotationStill.tsx も使うため。このファイルは
// node 専用 = ブラウザバンドルへ引き込めない)。既存 import 経路のために
// ここから re-export する(二重定義はしない)
export { annotationStillItem };

/** 注釈レイヤー画の内容アドレスキー。**正規化後の annotation 全フィールド +
 * 出力解像度**だけで決まる(start/end/keyframes は annotationStillItem が
 * 落とすのでキャッシュを汚さない)。overlayStillKey と違い外部ファイルを
 * 参照しないので fs には触れない=純関数 */
export function annotationStillKey(args: {
  annotation: ResolvedAnnotation; width: number; height: number;
}): string {
  const canon = {
    w: args.width,
    h: args.height,
    item: annotationStillItem(args.annotation),
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

export function annotationStillPath(args: {
  dir: string; annotation: ResolvedAnnotation; width: number; height: number;
}): string {
  return join(args.dir, ANNOTATION_STILL_DIR, `${annotationStillKey(args)}.png`);
}

/** 1件の注釈レイヤー画を(キャッシュに無ければ)レンダーし、絶対パスを返す */
export async function renderAnnotationStill(args: {
  dir: string; annotation: ResolvedAnnotation; width: number; height: number; warm: WarmAssets;
}): Promise<string> {
  const { dir, annotation, width, height, warm } = args;
  const outPath = annotationStillPath({ dir, annotation, width, height });
  if (existsSync(outPath)) return outPath;
  mkdirSync(dirname(outPath), { recursive: true });
  const stillProps: AnnotationStillProps = {
    width, height, annotation: annotationStillItem(annotation),
  };
  const inputProps = stillProps as unknown as Record<string, unknown>;
  const composition = await selectComposition({
    serveUrl: warm.serveUrl, id: "AnnotationStill", inputProps,
    puppeteerInstance: warm.browser, logLevel: "warn",
  });
  await renderStill({
    composition, serveUrl: warm.serveUrl, output: outPath, frame: 0, inputProps,
    imageFormat: "png",           // straight alpha(ffmpeg overlay に必要)
    puppeteerInstance: warm.browser, overwrite: true, logLevel: "warn",
  });
  return outPath;
}
