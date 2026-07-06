import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import {
  audioSourceOf,
  keepAudioParts,
  measuredLoudnormFilter,
} from "../lib/loudness.ts";
import { mergeIntervals } from "../lib/timeline.ts";
import { videoEncodeArgs } from "../lib/videoEncode.ts";
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

  // エディタの分割編集で同じ境界のまま割れている keep は1つに繋いで扱う
  // (映像は同一なので、ffmpeg の継ぎ目と stale 判定のぶれを作らない)
  const keeps = mergeIntervals(cutplan.segments.filter((s) => s.action === "keep"));
  if (keeps.length === 0) {
    throw new Error("keep 区間が0件です(cutplan.json を確認してください)");
  }

  // 区間ごとに trim して concat する filter_complex を組み立てる。
  // 音声はマイク+システム音声のミックス(cut.mp4 と共通の構成)
  const source = audioSourceOf(manifest, cfg);
  const parts: string[] = [];
  const labels: string[] = [];
  keeps.forEach((k, i) => {
    parts.push(
      `[0:v]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(...keepAudioParts(source, keeps));
  // 音声は cut.mp4(最終レンダー)と同じ実測ラウドネス正規化で揃える。
  // エディタで聞く音量=最終出力の音量になる(実測パスは音声のみで数秒)
  const loudnorm = await measuredLoudnormFilter({
    input: join(dir, manifest.source),
    source,
    keeps,
    targetLufs: cfg.render.targetLufs,
  });
  parts.push(
    `${labels.join("")}concat=n=${keeps.length}:v=1:a=1[vc][ac]`,
    `[vc]scale=${cfg.preview.width}:-2[vout]`,
    `[ac]${loudnorm}[aout]`,
  );

  const output = join(dir, "preview.mp4");
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", join(dir, manifest.source),
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    // -g 30: キーフレーム間隔を1秒に。エディタが preview.mp4 をプロキシとして
    // 再生するため、細かいシークが軽くなるようにしておく
    // (+faststart で moov を先頭に置き、ブラウザの初期ロードも速くする)
    ...videoEncodeArgs(cfg),
    // loudnorm は内部で 192kHz にアップサンプルするため 48kHz に戻す
    "-c:a", "aac", "-ar", "48000",
    output,
  ]);
  // 生成元の keep 区間(境界のみ)を記録する。エディタが「preview.mp4 が
  // いまの cutplan と合っているか」を、保存→リロード後でも判定できるように
  writeFileSync(
    join(dir, "preview.keeps.json"),
    JSON.stringify(keeps.map((k) => ({ start: k.start, end: k.end })), null, 2),
  );
  return output;
}
