// remotion/OverlayStill.tsx — render 高速パスが焼く「素材オーバーレイ1件の
// 時間不変なレイヤー画」。**node 専用モジュールを import しないこと**
// (このファイルは Root.tsx からブラウザバンドルへ入るので、src/lib/overlayStill.ts
// のような node:fs / @remotion/renderer を引く側を import すると
// frames / editor / render のバンドルが丸ごと壊れる)。overlayStillItem は
// ブラウザ安全な src/lib/overlayFade.ts から取る
import { AbsoluteFill } from "remotion";
import { OverlayItemView } from "./OverlayLayer.tsx";
import { overlayStillItem } from "../src/lib/overlayFade.ts";
import type { OverlayItem } from "./props.ts";

export type OverlayStillProps = {
  width: number;
  height: number;
  /** 素材1件。時間変化する要素(fade/opacity/keyframes)は overlayStillItem が剥がす */
  item: OverlayItem;
  fps: number;
};

/** 素材オーバーレイ1件を「opacity=1・フェード無し」の**時間不変なレイヤー画**として
 * 焼く。時間変化する alpha スカラーは ffmpeg 側(fastSegment)が掛ける。
 * OverlayItemView を再利用するので rect 有無の分岐・黒背景・objectFit は
 * Main.tsx と同一 JSX(=同一 DOM)になる */
export const OverlayStill = (p: OverlayStillProps) => (
  <AbsoluteFill style={{ backgroundColor: "transparent" }}>
    <OverlayItemView item={overlayStillItem(p.item)} fps={p.fps} />
  </AbsoluteFill>
);

export const overlayStillDefaultProps: OverlayStillProps = {
  width: 1920,
  height: 1080,
  item: { start: 0, end: 1, file: "", track: 1, fit: "contain" },
  fps: 30,
};
