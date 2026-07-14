import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import {
  attachPreparedDesignAssets,
  completeDesignAssets,
  panelRect,
  resolveDesign,
  screenRectToOutput,
  shrinkRectBottomRight,
  staticCameraDesignAssets,
  toPanelRect,
  wipeRectAt,
} from "../src/lib/design.ts";

const W = 1920;
const H = 1080;

test("resolveDesign: enabled が無ければ undefined(従来経路とバイト等価)", () => {
  strictEqual(resolveDesign(undefined, W, H, true), undefined);
  strictEqual(resolveDesign({}, W, H, true), undefined);
  strictEqual(resolveDesign({ enabled: false, backgroundFile: "bg.jpg" }, W, H, true), undefined);
});

test("resolveDesign: 左右100・下90 から画面パネルが決まり、上余白は成り行き22px", () => {
  const d = resolveDesign({ enabled: true }, W, H, true);
  deepStrictEqual(d?.screen.rect, { x: 100, y: 22, w: 1720, h: 968 });
  // 高さは出力アスペクト維持の成り行き(1720 * 1080/1920 = 967.5 → 968)
  strictEqual(d?.screen.rect.y, H - 90 - 968);
});

test("resolveDesign: OBS既定の解決結果はcamera optional化前とdeep equality", () => {
  deepStrictEqual(resolveDesign({ enabled: true }, W, H, true), {
    backgroundColor: "#000000",
    screen: {
      rect: { x: 100, y: 22, w: 1720, h: 968 },
      radiusPx: 24,
      shadow: true,
    },
    camera: {
      rect: { x: 1592, y: 752, w: 300, h: 300 },
      radiusPx: 96,
      shadow: true,
    },
  });
});

test("resolveDesign: カメラは右下から28px の 300x300 角丸矩形", () => {
  const d = resolveDesign(
    { enabled: true, camera: { sizePx: 300, marginPx: 28, radiusPx: 96 } },
    W,
    H,
    true,
  );
  deepStrictEqual(d?.camera?.rect, { x: 1592, y: 752, w: 300, h: 300 });
  strictEqual(d?.camera?.radiusPx, 96);
  strictEqual(d?.camera?.shadow, true);
});

test("resolveDesign: カメラの影は画面パネルの shadow とは独立に切れる", () => {
  const d = resolveDesign(
    { enabled: true, screen: { shadow: true }, camera: { shadow: false } },
    W,
    H,
    true,
  );
  strictEqual(d?.camera?.shadow, false);
  strictEqual(d?.screen.shadow, true);
});

test("resolveDesign: 角丸は一辺の半分でクランプ(それ以上は円より丸くならない)", () => {
  const d = resolveDesign(
    { enabled: true, camera: { sizePx: 300, radiusPx: 170 } },
    W,
    H,
    true,
  );
  strictEqual(d?.camera?.radiusPx, 150);
});

test("resolveDesign: plain収録(OBSではない素の動画)にはデザインをかぶせない", () => {
  // 背景・パネルは OBS 拡張キャンバス収録だけのもの。plain は素材をそのまま
  // 見せる収録(スマホのショート動画等)なので、config で design を有効にした
  // ままでも undefined = 素の映像を返す(= 収録ごとの設定なしに切り分かる)
  strictEqual(resolveDesign({ enabled: true, backgroundFile: "bg.jpg" }, W, H, false), undefined);
  strictEqual(resolveDesign({ enabled: true }, 1080, 1920, false), undefined);
});

test("resolveDesign: 寸法・screen値の負数/非finite/範囲外を拒否する", () => {
  throws(() => resolveDesign({ enabled: true }, 0, H, true));
  throws(() => resolveDesign({ enabled: true }, Number.NaN, H, true));
  throws(() => resolveDesign({ enabled: true, screen: { marginXPx: -1 } }, W, H, true));
  throws(() => resolveDesign({ enabled: true, screen: { marginBottomPx: Number.NaN } }, W, H, true));
  throws(() => resolveDesign({ enabled: true, screen: { radiusPx: Number.POSITIVE_INFINITY } }, W, H, true));
  throws(() => resolveDesign({ enabled: true, screen: { marginXPx: 1000 } }, W, H, true));
  throws(() => resolveDesign({ enabled: true, screen: { marginBottomPx: 900 } }, W, H, true));
});

test("resolveDesign: camera値の負数/非finite/出力外をOBSだけで拒否する", () => {
  throws(() => resolveDesign({ enabled: true, camera: { sizePx: 0 } }, W, H, true));
  throws(() => resolveDesign({ enabled: true, camera: { marginPx: -1 } }, W, H, true));
  throws(() => resolveDesign({ enabled: true, camera: { radiusPx: Number.NaN } }, W, H, true));
  throws(() => resolveDesign({ enabled: true, camera: { sizePx: 1100 } }, W, H, true));
});

test("resolveDesign: screen radiusを矩形の半径上限へclampする", () => {
  strictEqual(
    resolveDesign({ enabled: true, screen: { radiusPx: 1000 } }, W, H, true)?.screen.radiusPx,
    484,
  );
});

test("panelRect: design 無しならベース映像の矩形は出力全面", () => {
  deepStrictEqual(panelRect(undefined, W, H), { x: 0, y: 0, w: W, h: H });
  const d = resolveDesign({ enabled: true }, W, H, true);
  deepStrictEqual(panelRect(d, W, H), { x: 100, y: 22, w: 1720, h: 968 });
});

test("toPanelRect: パネル原点ぶん平行移動する(design 無し = 恒等)", () => {
  const panel = { x: 100, y: 22, w: 1720, h: 968 };
  deepStrictEqual(toPanelRect({ x: 150, y: 122, w: 200, h: 100 }, panel), {
    x: 50,
    y: 100,
    w: 200,
    h: 100,
  });
  const full = { x: 0, y: 0, w: W, h: H };
  const r = { x: 10, y: 20, w: 30, h: 40 };
  deepStrictEqual(toPanelRect(r, full), r);
});

test("screenRectToOutput: screenRegion 画素の box を出力px(テロップ pos と同じ系)へ写す", () => {
  const panel = { x: 100, y: 22, w: 1720, h: 968 };
  const sr = { w: 1920, h: 1080 };
  // 画面クロップの原点はパネルの原点に一致する
  deepStrictEqual(screenRectToOutput({ x: 0, y: 0, w: 0, h: 0 }, panel, sr), {
    x: 100,
    y: 22,
    w: 0,
    h: 0,
  });
  // 画面クロップの右下端はパネルの右下端に一致する
  deepStrictEqual(screenRectToOutput({ x: 1920, y: 1080, w: 0, h: 0 }, panel, sr), {
    x: 1820,
    y: 990,
    w: 0,
    h: 0,
  });
});

test("screenRectToOutput: design 無し(panel = 出力全面)では恒等", () => {
  const full = { x: 0, y: 0, w: W, h: H };
  const r = { x: 300, y: 400, w: 120, h: 60 };
  deepStrictEqual(screenRectToOutput(r, full, { w: W, h: H }), r);
});

test("toPanelRect と screenRectToOutput は互いに逆(パネル内の矩形で往復)", () => {
  const panel = { x: 100, y: 22, w: 1720, h: 968 };
  const sr = { w: 1920, h: 1080 };
  const outRect = screenRectToOutput({ x: 960, y: 540, w: 192, h: 108 }, panel, sr);
  const back = toPanelRect(outRect, panel);
  // パネルローカル = screenRegion 画素 × パネル倍率
  deepStrictEqual(back, {
    x: (960 * 1720) / 1920,
    y: (540 * 968) / 1080,
    w: (192 * 1720) / 1920,
    h: (108 * 968) / 1080,
  });
});

test("wipeRectAt: ease=0 はデザインのカメラ矩形そのまま", () => {
  const d = resolveDesign({ enabled: true }, W, H, true)!;
  deepStrictEqual(wipeRectAt(d.camera!, W, H, 0), {
    rect: d.camera!.rect,
    radiusPx: d.camera!.radiusPx,
  });
});

test("wipeRectAt: ease=1 は出力の全画面・角丸0(wipeFull の到達点)", () => {
  const d = resolveDesign({ enabled: true }, W, H, true)!;
  deepStrictEqual(wipeRectAt(d.camera!, W, H, 1), {
    rect: { x: 0, y: 0, w: W, h: H },
    radiusPx: 0,
  });
});

test("wipeRectAt: 途中は矩形も角丸も線形補間(遷移中の中割り)", () => {
  const d = resolveDesign({ enabled: true }, W, H, true)!;
  const half = wipeRectAt(d.camera!, W, H, 0.5);
  const c = d.camera!.rect;
  deepStrictEqual(half, {
    rect: {
      x: Math.round(c.x / 2),
      y: Math.round(c.y / 2),
      w: Math.round((c.w + W) / 2),
      h: Math.round((c.h + H) / 2),
    },
    radiusPx: Math.round(d.camera!.radiusPx / 2),
  });
});

test("shrinkRectBottomRight: s=1 は恒等", () => {
  const rect = { x: 1592, y: 752, w: 300, h: 300 };
  deepStrictEqual(shrinkRectBottomRight(rect, 96, 1), { rect, radiusPx: 96 });
});

test("shrinkRectBottomRight: s=0.8 で右辺・下辺が保存される(右下アンカー)", () => {
  const rect = { x: 1592, y: 752, w: 300, h: 300 };
  const shrunk = shrinkRectBottomRight(rect, 96, 0.8);
  strictEqual(shrunk.rect.x + shrunk.rect.w, rect.x + rect.w);
  strictEqual(shrunk.rect.y + shrunk.rect.h, rect.y + rect.h);
  strictEqual(shrunk.rect.w, 240);
  strictEqual(shrunk.rect.h, 240);
});

test("shrinkRectBottomRight: 丸めても右下角がずれない(奇数寸法)", () => {
  const rect = { x: 100, y: 100, w: 301, h: 301 };
  const shrunk = shrinkRectBottomRight(rect, 50, 0.8);
  strictEqual(shrunk.rect.x + shrunk.rect.w, rect.x + rect.w);
  strictEqual(shrunk.rect.y + shrunk.rect.h, rect.y + rect.h);
});

test("shrinkRectBottomRight: radius にも同じ s が掛かる", () => {
  const rect = { x: 1592, y: 752, w: 300, h: 300 };
  strictEqual(shrinkRectBottomRight(rect, 96, 0.8).radiusPx, Math.round(96 * 0.8));
  strictEqual(shrinkRectBottomRight(rect, 96, 0.5).radiusPx, 48);
});

test("attachPreparedDesignAssets: raw design と解像度が一致するときだけrefsを付ける", () => {
  const design = resolveDesign({ enabled: true }, W, H, true)!;
  const prepared = {
    width: W,
    height: H,
    design,
    refs: {
      key: "key",
      backdropFile: "render.fast/design/key.backdrop.png",
      screenMaskFile: "render.fast/design/key.screen-mask.png",
      cameraShadowFile: "render.fast/design/key.camera-shadow.png",
      cameraMaskFile: "render.fast/design/key.camera-mask.png",
    },
  };
  strictEqual(attachPreparedDesignAssets(design, W, H, prepared)?.assets, prepared.refs);
  strictEqual(attachPreparedDesignAssets(design, 1280, 720, prepared)?.assets, undefined);
  const changed = { ...design, backgroundColor: "#ffffff" };
  strictEqual(attachPreparedDesignAssets(changed, W, H, prepared)?.assets, undefined);
});

test("completeDesignAssets: 4役揃ったときだけ返し、欠けていればCSS fallback", () => {
  const design = resolveDesign({ enabled: true }, W, H, true)!;
  const complete = {
    ...design,
    assets: {
      key: "key",
      backdropFile: "backdrop.png",
      screenMaskFile: "screen-mask.png",
      cameraShadowFile: "camera-shadow.png",
      cameraMaskFile: "camera-mask.png",
    },
  };
  strictEqual(completeDesignAssets(complete), complete.assets);
  // partial cache(生成途中で落ちた等)は未準備扱い
  const partial = {
    ...complete,
    assets: { ...complete.assets, backdropFile: "" },
  };
  strictEqual(completeDesignAssets(partial), undefined);
});

test("staticCameraDesignAssets: 通常frameだけasset、wipeFull進行中はCSS fallback", () => {
  const design = resolveDesign({ enabled: true }, W, H, true)!;
  const withAssets = {
    ...design,
    assets: {
      key: "key",
      backdropFile: "backdrop.png",
      screenMaskFile: "screen-mask.png",
      cameraShadowFile: "camera-shadow.png",
      cameraMaskFile: "camera-mask.png",
    },
  };
  strictEqual(staticCameraDesignAssets(withAssets, 0), withAssets.assets);
  strictEqual(staticCameraDesignAssets(withAssets, 0.001), undefined);
  strictEqual(staticCameraDesignAssets(withAssets, 1), undefined);
  strictEqual(staticCameraDesignAssets(withAssets, 0), withAssets.assets);
});
