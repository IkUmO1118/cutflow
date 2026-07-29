// src/engine/describeFrame.ts グループ6(ショート: 縦プリセットのパネル合成)
// の翻訳を固定する。renderPanels(Main.tsx)の逐語移植をクロスチェックする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFrame, describeShortPanelsLayer } from "../src/engine/describeFrame.ts";
import { PROFILES } from "../src/lib/profile.ts";
import { defaultProps } from "../src/lib/renderPropsTypes.ts";
import type { RenderProps } from "../src/lib/renderPropsTypes.ts";

const base: RenderProps = {
  ...defaultProps,
  videoFile: "cut.mp4",
  canvas: { w: 3840, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  cameraRegion: { x: 1920, y: 0, w: 1080, h: 1080 },
  durationSec: 30,
};

const verticalProfile = PROFILES.vertical;

test("describeShortPanelsLayer: props.layout 無しは空(本編経路)", () => {
  assert.deepEqual(describeShortPanelsLayer(base, 5), []);
});

test("describeShortPanelsLayer: パネルを配列順(下→上)で quad 解決する", () => {
  const props: RenderProps = {
    ...base,
    width: verticalProfile.width,
    height: verticalProfile.height,
    layout: verticalProfile.layout,
  };
  const items = describeShortPanelsLayer(props, 5);
  assert.equal(items.length, 2); // camera(上) + screen(下)の2パネル
  const [cameraPanel, screenPanel] = items;
  if (cameraPanel.kind !== "external" || cameraPanel.placement.mode !== "resolved") {
    throw new Error("unreachable");
  }
  if (screenPanel.kind !== "external" || screenPanel.placement.mode !== "resolved") {
    throw new Error("unreachable");
  }
  // vertical profile: camera rect {0,0,1080,607} / screen rect {0,607,1080,607}
  assert.deepEqual(cameraPanel.placement.quad, { x: 0, y: 0, w: 1080, h: 607 });
  assert.deepEqual(screenPanel.placement.quad, { x: 0, y: 607, w: 1080, h: 607 });
});

test("describeShortPanelsLayer: sourceTimeSec はベース区間(main と同じ baseSourceTimeAt)で決まる", () => {
  const props: RenderProps = {
    ...base,
    width: verticalProfile.width,
    height: verticalProfile.height,
    layout: verticalProfile.layout,
    baseSegments: [{ start: 0, videoStart: 100, durationSec: 30 }],
  };
  const items = describeShortPanelsLayer(props, 5);
  if (items[0].kind !== "external") throw new Error("unreachable");
  assert.equal(items[0].sourceTimeSec, 105);
});

test("describeShortPanelsLayer: colorFilter は例外的にショートにも継承される", () => {
  const props: RenderProps = {
    ...base,
    width: verticalProfile.width,
    height: verticalProfile.height,
    layout: verticalProfile.layout,
    colorFilter: { brightness: 1.3 },
  };
  const items = describeShortPanelsLayer(props, 5);
  if (items[0].kind !== "external") throw new Error("unreachable");
  assert.deepEqual(items[0].effects, [{ kind: "colorFilter", brightness: 1.3, contrast: 1, saturate: 1 }]);
});

test("describeShortPanelsLayer: 挿入クリップの穴では全パネルとも出さない", () => {
  const props: RenderProps = {
    ...base,
    width: verticalProfile.width,
    height: verticalProfile.height,
    layout: verticalProfile.layout,
    baseSegments: [{ start: 0, videoStart: 0, durationSec: 5 }],
  };
  assert.deepEqual(describeShortPanelsLayer(props, 6), []);
});

test("describeFrame: ショート経路は base(横)ではなくパネルを含み、blur/annotationは含まない", () => {
  const props: RenderProps = {
    ...base,
    width: verticalProfile.width,
    height: verticalProfile.height,
    layout: verticalProfile.layout,
    captionDefaultPos: verticalProfile.layout?.caption
      ? { x: verticalProfile.layout.caption.x, y: verticalProfile.layout.caption.y }
      : undefined,
    captions: [{ start: 0, end: 10, text: "ショートのテロップ", track: 1 }],
    blurs: [{ start: 0, end: 10, rect: { x: 0, y: 0, w: 50, h: 50 }, strength: 0.5 }],
    annotations: [
      { type: "box", start: 0, end: 10, rect: { x: 0, y: 0, w: 10, h: 10 }, color: "#fff", widthPx: 1, radiusPx: 0 },
    ],
  };
  const d = describeFrame(props, 5);
  const kinds = d.items.map((it) => (it.kind === "rendered" ? it.content.kind : "external"));
  // 2パネル(external) + caption。blur/annotation は本編専用なので含まれない
  assert.deepEqual(kinds, ["external", "external", "caption"]);
});
