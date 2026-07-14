// thumbnail.json から、最終合成と同じ見た目機構でサムネイル静止画
// (thumbnail.png)を書き出す。t は元収録の秒で、frames と違いスナップしない
// (カットされた瞬間も指定できる。サムネは動画に入っていない絵も使ってよい)。
//
// ベースは frames.ts のプロキシ経路と違い元収録(フル解像度)を使う
// (サムネは静止画1枚の可読性が命なので proxy 品質では出さない)。keep を
// 全編(元収録まるごと)にして videoIsSource で再生することで、カットの
// 有無に関わらずどの瞬間も使える。テロップは transcript を使わず
// thumbnail.json の texts だけを描画し、各テキストに専用トラックを割り当てて
// 全件同時表示にする。overlays.json からはワイプ(wipeFull)・zooms・
// colorFilter だけを継承する(素材・インサート・字幕非表示・レイヤー順は
// 対象外。サムネは「収録の見た目」の一枚絵のため)。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  openBrowser,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { resolveProfile } from "../lib/profile.ts";
import { buildRenderProps } from "../lib/renderProps.ts";
import { renderCfgWithDesign } from "../lib/designAsset.ts";
import type { Config } from "../lib/config.ts";
import type { Manifest, Overlays, Thumbnail, Transcript } from "../types.ts";

export async function thumbnail(dir: string, cfg: Config): Promise<string> {
  const readJson = <T>(file: string, required: boolean): T | null => {
    const p = join(dir, file);
    if (!existsSync(p)) {
      if (required) throw new Error(`${file} がありません`);
      return null;
    }
    return JSON.parse(readFileSync(p, "utf8")) as T;
  };
  const manifest = readJson<Manifest>("manifest.json", true)!;
  const thumb = readJson<Thumbnail>("thumbnail.json", true)!;
  const mainOverlays = readJson<Overlays>("overlays.json", false) ?? {};

  // ベース映像は元収録そのもの(フル解像度)。keep=全編+videoIsSource:true
  // により、t(元収録の秒)がそのまま出力秒になる(カットの有無を問わない)
  const keeps = [{ start: 0, end: manifest.durationSec }];

  // テロップは texts のみ(transcript は使わない)。1トラックは同時に1件
  // しか表示できないため、全件同時に出すには専用トラックを割り当てる
  const transcript: Transcript = {
    language: "",
    model: "",
    segments: thumb.texts.map((t, i) => ({
      start: 0,
      end: manifest.durationSec,
      text: t.text,
      track: i + 1,
      pos: t.pos,
      ...(t.style ? { style: t.style } : {}),
    })),
  };

  // ワイプ・zooms・colorFilter だけを本編 overlays.json から継承する
  const overlays: Overlays = {
    ...(mainOverlays.wipeFull ? { wipeFull: mainOverlays.wipeFull } : {}),
    ...(mainOverlays.zooms ? { zooms: mainOverlays.zooms } : {}),
    ...(mainOverlays.colorFilter ? { colorFilter: mainOverlays.colorFilter } : {}),
  };

  const profile = resolveProfile(manifest.video.screenRegion, "default");
  const props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays,
    renderCfg: renderCfgWithDesign(dir, cfg),
    width: profile.width,
    height: profile.height,
    profile,
    videoFile: manifest.source,
    videoIsSource: true,
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: (f) => existsSync(join(dir, f)),
    warn: (msg) => console.warn(`警告: ${msg}`),
  });

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  await ensureBrowser();
  const serveUrl = await bundle({
    entryPoint: join(repoRoot, "remotion", "index.ts"),
    publicDir: dir,
    symlinkPublicDir: true,
  });
  const inputProps = props as unknown as Record<string, unknown>;
  const browser = await openBrowser("chrome");
  const outPath = join(dir, "thumbnail.png");
  try {
    const composition = await selectComposition({
      serveUrl,
      id: "Main",
      inputProps,
      puppeteerInstance: browser,
      logLevel: "warn",
    });
    const lastFrame = Math.max(0, Math.round(props.durationSec * props.fps) - 1);
    const frame = Math.min(lastFrame, Math.max(0, Math.round(thumb.t * props.fps)));
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
  } finally {
    await browser.close({ silent: true });
  }
  return outPath;
}
