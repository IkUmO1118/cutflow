import type { Config } from "./config.ts";

/**
 * 有効なビデオエンコーダを platform + config から一意に決める単一の出所。
 * - cfg.preview.videoEncoder が明示指定されていれば常にそれを尊重する。
 * - 未指定(既定)のときだけ platform で分岐する:
 *   macOS(darwin)= videotoolbox(HW エンコーダ)、それ以外 = libx264。
 * これで非 mac の ffmpeg に h264_videotoolbox が無くて proxy/preview/cut が
 * 落ちる初手破綻(A2)を、config 手編集なしに恒久修正する。
 */
export function resolveVideoEncoder(
  cfg: Pick<Config, "preview">,
): "libx264" | "videotoolbox" {
  const explicit = cfg.preview.videoEncoder;
  if (explicit) return explicit;
  return process.platform === "darwin" ? "videotoolbox" : "libx264";
}

/**
 * proxy.mp4 / preview.mp4 のビデオエンコード ffmpeg 引数。
 * GOP 1秒(-g 30)は Player のシーク軽量化のため、+faststart は
 * ブラウザの初期ロード短縮のため、エンコーダに依らず必ず両方付ける。
 * videotoolbox の品質指定は crf ではなく -q:v(0〜100、大きいほど高品質)。
 */
export function videoEncodeArgs(cfg: Pick<Config, "preview">): string[] {
  const codecArgs =
    resolveVideoEncoder(cfg) === "libx264"
      ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"]
      : ["-c:v", "h264_videotoolbox", "-q:v", "50"];
  return [...codecArgs, "-g", "30", "-movflags", "+faststart"];
}
