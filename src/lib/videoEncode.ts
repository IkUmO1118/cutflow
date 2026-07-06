import type { Config } from "./config.ts";

/**
 * proxy.mp4 / preview.mp4 のビデオエンコード ffmpeg 引数。
 * GOP 1秒(-g 30)は Player のシーク軽量化のため、+faststart は
 * ブラウザの初期ロード短縮のため、エンコーダに依らず必ず両方付ける。
 * videotoolbox の品質指定は crf ではなく -q:v(0〜100、大きいほど高品質)。
 */
export function videoEncodeArgs(cfg: Pick<Config, "preview">): string[] {
  const codecArgs =
    cfg.preview.videoEncoder === "libx264"
      ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"]
      : ["-c:v", "h264_videotoolbox", "-q:v", "50"];
  return [...codecArgs, "-g", "30", "-movflags", "+faststart"];
}
