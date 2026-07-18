/**
 * 動画素材のコーデックからブラウザ(素材パネルのサムネイル・Remotion Player)
 * 表示可否を判定する純関数。I/O は一切行わない(ffprobe を叩く層は
 * editor/server.ts の probeVideoCodec が担う)。最終レンダーは ffmpeg/Remotion
 * が別途デコードするため、ここでの判定は編集プレビューの見え方だけに影響する。
 */

/** ffprobe から取り出す動画ストリームの生事実(v:0 の1本ぶん)。
 * すべて optional=ffprobe が返さない/失敗したケースを表す */
export interface VideoCodecFacts {
  codecName?: string; // ffprobe codec_name: "h264" | "hevc" | "prores" | "vp9" | ...
  pixFmt?: string; // ffprobe pix_fmt:   "yuv420p" | "yuv422p10le" | "yuva420p" | ...
  profile?: string; // ffprobe profile:   "High" | "Main 10" | "HQ" | ...
}

/** ブラウザ表示可否の判定結果。reason は非表示のときだけ埋める(UI 文言のもと) */
export interface DisplayVerdict {
  browserDisplayable: boolean;
  codec: string; // 正規化した表示名(codecName ?? "unknown")
  reason?: string; // 非表示理由。日本語(placeholder / banner がそのまま使う短句)
}

/** ブラウザ(<video> / Remotion Player の Chromium)で確実に再生できる codec。
 * av1 は「楽観的な許可」(モダン Chromium 前提。ヘタるようなら denylist へ
 * 一行で移せる) */
const DISPLAYABLE = new Set(["h264", "avc1", "vp8", "vp9", "av1"]);

/** 非表示理由(既知の codec のみ)。すべて「最終レンダーには問題なく使えます」で
 * 締め、壊れた素材だと誤解させない */
const NOT_DISPLAYABLE_REASON: Record<string, string> = {
  prores: "ProRes は編集プレビューに映りません(最終レンダーには問題なく使えます)",
  hevc: "HEVC/H.265 は編集プレビューに映りません(最終レンダーには問題なく使えます)",
  h265: "HEVC/H.265 は編集プレビューに映りません(最終レンダーには問題なく使えます)",
  hvc1: "HEVC/H.265 は編集プレビューに映りません(最終レンダーには問題なく使えます)",
  mpeg2video: "MPEG-2 は編集プレビューに映りません(最終レンダーには問題なく使えます)",
  dnxhd: "DNxHD は編集プレビューに映りません(最終レンダーには問題なく使えます)",
  mjpeg: "MJPEG は編集プレビューに映りません(最終レンダーには問題なく使えます)",
  ffv1: "FFV1 は編集プレビューに映りません(最終レンダーには問題なく使えます)",
  rawvideo: "無圧縮(rawvideo)は編集プレビューに映りません(最終レンダーには問題なく使えます)",
  vc1: "VC-1 は編集プレビューに映りません(最終レンダーには問題なく使えます)",
};

/** pix_fmt が >8bit(10/12bit)を示すか。10bit H.264(High 10)・HEVC 10bit 等、
 * codec_name だけでは無害に見えるケースを拾うための補助判定 */
export function isHighBitDepth(pixFmt: string | undefined): boolean {
  if (!pixFmt) return false;
  return /10le|10be|12le|12be|p010|p210|p016/i.test(pixFmt);
}

export function classifyBrowserDisplayable(facts: VideoCodecFacts): DisplayVerdict {
  const codec = (facts.codecName ?? "").toLowerCase();
  // 未知/欠落 codec は誤警告を避けて表示可能扱い(degrade quietly)。
  // 「表示できないと誤って警告する」より「本当は映らないのに黙る」ほうが
  // ましというのがこの機能の失敗モード選択(§1.1)
  if (!codec) return { browserDisplayable: true, codec: "unknown" };
  if (DISPLAYABLE.has(codec)) {
    if (isHighBitDepth(facts.pixFmt)) {
      return {
        browserDisplayable: false,
        codec,
        reason: "10bit 映像は編集プレビューに映りません(最終レンダーには問題なく使えます)",
      };
    }
    return { browserDisplayable: true, codec };
  }
  const known = NOT_DISPLAYABLE_REASON[codec];
  if (known) return { browserDisplayable: false, codec, reason: known };
  // denylist に無い未知の codec も positive-match-only 方針で表示可能扱い
  return { browserDisplayable: true, codec };
}
