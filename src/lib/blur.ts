// lib/blur.ts — 領域ぼかし(overlays.json の blurs)の強度→px 換算。
// remotion/Main.tsx が使う純関数。テストで数値を固定する。

/** blur のぼかし半径(出力px)。strength 0→軽い、1→強い。開発画面の等幅
 * フォントが読めなくなる程度を 0.5 の既定に置く。出力幅にほぼ依存しない
 * 絶対 px(小さい矩形でも十分ぼける) */
export function blurRadiusPx(strength: number): number {
  return Math.round(4 + clamp01(strength) * 36); // 0→4px, 0.5→22px, 1→40px
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
