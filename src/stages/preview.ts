import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import {
  audioSourceOf,
  keepAudioParts,
  measuredLoudnormFilter,
} from "../lib/loudness.ts";
import { playbackSegmentsOf } from "../lib/timeline.ts";
import { scaleFilter, videoEncodeArgs } from "../lib/videoEncode.ts";
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

  const keeps = playbackSegmentsOf(cutplan);
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
      `[0:v]trim=start=${k.start}:end=${k.end},setpts=${
        k.speed === 1 ? "PTS-STARTPTS" : `(PTS-STARTPTS)/${k.speed}`
      }[v${i}]`,
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
    `[vc]${scaleFilter(cfg)}[vout]`,
    `[ac]${loudnorm}[aout]`,
  );

  const output = join(dir, "preview.mp4");
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", join(dir, manifest.source),
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    // -g 30: キーフレーム間隔を1秒に。人間が通しで見て時々シークする用途
    // なのでこれで十分(エディタの再生はプロキシ側=proxy.mp4 が担う。
    // そちらはカット境界シークのため、より短い GOP を使う)
    ...videoEncodeArgs(cfg),
    // loudnorm は内部で 192kHz にアップサンプルするため 48kHz に戻す
    "-c:a", "aac", "-ar", "48000",
    output,
  ]);
  // 生成元の keep 区間(境界のみ)を記録する。エディタが「preview.mp4 が
  // いまの cutplan と合っているか」を、保存→リロード後でも判定できるように
  writeFileSync(
    join(dir, "preview.keeps.json"),
    JSON.stringify(
      keeps.map((k) => ({
        start: k.start,
        end: k.end,
        ...(k.speed !== 1 ? { speed: k.speed } : {}),
      })),
      null,
      2,
    ),
  );
  return output;
}
