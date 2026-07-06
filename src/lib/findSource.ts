import { readdirSync } from "node:fs";

/** 収録フォルダ内の raw ファイル(mkv/mp4/mov)を見つける。cli.ts の
 * ingest/run と bootstrap(editor 起動時の自動 ingest)が共有する */
export function findSource(dir: string): string {
  const candidates = readdirSync(dir).filter((f) =>
    /\.(mkv|mp4|mov)$/i.test(f),
  );
  if (candidates.length === 0) {
    throw new Error(`${dir} に動画ファイル(mkv/mp4/mov)がありません`);
  }
  if (candidates.length > 1) {
    // raw.* を優先、それ以外は最初の1本
    const raw = candidates.find((f) => f.startsWith("raw."));
    if (raw) return raw;
    console.warn(`動画が複数あります。${candidates[0]} を使います。`);
  }
  return candidates[0];
}
