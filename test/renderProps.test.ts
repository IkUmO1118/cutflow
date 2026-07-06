// lib/renderProps.ts — 編集ファイル群からカット後の RenderProps を組む純関数。
// render とエディタのプレビューが同じ絵になることの土台。レイヤー順の正規化と
// テロップのカット後写像を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRenderProps,
  capCountOf,
  frameSpans,
  normalizeLayerOrder,
  ovCountOf,
} from "../src/lib/renderProps.ts";
import { PROFILES } from "../src/lib/profile.ts";
import { mergeIntervals } from "../src/lib/timeline.ts";
import { defaultProps } from "../remotion/props.ts";
import type { Config } from "../src/lib/config.ts";
import type { Manifest, Overlays, Transcript } from "../src/types.ts";

test("normalizeLayerOrder: 省略時は素材トラック数なりの既定順(1本なら V2 なし)", () => {
  assert.deepEqual(normalizeLayerOrder(undefined, 1, 1), ["ov1", "wipe", "caption"]);
  assert.deepEqual(normalizeLayerOrder(undefined, 2, 1), ["ov1", "wipe", "ov2", "caption"]);
});

test("normalizeLayerOrder: 旧形式(ovUnder/chapter)を読み替え・破棄", () => {
  // ovUnder→ov1、chapter は黙って捨てる。欠けた wipe/caption/ov2 は補完される
  const order = normalizeLayerOrder(["ovUnder", "chapter", "wipe"], 1, 1);
  assert.ok(order.includes("ov1"));
  assert.ok(!order.includes("chapter" as never));
  assert.ok(order.includes("wipe"));
  assert.ok(order.includes("caption"));
});

test("capCountOf / ovCountOf: 参照される最大トラック番号(最低1)", () => {
  assert.equal(capCountOf({ segments: [{ start: 0, end: 1, text: "a", track: 3 }] } as Transcript), 3);
  assert.equal(capCountOf({ segments: [{ start: 0, end: 1, text: "a" }] } as Transcript), 1);
  assert.equal(ovCountOf({ overlays: [{ start: 0, end: 1, file: "x.png", track: 2 }] } as Overlays), 2);
  assert.equal(ovCountOf({} as Overlays), 1);
});

const manifest: Manifest = {
  dir: "/tmp",
  source: "raw.mkv",
  durationSec: 40,
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  },
  audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
  createdAt: "2026-07-04T00:00:00Z",
};

const renderCfg: Config["render"] = {
  wipeWidthPx: 480,
  wipeMarginPx: 32,
  captionFontSizePx: 52,
  chapterCardSec: 3,
  targetLufs: -14,
  bgm: { volumeDb: -22, fadeOutSec: 2 },
};

test("buildRenderProps: カット内のテロップは落ち、尺は keep の合計", () => {
  const keeps = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ];
  const transcript: Transcript = {
    segments: [
      { start: 2, end: 5, text: "残る" },
      { start: 12, end: 14, text: "カット内で消える" },
    ],
  };
  const props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });

  assert.equal(props.durationSec, 20); // 10 + 10
  assert.equal(props.captions.length, 1);
  assert.equal(props.captions[0].text, "残る");
  assert.deepEqual(
    { start: props.captions[0].start, end: props.captions[0].end },
    { start: 2, end: 5 },
  );
  assert.deepEqual(props.layerOrder, ["ov1", "wipe", "caption"]);
});

test("buildRenderProps: profile 省略時は profile 指定なしの現行 props と deep-equal", () => {
  const args = {
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [{ start: 2, end: 5, text: "残る" }] } as Transcript,
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  const withoutArg = buildRenderProps(args);
  const withUndefined = buildRenderProps({ ...args, profile: undefined });
  assert.deepEqual(withoutArg, withUndefined);
  assert.equal(withoutArg.layout, undefined);
  assert.equal(withoutArg.captionDefaultPos, undefined);
  assert.equal(withoutArg.caption.fontSizePx, renderCfg.captionFontSizePx);
});

// plain(cameraRegion 無し)の manifest では props.cameraRegion が undefined。
// defaultProps にダミー cameraRegion があると、plain の inputProps で
// cameraRegion が JSON 欠落 → Remotion の props マージでダミーが漏れ、plain に
// ワイプが描かれる/ショートのカメラパネルが誤領域を切り出して黒くなる。
// そのため defaultProps は cameraRegion を持たないことを固定する
test("defaultProps は cameraRegion を持たない(plain へのダミー漏れ防止)", () => {
  assert.equal(defaultProps.cameraRegion, undefined);
});

test("buildRenderProps: plain manifest(cameraRegion 無し)は cameraRegion undefined", () => {
  const plainManifest: Manifest = {
    ...manifest,
    layout: "plain",
    video: { width: 1080, height: 1920, fps: 30, screenRegion: { x: 0, y: 0, w: 1080, h: 1920 } },
  };
  const props = buildRenderProps({
    manifest: plainManifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [{ start: 2, end: 5, text: "残る" }] } as Transcript,
    overlays: {},
    renderCfg,
    width: 1080,
    height: 1920,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.cameraRegion, undefined);
  assert.deepEqual(props.screenRegion, { x: 0, y: 0, w: 1080, h: 1920 });
});

test("buildRenderProps: vertical profile → layout/captionDefaultPos/fontSizePx(×fontScale)が入る", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [{ start: 2, end: 5, text: "残る" }] } as Transcript,
    overlays: {},
    renderCfg,
    width: PROFILES.vertical.width,
    height: PROFILES.vertical.height,
    profile: PROFILES.vertical,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });

  assert.deepEqual(props.layout, { panels: PROFILES.vertical.layout?.panels });
  assert.deepEqual(props.captionDefaultPos, { x: 540, y: 1560, anchor: "center" });
  assert.equal(props.caption.fontSizePx, Math.round(renderCfg.captionFontSizePx * 1.6));
});

test("buildRenderProps: テロップ既定スタイルは config 指定時のみ caption に載る", () => {
  const base = {
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    overlays: {},
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  // 未指定なら fontSizePx のみ(render.props.json に余計なキーを書かない)
  assert.deepEqual(buildRenderProps({ ...base, renderCfg }).caption, { fontSizePx: 52 });
  // config の render.caption* が props.caption に解決される
  const styled = buildRenderProps({
    ...base,
    renderCfg: {
      ...renderCfg,
      captionColor: "#ffee00",
      captionOutlineColor: "none",
      captionFontFamily: "serif",
      captionFontWeight: 900,
    },
  });
  assert.deepEqual(styled.caption, {
    fontSizePx: 52,
    color: "#ffee00",
    outlineColor: "none",
    fontFamily: "serif",
    fontWeight: 900,
  });
});

test("buildRenderProps: insert の頭出し(startFrom)が props に伝わる／0は省略", () => {
  const keeps = [{ start: 0, end: 30 }];
  const props = buildRenderProps({
    manifest,
    keeps,
    transcript: { segments: [] },
    overlays: {
      inserts: [
        { at: 10, file: "materials/broll.mp4", durationSec: 4, startFrom: 5 },
        { at: 20, file: "materials/other.mp4", durationSec: 2 },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });

  const withIn = props.inserts?.find((i) => i.file === "materials/broll.mp4");
  const noIn = props.inserts?.find((i) => i.file === "materials/other.mp4");
  assert.equal(withIn?.startFrom, 5);
  assert.equal(noIn?.startFrom, undefined); // startFrom 無指定は省略される
  assert.equal(props.durationSec, 36); // keep 30 + 挿入 4 + 2
});

test("buildRenderProps: overlay の頭出し・音量・不透明度・rect が props に伝わる", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      overlays: [
        {
          start: 5, end: 10, file: "materials/pip.mp4",
          startFrom: 3, volume: 0.5, opacity: 0.8,
          fadeInSec: 0.5, fadeOutSec: 1,
          rect: { x: 1200, y: 60, w: 640, h: 360 },
        },
        { start: 12, end: 14, file: "materials/plain.png" },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  const rich = props.overlays.find((o) => o.file === "materials/pip.mp4");
  assert.equal(rich?.startFrom, 3);
  assert.equal(rich?.volume, 0.5);
  assert.equal(rich?.opacity, 0.8);
  assert.equal(rich?.fadeInSec, 0.5);
  assert.equal(rich?.fadeOutSec, 1);
  assert.deepEqual(rich?.rect, { x: 1200, y: 60, w: 640, h: 360 });
  // 既定値(音量0・不透明度1・フェードなし・全画面)はキーごと省略される
  const plain = props.overlays.find((o) => o.file === "materials/plain.png");
  assert.deepEqual(plain, {
    start: 12, end: 14, file: "materials/plain.png", track: 1, fit: "contain",
  });
});

test("buildRenderProps: 挿入で割れた overlay は頭出し+表示済み秒で続きから、フェードは端の断片だけ", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      // 挿入が 10s に割り込み、5〜15s の overlay は2断片に割れる
      inserts: [{ at: 10, file: "materials/ins.mp4", durationSec: 4 }],
      overlays: [
        {
          start: 5, end: 15, file: "materials/pip.mp4",
          startFrom: 2, fadeInSec: 0.5, fadeOutSec: 0.5,
        },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  const parts = props.overlays.filter((o) => o.file === "materials/pip.mp4");
  assert.equal(parts.length, 2);
  // 1断片目: 頭出し2秒から。フェードインだけ持つ
  assert.equal(parts[0].startFrom, 2);
  assert.equal(parts[0].fadeInSec, 0.5);
  assert.equal(parts[0].fadeOutSec, undefined);
  // 2断片目: 頭出し2秒+表示済み5秒=7秒から。フェードアウトだけ持つ
  assert.equal(parts[1].startFrom, 7);
  assert.equal(parts[1].fadeInSec, undefined);
  assert.equal(parts[1].fadeOutSec, 0.5);
});

test("buildRenderProps: insert の音量・フェードが props に伝わる／既定値は省略", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      inserts: [
        { at: 10, file: "materials/a.mp4", durationSec: 4, volume: 0, fadeInSec: 0.3 },
        { at: 20, file: "materials/b.mp4", durationSec: 2, volume: 1 },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  const muted = props.inserts?.find((i) => i.file === "materials/a.mp4");
  assert.equal(muted?.volume, 0); // 0 は「無音にする」指定なので残る
  assert.equal(muted?.fadeInSec, 0.3);
  const normal = props.inserts?.find((i) => i.file === "materials/b.mp4");
  assert.equal(normal?.volume, undefined); // 1(既定)は省略される
});

test("buildRenderProps: wipe に遷移時間が載る(config 未指定は 0.3)", () => {
  const base = {
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    overlays: {},
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  assert.equal(buildRenderProps({ ...base, renderCfg }).wipe.transitionSec, 0.3);
  assert.equal(
    buildRenderProps({ ...base, renderCfg: { ...renderCfg, wipeTransitionSec: 0 } })
      .wipe.transitionSec,
    0,
  );
});

test("buildRenderProps: cutTransition 未設定/type: none では cutTransition・cutBoundarySecs が props に載らない", () => {
  const keeps = [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }];
  const base = {
    manifest,
    keeps,
    transcript: { segments: [] } as Transcript,
    overlays: {},
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  const noCfg = buildRenderProps({ ...base, renderCfg });
  assert.equal(noCfg.cutTransition, undefined);
  assert.equal(noCfg.cutBoundarySecs, undefined);
  const noneCfg = buildRenderProps({
    ...base,
    renderCfg: { ...renderCfg, cutTransition: { type: "none", sec: 0.5 } },
  });
  assert.equal(noneCfg.cutTransition, undefined);
  assert.equal(noneCfg.cutBoundarySecs, undefined);
});

test("buildRenderProps: dip-to-black で keep 境界の累積秒が cutBoundarySecs に載る(先頭・末尾は含めない)", () => {
  const props = buildRenderProps({
    manifest,
    // 出力: [0,10] keep1 / 境界(10) / [10,20] keep2 / 境界(20) / [20,25] keep3
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 45 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: { ...renderCfg, cutTransition: { type: "dip-to-black", sec: 0.4 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.cutTransition, { sec: 0.4 });
  assert.deepEqual(props.cutBoundarySecs, [10, 20]);
});

test("buildRenderProps: sec 省略時は DEFAULT_CUT_TRANSITION_SEC(0.3)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: { ...renderCfg, cutTransition: { type: "dip-to-black" } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.cutTransition, { sec: 0.3 });
});

test("buildRenderProps: 境界より手前に挿入があると、その尺ぶん cutBoundarySecs も後ろへずれる", () => {
  const props = buildRenderProps({
    manifest,
    // 元 [0,10] と [20,30]。境界の手前(元5s)に4秒の挿入があるので、
    // 単純な keep 累積時間(10)ではなく、挿入の尺を足した 14 が正しい境界
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      inserts: [{ at: 5, file: "materials/ins.mp4", durationSec: 4 }],
    },
    renderCfg: { ...renderCfg, cutTransition: { type: "dip-to-black", sec: 0.3 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.cutBoundarySecs, [14]);
});

test("buildRenderProps: 隣接 keep が実質連続している境界(未 mergeIntervals)は cutBoundarySecs から除外される", () => {
  const props = buildRenderProps({
    manifest,
    // エディタの分割編集直後を想定: [0,10] と [10,20] は実際には切れていない
    keeps: [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 30, end: 40 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: { ...renderCfg, cutTransition: { type: "dip-to-black", sec: 0.3 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  // [0,10]+[10,20] の継ぎ目(10)は実質連続なので除外。[10,20]→[30,40] の
  // 境界(累積20の位置)だけが残る
  assert.deepEqual(props.cutBoundarySecs, [20]);
});

test("buildRenderProps: wipeFull はカット・挿入・隣接エントリで繋がった区間が1本にまとまる", () => {
  const props = buildRenderProps({
    manifest,
    // [30,40] をカット。挿入は 20s に 4 秒割り込む
    keeps: [{ start: 0, end: 30 }, { start: 40, end: 60 }],
    transcript: { segments: [] },
    overlays: {
      inserts: [{ at: 20, file: "materials/ins.mp4", durationSec: 4 }],
      // 1本目は挿入で割れ、2本目はカットを挟んで出力上で1本目と隣接する
      wipeFull: [{ start: 10, end: 30 }, { start: 40, end: 50 }],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  // 出力: [10,20] + 挿入(20-24) + [24,34] + [34,44] → 遷移が継ぎ目で走らないよう
  // 挿入をまたいで繋ぎ、隣接区間もまとめて 1 スパンになる
  assert.deepEqual(props.wipeFull, [{ start: 10, end: 44 }]);
});

test("buildRenderProps: zooms 未指定なら props に zooms キーが現れない(既存 props と完全一致)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("zooms" in props, false);
});

test("buildRenderProps: zooms はカット後タイムラインへ写像され、easeSec は config 既定へフォールバックする", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 22, end: 28, rect }] },
    renderCfg: { ...renderCfg, zoom: { easeSec: 0.6 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.zooms, [{ start: 12, end: 18, rect, easeSec: 0.6 }]);
});

test("buildRenderProps: zooms の easeSec 個別指定は config より優先", () => {
  const rect = { x: 0, y: 0, w: 960, h: 1080 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect, easeSec: 0.1 }] },
    renderCfg: { ...renderCfg, zoom: { easeSec: 0.6 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.zooms, [{ start: 1, end: 5, rect, easeSec: 0.1 }]);
});

test("buildRenderProps: zooms がカット内で全部消えると出力に含まれない", () => {
  const rect = { x: 0, y: 0, w: 960, h: 1080 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 12, end: 18, rect }] }, // カット内([10,20))
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("zooms" in props, false);
});

test("buildRenderProps: blurs 未指定なら props に blurs キーが現れない(既存 props と完全一致)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("blurs" in props, false);
});

test("buildRenderProps: blurs はカット後タイムラインへ写像され、type/strength は既定へフォールバックする", () => {
  const rect = { x: 700, y: 400, w: 520, h: 140 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: { blurs: [{ start: 22, end: 28, rect }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.blurs, [{ start: 12, end: 18, rect, type: "blur", strength: 0.5 }]);
});

test("buildRenderProps: blurs の type/strength 個別指定は既定より優先", () => {
  const rect = { x: 0, y: 0, w: 500, h: 200 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { blurs: [{ start: 1, end: 5, rect, type: "mosaic", strength: 0.8 }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.blurs, [{ start: 1, end: 5, rect, type: "mosaic", strength: 0.8 }]);
});

test("buildRenderProps: blurs 1件が挿入で2断片に割れると props.blurs も2エントリ(同一 rect/type/strength)", () => {
  const rect = { x: 0, y: 0, w: 500, h: 200 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      blurs: [{ start: 5, end: 25, rect }],
      inserts: [{ at: 15, file: "materials/ins.mp4", durationSec: 4 }],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.blurs?.length, 2);
  assert.deepEqual(props.blurs?.[0], { start: 5, end: 15, rect, type: "blur", strength: 0.5 });
  assert.deepEqual(props.blurs?.[1], { start: 19, end: 29, rect, type: "blur", strength: 0.5 });
});

test("buildRenderProps: blurs がカット内で全部消えると出力に含まれない", () => {
  const rect = { x: 0, y: 0, w: 500, h: 200 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: { blurs: [{ start: 12, end: 18, rect }] }, // カット内([10,20))
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("blurs" in props, false);
});

test("buildRenderProps: overlay のフェードは断片より長いとき断片内で完了する長さへ縮む", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      // 挿入が 5.5s に割り込み、先頭断片は 0.5 秒しかない
      inserts: [{ at: 5.5, file: "materials/ins.mp4", durationSec: 4 }],
      overlays: [
        { start: 5, end: 15, file: "materials/pip.mp4", fadeInSec: 2, fadeOutSec: 1 },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  const parts = props.overlays.filter((o) => o.file === "materials/pip.mp4");
  assert.equal(parts.length, 2);
  // フェードインは断片長 0.5 秒に縮む(縮めないと挿入明けに不透明度が
  // 0.25→1.0 へジャンプする)。フェードアウトは断片に収まるのでそのまま
  assert.equal(parts[0].fadeInSec, 0.5);
  assert.equal(parts[1].fadeOutSec, 1);
});

test("buildRenderProps: bgm.json の tracks はカット後区間に写像され volumeDb は既定に落ちる", () => {
  const props = buildRenderProps({
    manifest,
    // 元 [0,10] と [20,30] が残る(10-20 はカット)。カットの前後は出力で
    // 隣接するので、それをまたぐ BGM は1本に繋がる(途切れない)
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    // 元 5〜25 に BGM → 出力では [5,10]+[10,15] が繋がって [5,15]
    bgm: { tracks: [{ start: 5, end: 25, file: "bgm.mp3", fadeInSec: 1, fadeOutSec: 2 }] },
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.bgm.length, 1);
  assert.deepEqual(
    { start: props.bgm[0].start, end: props.bgm[0].end, file: props.bgm[0].file },
    { start: 5, end: 15, file: "bgm.mp3" },
  );
  // volumeDb 省略時は config の既定(-22)、フェードは区間の頭/末尾に載る
  assert.equal(props.bgm[0].volumeDb, -22);
  assert.equal(props.bgm[0].fadeInSec, 1);
  assert.equal(props.bgm[0].fadeOutSec, 2);
});

test("buildRenderProps: 挿入で割れた BGM はフェードを端の断片だけに載せる", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    // 挿入が出力 8s に4秒割り込み、BGM を [5,8] と [12,20] に割る
    overlays: { inserts: [{ at: 8, file: "materials/ins.mp4", durationSec: 4 }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: { tracks: [{ start: 5, end: 16, file: "bgm.mp3", fadeInSec: 1, fadeOutSec: 2 }] },
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.bgm.length, 2);
  assert.equal(props.bgm[0].fadeInSec, 1);
  assert.equal(props.bgm[0].fadeOutSec, undefined);
  assert.equal(props.bgm[1].fadeInSec, undefined);
  assert.equal(props.bgm[1].fadeOutSec, 2);
});

test("buildRenderProps: 存在しない BGM 素材は warn して区間ごと落ちる", () => {
  const warnings: string[] = [];
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: { tracks: [{ start: 0, end: 10, file: "missing.mp3", volumeDb: -10 }] },
    bgmFallbackFile: null,
    overlayExists: (f) => f !== "missing.mp3",
    warn: (m) => warnings.push(m),
  });
  assert.equal(props.bgm.length, 0);
  assert.ok(warnings.some((w) => w.includes("missing.mp3")));
});

test("buildRenderProps: bgm.json が無ければ bgmFallbackFile を全編1曲で流す(終端フェード)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: "bgm.mp3",
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.bgm.length, 1);
  // 出力尺 20 秒の全編。終端フェードは config の fadeOutSec(2)で再現
  assert.deepEqual(
    { start: props.bgm[0].start, end: props.bgm[0].end, fadeOutSec: props.bgm[0].fadeOutSec },
    { start: 0, end: 20, fadeOutSec: 2 },
  );
  assert.equal(props.bgm[0].volumeDb, -22);
});

test("buildRenderProps: 発話ダッキングは各 BGM 区間に載る(無音の補集合を写像)", () => {
  const duckCfg: Config["render"] = {
    ...renderCfg,
    bgm: { volumeDb: -22, fadeOutSec: 2, ducking: { duckDb: -8, fadeSec: 0.4 } },
  };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: duckCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: { tracks: [{ start: 0, end: 30, file: "bgm.mp3" }] },
    bgmFallbackFile: null,
    // 無音 [10,20] → 発話は [0,10] と [20,30]
    silences: [{ start: 10, end: 20 }],
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.bgm.length, 1);
  assert.ok(props.bgm[0].duck);
  assert.equal(props.bgm[0].duck?.duckDb, -8);
  assert.deepEqual(props.bgm[0].duck?.spans, [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ]);
});

// ---- F4: 出力解像度は manifest.video.screenRegion(profile 経由)から。
// plain(cameraRegion 無し)でも buildRenderProps が undefined をそのまま通す ----

test("buildRenderProps: obs-canvas manifest は width/height/screenRegion/cameraRegion が従来どおり", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    overlays: {},
    renderCfg,
    width: manifest.video.screenRegion.w,
    height: manifest.video.screenRegion.h,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.width, 1920);
  assert.equal(props.height, 1080);
  assert.deepEqual(props.screenRegion, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(props.cameraRegion, { x: 1920, y: 0, w: 1920, h: 1080 });
});

test("buildRenderProps: plain manifest(cameraRegion 無し)は width/height が screenRegion 由来・cameraRegion は undefined", () => {
  const plainManifest: Manifest = {
    ...manifest,
    layout: "plain",
    video: {
      width: 1080,
      height: 1920,
      fps: 30,
      screenRegion: { x: 0, y: 0, w: 1080, h: 1920 },
    },
  };
  const props = buildRenderProps({
    manifest: plainManifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    overlays: {},
    renderCfg,
    width: plainManifest.video.screenRegion.w,
    height: plainManifest.video.screenRegion.h,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.width, 1080);
  assert.equal(props.height, 1920);
  assert.equal(props.cameraRegion, undefined);
});

test("buildRenderProps: colorFilter は overlays にあるときだけ props に載る", () => {
  const base = {
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  assert.equal(buildRenderProps({ ...base, overlays: {} }).colorFilter, undefined);
  const cf = { brightness: 1.2, contrast: 1.1 };
  assert.deepEqual(buildRenderProps({ ...base, overlays: { colorFilter: cf } }).colorFilter, cf);
});

test("frameSpans: 隣接するベース区間は境界フレームを共有する(隙間・重なりなし)", () => {
  // round2 の量子化で「前の終端 1.61 / 次の開始 1.62」のようにずれた境界は、
  // 独立に丸めると end=48 / from=49 になり 1 フレームの黒穴が空く
  const { base } = frameSpans({
    baseSegments: [
      { start: 0, durationSec: 1.61 },
      { start: 1.62, durationSec: 1 },
    ],
    inserts: [],
    fps: 30,
    durationInFrames: 79,
  });
  assert.equal(base[0].from + base[0].durationInFrames, base[1].from);
  // 逆向き(重なり側)も同様に潰れる: 56.95+4.62=61.57 は独立丸めだと
  // end=1848 / 次の from=1847 で 1 フレーム音が二重になる
  const { base: b2 } = frameSpans({
    baseSegments: [
      { start: 56.95, durationSec: 4.62 },
      { start: 61.57, durationSec: 1 },
    ],
    inserts: [],
    fps: 30,
    durationInFrames: 1878,
  });
  assert.equal(b2[0].from, 1709);
  assert.equal(b2[0].from + b2[0].durationInFrames, 1847);
  assert.equal(b2[1].from, 1847);
});

test("frameSpans: 挿入とベースの境界も共有し、終端は合成の末尾へ吸着する", () => {
  const { base, inserts } = frameSpans({
    baseSegments: [{ start: 29.99, durationSec: 98.4 }],
    inserts: [{ start: 0, end: 29.99 }],
    fps: 30,
    // 合成の長さが丸めと1フレームずれても末尾に黒を残さない
    durationInFrames: 3853,
  });
  assert.equal(inserts[0].from, 0);
  assert.equal(inserts[0].from + inserts[0].durationInFrames, base[0].from);
  assert.equal(base[0].from + base[0].durationInFrames, 3853);
});

test("frameSpans: 離れた区間(0.02秒超)は連結せず独立に丸める", () => {
  const { base, inserts } = frameSpans({
    baseSegments: [{ start: 0, durationSec: 1 }],
    inserts: [{ start: 1.5, end: 2.5 }],
    fps: 30,
    durationInFrames: 200,
  });
  assert.equal(base[0].durationInFrames, 30);
  assert.equal(inserts[0].from, 45);
  assert.equal(inserts[0].durationInFrames, 30);
});

// ---- ショート(shorts.json)相乗り経路: ranges→mergeIntervals の keep 集合 +
// overlays.captionTracks 経由の縦用テロップ上書き(render.ts のショート経路と同じ組み立て) ----

test("buildRenderProps: ショートの ranges(飛び区間)を mergeIntervals した keep 集合がそのまま使われ、レンジ外のテロップは落ちる", () => {
  // shorts.json の ranges 相当: 本編 cutplan とは無関係な2つの飛び区間
  const shortRanges = [{ start: 100, end: 110 }, { start: 200, end: 205 }];
  const shortKeeps = mergeIntervals(shortRanges);
  const transcript: Transcript = {
    segments: [
      { start: 102, end: 104, text: "レンジ内" },
      { start: 150, end: 152, text: "レンジ外(両レンジの間)" },
    ],
  };
  const props = buildRenderProps({
    manifest,
    keeps: shortKeeps,
    transcript,
    overlays: {},
    renderCfg,
    width: PROFILES.vertical.width,
    height: PROFILES.vertical.height,
    profile: PROFILES.vertical,
    videoFile: "cut.hook.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.durationSec, 15); // 10 + 5
  assert.equal(props.captions.length, 1);
  assert.equal(props.captions[0].text, "レンジ内");
});

test("buildRenderProps: ショートの captionTracks は overlays.captionTracks と同じ経路(セグメント → トラック標準)で解決される", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 100, end: 110 }],
    transcript: {
      segments: [
        { start: 101, end: 103, text: "標準位置" },
        { start: 104, end: 106, text: "個別上書き", pos: { x: 10, y: 20 } },
      ],
    },
    // shorts.json の captionTracks をそのまま overlays.captionTracks として渡す
    // (render.ts のショート経路: shortOverlays = { captionTracks: short.captionTracks })
    overlays: { captionTracks: [{ track: 1, x: 540, y: 1600, style: { fontSizePx: 92 } }] },
    renderCfg,
    width: PROFILES.vertical.width,
    height: PROFILES.vertical.height,
    profile: PROFILES.vertical,
    videoFile: "cut.hook.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  const std = props.captions.find((c) => c.text === "標準位置");
  const overridden = props.captions.find((c) => c.text === "個別上書き");
  assert.deepEqual(std?.pos, { x: 540, y: 1600 });
  assert.equal(std?.style?.fontSizePx, 92);
  assert.deepEqual(overridden?.pos, { x: 10, y: 20 }); // セグメント個別指定が優先
});
