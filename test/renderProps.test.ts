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
import type { Config } from "../src/lib/config.ts";
import type { Manifest, Overlays, Transcript } from "../src/types.ts";

test("normalizeLayerOrder: 省略時は素材2トラックの既定順", () => {
  assert.deepEqual(normalizeLayerOrder(undefined, 1, 1), ["ov1", "wipe", "ov2", "caption"]);
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
  assert.deepEqual(props.layerOrder, ["ov1", "wipe", "ov2", "caption"]);
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
