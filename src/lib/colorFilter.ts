// lib/colorFilter.ts — 簡易カラー調整(overlays.json の colorFilter)を CSS
// filter 文字列に変換する純関数。remotion/Main.tsx がベース映像(画面クロップ+
// カメラ=同一収録動画)だけに適用する。未指定・全既定(1.0)なら undefined
// (フィルタ無し=既存の描画と完全に同じ)。
import type { ColorFilter } from "../types.ts";

export function cssFilterOf(cf?: ColorFilter): string | undefined {
  if (!cf) return undefined;
  const brightness = cf.brightness ?? 1;
  const contrast = cf.contrast ?? 1;
  const saturate = cf.saturate ?? 1;
  if (brightness === 1 && contrast === 1 && saturate === 1) return undefined;
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturate})`;
}

// ---- P5-3: render 高速パス向け ffmpeg 写像 -------------------------------
//
// colorFilter({brightness, contrast, saturate})を ffmpeg の RGB 段
// (lutrgb + colorchannelmixer)へ写す純関数。コーディネータが headless
// Chrome と ffmpeg を直接突き合わせて実測(PSNR 55.5dB)した写像を実装する
// (design-T3.md §1・§2。数式・係数・差し込み位置は再導出しない)。
//
// 【制約】このファイルは remotion/Main.tsx が import する = ブラウザバンドルに
// 載る。node:* や @remotion/renderer 等の node 専用モジュールを絶対に
// import しないこと(webpack が壊れ、typecheck も npm test もすり抜ける)。

/** ffmpeg 側の colorFilter 写像の結果。
 * - none        : 無補正(cssFilterOf が undefined を返すのと同値)
 * - chain       : 適用順のフィルタ列(RGB 段で使う。format 変換は呼び出し側)
 * - unsupported : ffmpeg のフィルタで表現できない(fastPlan が全編フォールバック) */
export type FfmpegColorPlan =
  | { kind: "none" }
  | { kind: "chain"; filters: string[] }
  | { kind: "unsupported"; reason: string };

/** filter-effects 仕様の saturate 行列の輝度係数(BT.709 の 0.2126/0.7152/0.0722 でも
 * 実測差は無かったが、仕様準拠のこちらを採る) */
const LUM_R = 0.213;
const LUM_G = 0.715;
const LUM_B = 0.072;

/** colorchannelmixer の係数許容レンジ(ffmpeg の AVOption 定義) */
const MIX_MIN = -2;
const MIX_MAX = 2;

/** filtergraph に埋める数値の整形(指数表記・浮動小数のゴミを出さない) */
function fmt(n: number): string {
  return String(Number(n.toFixed(6)));
}

/** CSS の brightness/contrast/saturate を ffmpeg のフィルタ列へ写す純関数。
 * cssFilterOf と同じ入力から同じ意味の出力を作る(test/colorFilter.test.ts の
 * 不変条件テストで固定)。
 * 数式(sRGB 値 v ∈ [0,1] に対して。実測で Chrome と PSNR 55.5dB 一致):
 *   lutrgb            : v' = clip((v*B - 0.5)*C + 0.5, 0, 1)
 *   colorchannelmixer : feColorMatrix の saturate 行列(3x3)
 * 恒等成分は出力しない(B=C=1 なら lutrgb 無し / S=1 なら mixer 無し)。 */
export function ffmpegColorFilterOf(cf?: ColorFilter): FfmpegColorPlan {
  if (!cf) return { kind: "none" };
  const b = cf.brightness ?? 1;
  const c = cf.contrast ?? 1;
  const s = cf.saturate ?? 1;
  if (b === 1 && c === 1 && s === 1) return { kind: "none" };

  const filters: string[] = [];

  if (b !== 1 || c !== 1) {
    // 1つの LUT に brightness と contrast を合成(コーディネータ実測の形)
    const expr = `clip((val/255*${fmt(b)}-0.5)*${fmt(c)}+0.5,0,1)*255`;
    filters.push(`lutrgb=r='${expr}':g='${expr}':b='${expr}'`);
  }

  if (s !== 1) {
    const co = {
      rr: LUM_R + (1 - LUM_R) * s,
      rg: LUM_G * (1 - s),
      rb: LUM_B * (1 - s),
      gr: LUM_R * (1 - s),
      gg: LUM_G + (1 - LUM_G) * s,
      gb: LUM_B * (1 - s),
      br: LUM_R * (1 - s),
      bg: LUM_G * (1 - s),
      bb: LUM_B + (1 - LUM_B) * s,
    };
    const bad = Object.entries(co).filter(([, v]) => v < MIX_MIN || v > MIX_MAX);
    if (bad.length > 0) {
      return {
        kind: "unsupported",
        reason: `saturate=${fmt(s)} は ffmpeg colorchannelmixer の係数レンジ [${MIX_MIN},${MIX_MAX}] 外(${bad
          .map(([k, v]) => `${k}=${fmt(v)}`)
          .join(" ")})`,
      };
    }
    filters.push(
      `colorchannelmixer=${(Object.keys(co) as (keyof typeof co)[])
        .map((k) => `${k}=${fmt(co[k])}`)
        .join(":")}`,
    );
  }

  return { kind: "chain", filters };
}
