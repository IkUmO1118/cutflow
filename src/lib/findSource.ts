import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileRole } from "./files.ts";
import { readManifestSource } from "./remuxDup.ts";

// 実害(2026-07-28): ~/Movies/framewright/2026-07-21 に 7/23 のベイクが残した
// `.preview-cut.mp4.publish-29218.tmp.mp4`(2560×720・15.6秒)があり、
// ドット始まりで readdirSync の一覧先頭に来たためこれが元収録として
// ingest された。manifest.json の source と durationSec(15.6) が差し替わり、
// audio/mic.wav が15.6秒で上書きされた(元は645秒)。一時ファイル削除+
// 再ingestで復旧済みだが、除外が無ければ同じ事故はどの収録でも起こる
// (R4 §1.5)。ドットファイル・一時ファイル(.tmp.を含む名前)・FrameWright
// 自身の生成物(files.tsのfileRole==="generated")・final.mp4(成果物。
// fileRoleはgeneratedにならないため明示除外)を候補から除く

/** 収録フォルダ内の raw ファイル(mkv/mp4/mov)を見つける。cli.ts の
 * ingest/run と bootstrap(editor 起動時の自動 ingest)が共有する。
 * manifest.json が既にあり manifest.source が実在するならそれを最優先で
 * 返す(§2-8。再 ingest でソースが勝手に乗り換わらないようにする) */
export function findSource(dir: string): string {
  const manifestSource = readManifestSource(dir);
  if (manifestSource !== null && existsSync(join(dir, manifestSource))) {
    return manifestSource;
  }

  const rawCandidates = readdirSync(dir).filter((f) => /\.(mkv|mp4|mov)$/i.test(f));
  if (rawCandidates.length === 0) {
    throw new Error(`${dir} に動画ファイル(mkv/mp4/mov)がありません`);
  }

  const candidates = rawCandidates.filter(
    (f) => !f.startsWith(".") && !f.includes(".tmp.") && fileRole(f) !== "generated" && f !== "final.mp4",
  );
  if (candidates.length === 0) {
    throw new Error(
      `${dir} に元収録らしいファイルがありません` +
        `(除外した候補: ${rawCandidates.join(", ")})`,
    );
  }

  if (candidates.length > 1) {
    // raw.* を優先、それ以外は最初の1本
    const raw = candidates.find((f) => f.startsWith("raw."));
    if (raw) return raw;
    console.warn(`動画が複数あります。${candidates[0]} を使います。`);
  }
  return candidates[0];
}
