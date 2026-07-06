import { join } from "node:path";
import type { RenderProps } from "../../remotion/props.ts";

/**
 * final.mp4 全スキップキャッシュ(render.key.json)の中身。
 * buildRenderProps の返り値(テロップ・演出・BGM配置など編集内容そのもの)+
 * cut.mp4 と参照素材ファイルの mtime/size + hardwareAcceleration 設定が
 * すべて前回の render と一致すれば、Remotion 実行そのものを丸ごとスキップ
 * できる(cutCache.ts と同じ「JSON.stringify 一致」判定)
 */
export interface RenderCacheKey {
  props: RenderProps;
  cut: { mtimeMs: number; size: number };
  materials: { file: string; mtimeMs: number; size: number }[];
  hardwareAcceleration: string;
}

/** props が参照する素材ファイル(overlays[].file / inserts[].file /
 * bgm[].file)を重複なく列挙する。ソートして順序を固定し、挿入順の違いで
 * JSON.stringify 比較が揺れないようにする */
export function materialFilesOf(props: RenderProps): string[] {
  const files = new Set<string>();
  for (const o of props.overlays) files.add(o.file);
  for (const i of props.inserts ?? []) files.add(i.file);
  for (const b of props.bgm) files.add(b.file);
  return [...files].sort();
}

export function buildRenderCacheKey(args: {
  props: RenderProps;
  dir: string;
  cut: { mtimeMs: number; size: number };
  hardwareAcceleration: string;
  statFile: (path: string) => { mtimeMs: number; size: number };
}): RenderCacheKey {
  const { props, dir, cut, hardwareAcceleration, statFile } = args;
  const materials = materialFilesOf(props).map((file) => ({
    file,
    ...statFile(join(dir, file)),
  }));
  return { props, cut, materials, hardwareAcceleration };
}

/** 2つのキャッシュキーが一致するか(一致すれば final.mp4 を再利用してよい) */
export function renderCacheKeyEquals(a: RenderCacheKey, b: RenderCacheKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
