import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import type { Config } from "../lib/config.ts";
import type { CutPlan, Manifest } from "../types.ts";

/**
 * cutplan.json の keep 区間だけを繋いだ低解像度の確認動画(preview.mp4)を
 * 作る。承認ゲートの判断材料で、approved が false でも実行できる
 * (むしろ承認前に見るためのもの)。
 *
 * キャンバス全体(画面+カメラ横並び)を縮小して出すので、カットの
 * テンポと見せ場の生き残りをここで確認し、必要なら cutplan.json を
 * 手で直して再実行する。
 */
export async function preview(dir: string, cfg: Config): Promise<string> {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const planPath = join(dir, "cutplan.json");
  if (!existsSync(planPath)) {
    throw new Error(`${planPath} がありません。先に plan を実行してください`);
  }
  const cutplan = JSON.parse(readFileSync(planPath, "utf8")) as CutPlan;

  const keeps = cutplan.segments.filter((s) => s.action === "keep");
  if (keeps.length === 0) {
    throw new Error("keep 区間が0件です(cutplan.json を確認してください)");
  }

  // 区間ごとに trim して concat する filter_complex を組み立てる
  const mic = manifest.audio.micStream;
  const parts: string[] = [];
  const labels: string[] = [];
  keeps.forEach((k, i) => {
    parts.push(
      `[0:v]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`,
      `[0:a:${mic}]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(
    `${labels.join("")}concat=n=${keeps.length}:v=1:a=1[vc][ac]`,
    `[vc]scale=${cfg.preview.width}:-2[vout]`,
  );

  const output = join(dir, "preview.mp4");
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", join(dir, manifest.source),
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-map", "[ac]",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-c:a", "aac",
    output,
  ]);
  return output;
}
