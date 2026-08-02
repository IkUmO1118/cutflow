// thumbnail.json から、最終合成と同じ見た目機構でサムネイル静止画
// (thumbnail.png)を書き出す。t は元収録の秒で、frames と違いスナップしない
// (カットされた瞬間も指定できる。サムネは動画に入っていない絵も使ってよい)。
//
// 仕組み: M4 エンジン(WebGPU compositor + CDP capture)で1フレームを書き出す。
//
// ベースはフル解像度の元収録(manifest.source)。keep を全編+videoIsSource:true
// で、カットの有無に関わらずどの瞬間も使える。テロップは transcript を使わず
// thumbnail.json の texts だけを描画し、各テキストに専用トラックを割り当てて
// 全件同時表示にする。overlays.json からは wipeFull・zooms・colorFilter だけ
// を継承する。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCanvas } from "../lib/profile.ts";
import { buildRenderProps } from "../lib/renderProps.ts";
import { renderCfgWithDesign } from "../lib/designAsset.ts";
import { createEngineSession } from "../lib/engineSession.ts";
import { buildTimeline, toOutputTime } from "../lib/timeline.ts";
import type { Config } from "../lib/config.ts";
import type { Manifest, Overlays, Thumbnail, Transcript } from "../types.ts";

export async function thumbnail(dir: string, cfg: Config): Promise<string> {
  return thumbnailEngine(dir, cfg);
}

function buildThumbnailProps(dir: string, cfg: Config): { props: ReturnType<typeof buildRenderProps>; thumb: Thumbnail } {
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

  const keeps = [{ start: 0, end: manifest.durationSec }];
  // thumbnail.t は「元収録の秒」だが renderAndCapture は出力秒を取る。
  // keeps を全編にすることで写像を恒等にしているため、前提を実行時に固定する。
  const tl = buildTimeline(keeps);
  const mapped = toOutputTime(thumb.t, tl);
  if (mapped === null || Math.abs(mapped - thumb.t) > 0.01) {
    throw new Error(
      `thumbnail: 時刻写像が恒等ではありません(t=${thumb.t} → ${mapped})。` +
        "thumbnail.ts の keeps 構築を見直してください",
    );
  }
  const transcript: Transcript = {
    language: "", model: "",
    segments: thumb.texts.map((t, i) => ({
      start: 0, end: manifest.durationSec, text: t.text, track: i + 1,
      pos: t.pos, ...(t.style ? { style: t.style } : {}),
    })),
  };
  const overlays: Overlays = {
    ...(mainOverlays.wipeFull ? { wipeFull: mainOverlays.wipeFull } : {}),
    ...(mainOverlays.zooms ? { zooms: mainOverlays.zooms } : {}),
    ...(mainOverlays.colorFilter ? { colorFilter: mainOverlays.colorFilter } : {}),
  };

  const profile = resolveCanvas(manifest);
  const props = buildRenderProps({
    manifest, keeps, transcript, overlays,
    renderCfg: renderCfgWithDesign(dir, cfg),
    width: profile.width, height: profile.height, profile,
    videoFile: manifest.source, videoIsSource: true,
    bgm: null, bgmFallbackFile: null,
    overlayExists: (f) => existsSync(join(dir, f)),
    warn: (msg) => console.warn(`警告: ${msg}`),
  });
  return { props, thumb };
}

/** M4: エンジン経路の thumbnail 実装。createEngineSession で
 * ヘッドレス Chrome を起動し、t で指定された1フレームを capture → PNG。 */
async function thumbnailEngine(dir: string, cfg: Config): Promise<string> {
  const { props, thumb } = buildThumbnailProps(dir, cfg);

  const sourceUrls: Record<string, string> = {
    [props.videoFile]: `/${props.videoFile}`,
  };
  const session = await createEngineSession(dir, {
    props,
    sourceUrls,
  });

  try {
    const pngBase64 = await session.renderAndCapture(thumb.t);
    const outPath = join(dir, "thumbnail.png");
    writeFileSync(outPath, Buffer.from(pngBase64, "base64"));
    return outPath;
  } finally {
    await session.close();
  }
}
