// エディタのプレビュー上に出るテロップ枠(CaptionOverlay の青い点線)の座標が、
// 実描画(src/engine/describeFrame.ts + src/engine/refPainter.ts)の字幕と
// 一致することを固定する。両者は別実装(DOM / canvas)なので、engine 側の
// 配置規約が変わるとここが落ちる=枠だけ取り残されるずれを検出できる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCaptionLayer } from "../src/engine/describeFrame.ts";
import { defaultProps } from "../src/lib/renderPropsTypes.ts";
import type { Caption, RenderProps } from "../src/lib/renderPropsTypes.ts";
import {
  captionBoxOffset,
  defaultCaptionPos,
  isInlineDraftTarget,
} from "../editor/client/model.ts";

const FONT = 48;
const base: RenderProps = {
  ...defaultProps,
  videoFile: "cut.mp4",
  width: 1920,
  height: 1080,
  canvas: { w: 1920, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  caption: { fontSizePx: FONT },
  wipe: { widthPx: 480, marginPx: 32 },
};

/** refPainter.ts drawCaption のテキストボックス高さ(行高)。DOM 側は
 * lineHeight:1.4 × fontSize で同じ高さになる */
const textH = (fontSizePx: number) => fontSizePx * 1.4;

/** engine が実際に描くテキストボックスの中心 y(placement を refPainter の
 * anchor 分岐へ通した結果)。CaptionOverlay の枠は中心基準で置かれるので、
 * ここが editor 側の pos と一致していなければならない */
function paintedCenterY(props: RenderProps, caption: Caption): number {
  const items = describeCaptionLayer(props, (caption.start + caption.end) / 2);
  const item = items[0];
  if (item.kind !== "rendered" || item.placement.mode !== "anchor") throw new Error("unreachable");
  const content = item.content;
  if (content.kind !== "caption") throw new Error("unreachable");
  const h = textH(content.fontSizePx);
  const { point, anchor } = item.placement;
  // refPainter: topLeft=boxY は point.y / center=point.y - h/2 / bottomCenter=point.y - h
  const boxY = anchor === "topLeft" ? point.y : anchor === "center" ? point.y - h / 2 : point.y - h;
  return boxY + h / 2;
}

test("defaultCaptionPos: 位置未指定テロップの中心が engine の実描画と一致する(カメラ有り)", () => {
  const caption: Caption = { start: 0, end: 10, text: "こんにちは", track: 1 };
  const props: RenderProps = {
    ...base,
    captions: [caption],
    cameraRegion: { x: 1920, y: 0, w: 480, h: 270 },
  };
  const pos = defaultCaptionPos({
    width: props.width,
    height: props.height,
    wipeWidthPx: props.wipe.widthPx,
    wipeMarginPx: props.wipe.marginPx,
    hasCamera: true,
    fontSizePx: FONT,
  });
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered" || items[0].placement.mode !== "anchor") throw new Error("unreachable");
  assert.equal(pos.x, Math.round(items[0].placement.point.x)); // ワイプ回避の予約込みの中央
  assert.equal(pos.y, Math.round(paintedCenterY(props, caption)));
});

test("defaultCaptionPos: カメラ無し(plain)は全幅中央", () => {
  const caption: Caption = { start: 0, end: 10, text: "こんにちは", track: 1 };
  const props: RenderProps = { ...base, captions: [caption] };
  const pos = defaultCaptionPos({
    width: props.width,
    height: props.height,
    wipeWidthPx: props.wipe.widthPx,
    wipeMarginPx: props.wipe.marginPx,
    hasCamera: false,
    fontSizePx: FONT,
  });
  assert.equal(pos.x, 960);
  assert.equal(pos.y, Math.round(paintedCenterY(props, caption)));
});

test("defaultCaptionPos: 座布団(background)は中心を動かさない", () => {
  // 座布団は boxY-pad/2 .. boxY+textH+pad/2 と対称にはみ出すだけなので、
  // padding のぶん中心を持ち上げてはいけない(旧 Remotion 経路の補正の名残)
  const caption: Caption = { start: 0, end: 10, text: "こんにちは", track: 1 };
  const withBg: RenderProps = {
    ...base,
    captions: [caption],
    caption: { fontSizePx: FONT, background: { color: "rgba(35,35,35,0.9)", paddingPx: 52 } },
  };
  const noBg: RenderProps = { ...base, captions: [caption] };
  assert.equal(paintedCenterY(withBg, caption), paintedCenterY(noBg, caption));
  assert.equal(
    defaultCaptionPos({
      width: 1920,
      height: 1080,
      wipeWidthPx: 480,
      wipeMarginPx: 32,
      hasCamera: false,
      fontSizePx: FONT,
    }).y,
    Math.round(paintedCenterY(withBg, caption)),
  );
});

test("defaultCaptionPos: フォントサイズが変わると下端からの持ち上がりも変わる", () => {
  const caption: Caption = { start: 0, end: 10, text: "章", track: 1, style: { fontSizePx: 96 } };
  const props: RenderProps = { ...base, captions: [caption] };
  const pos = defaultCaptionPos({
    width: 1920,
    height: 1080,
    wipeWidthPx: 480,
    wipeMarginPx: 32,
    hasCamera: false,
    fontSizePx: 96,
  });
  assert.equal(pos.y, Math.round(paintedCenterY(props, caption)));
  // config 既定サイズで代表させると枠がずれる(= テロップごとの解決が要る)
  const wrong = defaultCaptionPos({
    width: 1920,
    height: 1080,
    wipeWidthPx: 480,
    wipeMarginPx: 32,
    hasCamera: false,
    fontSizePx: FONT,
  });
  assert.notEqual(wrong.y, pos.y);
});

test("captionBoxOffset: center は不変・topLeft は padding ぶん左上へ", () => {
  // center: pos はテキスト中心。padding が対称なので枠の中心も pos のまま
  assert.deepEqual(captionBoxOffset("center", 52, 26), { dx: 0, dy: 0 });
  // topLeft: refPainter は pos をテキストボックスの左上に置き、座布団は
  // その外側(x-pad, y-pad/2)へはみ出す。枠は padding ぶん左上へ広げて一致する
  assert.deepEqual(captionBoxOffset("topLeft", 52, 26), { dx: -52, dy: -26 });
});

// ---- インライン編集(ダブルクリック)の下書きを Player へ当てる判定 ----
// 編集枠(textarea)は color:transparent で、打鍵の見た目は Player 側の字幕が
// 担う。ここが外れると「Enter で確定するまで何も変わらない」ように見える。

test("isInlineDraftTarget: トラック一致+表示区間内のときだけ当てる", () => {
  const item = { start: 10, end: 12, track: 2 };
  assert.equal(isInlineDraftTarget(item, 2, 11), true);
  // 区間は [start, end)
  assert.equal(isInlineDraftTarget(item, 2, 10), true);
  assert.equal(isInlineDraftTarget(item, 2, 12), false);
  assert.equal(isInlineDraftTarget(item, 2, 9.9), false);
  // 別トラックの同時刻には当てない(テロップは複数トラックが重なる)
  assert.equal(isInlineDraftTarget(item, 1, 11), false);
  // 非編集中(editingTrack=null)は常に対象外
  assert.equal(isInlineDraftTarget(item, null, 11), false);
});

test("isInlineDraftTarget: track 省略は 1 とみなす(texts は track:1 を持たない)", () => {
  // renderProps は textTrack(t) > 1 のときだけ track を書く
  assert.equal(isInlineDraftTarget({ start: 0, end: 5 }, 1, 1), true);
  assert.equal(isInlineDraftTarget({ start: 0, end: 5 }, 2, 1), false);
});

test("isInlineDraftTarget: 比較はカット後の秒(元収録の秒と混ぜない)", () => {
  // 元収録 120-125 秒のテキストが、カットで出力 10-15 秒へ写像された場合。
  // Player へ渡る props は出力秒なので、下書きの outT(=再生ヘッド)も出力秒。
  // 元収録の秒(120-125)で持っていた区間と突き合わせると当たらない
  const mapped = { start: 10, end: 15 };
  const source = { start: 120, end: 125 };
  assert.equal(isInlineDraftTarget(mapped, 1, 12), true);
  assert.equal(isInlineDraftTarget(source, 1, 12), false);
});
