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
 * h264_videotoolbox が圧縮セッションを作れる各辺の上限(px)。これを超える
 * と ffmpeg は "Cannot create compression session: -12903" で落ちる。
 */
const MAX_ENCODE_DIMENSION = 4096;

/**
 * proxy.mp4 / preview.mp4 の縮小 scale フィルタ。cfg.preview.width は
 * 「拡張キャンバス(画面+カメラ横並び)をこの幅へ縮小する」ための値なので、
 * 幅をそのまま指定すると縦長の収録(1080x1920 等)では逆に拡大され、
 * 高さが h264_videotoolbox の上限(4096px)を超えてエンコーダが開けない。
 *
 * そこで「幅 cfg.preview.width」ではなく「幅 cfg.preview.width かつ各辺
 * MAX_ENCODE_DIMENSION に収まる箱へ、アスペクト比を保って縮小のみする」と
 * 表現する(min(...,iw) で拡大を禁じる=元より粗くならず、無駄に大きな
 * プロキシも作らない)。横長の収録では従来どおり cfg.preview.width へ縮小
 * されるので既存の挙動は変わらない。
 */
export function scaleFilter(cfg: Pick<Config, "preview">): string {
  return [
    `scale=w='min(${cfg.preview.width},iw)'`,
    `h='min(${MAX_ENCODE_DIMENSION},ih)'`,
    "force_original_aspect_ratio=decrease",
    "force_divisible_by=2",
  ].join(":");
}

/**
 * proxy.mp4 の GOP(キーフレーム間隔、フレーム数)。0.2秒@30fps。
 * エディタはカット境界ごとに <video> をシークして繋ぐため、GOP が長いと
 * 境界のたびに直前キーフレームからのデコード待ち(1秒 GOP で最大29枚)が
 * ヒッチとして見える。6 なら最大5枚で、premount が隠しきれない環境
 * (Safari は非表示 video にフレームを供給しない)でも知覚されにくい。
 * 代償はファイルサイズ(I フレーム増)だが、プロキシは再生成可能な
 * キャッシュなので許容する。preview.mp4(人間が通しで見る確認動画)は
 * 既定の 30(1秒)のまま
 */
export const PROXY_GOP_FRAMES = 6;

/**
 * proxy.mp4 / preview.mp4 のビデオエンコード ffmpeg 引数。
 * GOP は既定1秒(-g 30。opts.gopFrames で上書き=プロキシは PROXY_GOP_FRAMES)、
 * +faststart はブラウザの初期ロード短縮のため、エンコーダに依らず必ず付ける。
 * videotoolbox の品質指定は crf ではなく -q:v(0〜100、大きいほど高品質)。
 * 品質値(-q:v 65 / -crf 24)は、エディタのプレビューがプロキシを
 * アップスケール表示する(=圧縮ノイズも拡大される)前提の水準。
 * 旧値(-q:v 50 / -crf 28)は幅1280のプロキシ時代の「確認には十分」水準
 */
export function videoEncodeArgs(
  cfg: Pick<Config, "preview">,
  opts?: { gopFrames?: number },
): string[] {
  const codecArgs =
    resolveVideoEncoder(cfg) === "libx264"
      ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24"]
      : ["-c:v", "h264_videotoolbox", "-q:v", "65"];
  return [...codecArgs, "-g", String(opts?.gopFrames ?? 30), "-movflags", "+faststart"];
}
