// lib/insertMix.ts の純関数テスト(node --test)。design-T4.md §5「test/insertMix.test.ts」。
// 挿入クリップ込みの連続音声ベッド(buildInsertBedPcm)と AAC エンコード argv
// (buildPcmEncodeArgs)を固定する。ffmpeg は一切実行しない(mixInsertAudio は
// 不純関数なので対象外。fastRender.test.ts が runFastRender を対象外にする
// のと同じ方針)。小さな fps・sampleRate で固定する(実 sr=48000 は
// bgmMixSampleCount/frameSampleRange 側で既に固定されているので、ここでは
// 手計算できる小さな値に override する)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInsertBedPcm, buildPcmEncodeArgs, insertHasNoAudio } from "../src/lib/insertMix.ts";
import { baseLayoutOf } from "../src/lib/fastBase.ts";
import { bgmMixSampleCount } from "../src/lib/bgmMix.ts";
import { fadeFactor } from "../src/lib/overlayFade.ts";
import type { BaseLayout } from "../src/lib/fastBase.ts";
import type { RenderProps } from "../remotion/props.ts";

function mkProps(partial: Partial<RenderProps> & { durationSec: number; fps: number }): RenderProps {
  return {
    videoFile: "cut.mp4",
    bgm: [],
    width: 1920,
    height: 1080,
    canvas: { w: 1920, h: 1080 },
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    wipe: { widthPx: 480, marginPx: 32 },
    caption: { fontSizePx: 44 },
    captions: [],
    overlays: [],
    wipeFull: [],
    hideCaption: [],
    ...partial,
  };
}

function okLayout(props: RenderProps): Extract<BaseLayout, { ok: true }> {
  const layout = baseLayoutOf(props);
  assert.equal(layout.ok, true, `expected ok:true, got ${JSON.stringify(layout)}`);
  return layout as Extract<BaseLayout, { ok: true }>;
}

// ---- I-1: 挿入1件(音声あり・fade無し・volume既定1) ----

// 共通セットアップ: fps=2, sampleRate=4(1frame=2sample), durationSec=2
// (insert[0,1) + base[1,2))。cut.mp4 側は base 用に 4 サンプル(100番台/200番台)、
// 挿入素材は 10番台/20番台で値を分けて追跡できるようにする。
function mkI1Props(insertExtra: Partial<NonNullable<RenderProps["inserts"]>[number]> = {}): RenderProps {
  return mkProps({
    durationSec: 2,
    fps: 2,
    baseSegments: [{ start: 1, videoStart: 0, durationSec: 1 }],
    inserts: [{ start: 0, end: 1, file: "i.mp4", fit: "cover", ...insertExtra }],
  });
}

const CUT_PCM_I1 = new Float32Array([100, 200, 101, 201, 102, 202, 103, 203]);
const INSERT_PCM_I1 = new Float32Array([10, 20, 11, 21, 12, 22, 13, 23]);

test("I-1: ベース区間は cut PCM の正しいオフセットから来ている・挿入区間は挿入PCMそのもの", () => {
  const props = mkI1Props();
  const layout = okLayout(props);
  const bed = buildInsertBedPcm({
    props,
    layout,
    cutPcm: CUT_PCM_I1,
    insertPcms: [INSERT_PCM_I1],
    sampleRate: 4,
    channels: 2,
  });
  assert.deepEqual(
    Array.from(bed),
    [10, 20, 11, 21, 12, 22, 13, 23, 100, 200, 101, 201, 102, 202, 103, 203],
  );
});

// ---- I-2: fadeInSec/fadeOutSec のゲイン曲線 ----

test("I-2: 各 frame のゲインが vol * fadeFactor(f, durFrames, ...) と一致する(fadeFactor を直接呼んで期待値を作る)", () => {
  const props = mkProps({
    durationSec: 2,
    fps: 10, // sampleRate=10(1frame=1sample)にして手計算を単純化
    baseSegments: [{ start: 1, videoStart: 0, durationSec: 1 }],
    inserts: [{ start: 0, end: 1, file: "i.mp4", fit: "cover", fadeInSec: 0.3, fadeOutSec: 0.3 }],
  });
  const layout = okLayout(props);
  const insertPcm = new Float32Array(20).fill(1); // 10サンプル×2ch、すべて1
  const cutPcm = new Float32Array(20).fill(0);
  const bed = buildInsertBedPcm({
    props,
    layout,
    cutPcm,
    insertPcms: [insertPcm],
    sampleRate: 10,
    channels: 2,
  });
  const durFrames = 10; // max(1, round((1-0)*10))
  for (let f = 0; f < 10; f++) {
    const expected = fadeFactor(f, durFrames, 10, 0.3, 0.3);
    // bed は Float32Array(insertPcm も Float32)なので f64 の期待値とは
    // float32 精度ぶんの誤差が乗る(値そのものは 0〜1 の小さい数なので 1e-6 で十分)
    assert.ok(Math.abs(bed[f * 2] - expected) < 1e-6, `f=${f}: L ch expected=${expected} actual=${bed[f * 2]}`);
    assert.ok(Math.abs(bed[f * 2 + 1] - expected) < 1e-6, `f=${f}: R ch expected=${expected} actual=${bed[f * 2 + 1]}`);
  }
});

// ---- I-3: volume:0 / 画像 / 音声ストリーム無し → 挿入区間は完全な無音 ----
// (この3つは mixInsertAudio がデコード前/後に null へ正規化する。
// buildInsertBedPcm はその null を受け取る側なので、ここでは
// insertPcms[i]=null を渡した結果だけを検証する)

for (const label of ["volume:0", "画像素材", "音声ストリーム無し(pcm.length===0→null)"]) {
  test(`I-3: ${label} → 挿入区間が完全な無音(insertPcms[i]=null)`, () => {
    const props = mkI1Props();
    const layout = okLayout(props);
    const bed = buildInsertBedPcm({
      props,
      layout,
      cutPcm: CUT_PCM_I1,
      insertPcms: [null],
      sampleRate: 4,
      channels: 2,
    });
    // 挿入区間(先頭8要素=4サンプル)は無音のまま。ベース区間は影響を受けない
    assert.deepEqual(Array.from(bed.slice(0, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(bed.slice(8, 16)), [100, 200, 101, 201, 102, 202, 103, 203]);
  });
}

// ---- insertHasNoAudio: デコード省略の判定(純関数。ffprobe は叩かない) ----
// 音声ストリーム無しの素材(例: materials/insert-silent.mp4)を扱えることを
// ここで固定する。mixInsertAudio は decodeAudioToPcm を呼ぶ**前**に
// ffprobe(probe()+summarizeProbe())で hasAudioStream を判定し、この関数に
// 渡す。decodeAudioToPcm 自体は「音声ストリームが無いと ffmpeg がエラー
// 終了する」ため、デコード後に pcm.length で判定するのでは間に合わない。

test("insertHasNoAudio: 音声ストリーム無し(hasAudioStream:false)→ デコード省略", () => {
  assert.equal(insertHasNoAudio({ file: "materials/insert-silent.mp4" }, false), true);
});

test("insertHasNoAudio: 音声ストリームあり(hasAudioStream:true)→ デコードする", () => {
  assert.equal(insertHasNoAudio({ file: "materials/insert-a.mp4" }, true), false);
});

test("insertHasNoAudio: 画像素材 → hasAudioStream に関わらずデコード省略", () => {
  assert.equal(insertHasNoAudio({ file: "materials/photo.png" }, true), true);
});

test("insertHasNoAudio: volume:0 → hasAudioStream に関わらずデコード省略", () => {
  assert.equal(insertHasNoAudio({ file: "materials/insert-a.mp4", volume: 0 }, true), true);
});

test("insertHasNoAudio: volume 省略(既定1)・音声あり → デコードする", () => {
  assert.equal(insertHasNoAudio({ file: "materials/insert-a.mp4" }, true), false);
});

// ---- I-4: startFrom → 挿入区間の先頭サンプルが素材の round(startFrom*fps) frame 相当から始まる ----

test("I-4: startFrom は素材内の頭出し(round(startFrom*fps) frame 相当)から読む", () => {
  const props = mkI1Props({ startFrom: 0.5 }); // fps=2 → round(0.5*2)=1 frame = 2 sample(sr=4)ぶん頭出し
  const layout = okLayout(props);
  // 先頭2サンプル(idx0,1)は startFrom で読み飛ばされ、idx2以降が I-1 と同じ値になるよう構成
  const insertPcm = new Float32Array([90, 190, 91, 191, 10, 20, 11, 21, 12, 22, 13, 23]);
  const bed = buildInsertBedPcm({
    props,
    layout,
    cutPcm: CUT_PCM_I1,
    insertPcms: [insertPcm],
    sampleRate: 4,
    channels: 2,
  });
  assert.deepEqual(
    Array.from(bed),
    [10, 20, 11, 21, 12, 22, 13, 23, 100, 200, 101, 201, 102, 202, 103, 203],
  );
});

// ---- I-5: durationSec が素材実尺を超える → 超過ぶんがゼロ埋め ----

test("I-5: 素材が尽きたぶんはゼロ埋め(freeze の映像に対する無音)", () => {
  const props = mkI1Props();
  const layout = okLayout(props);
  // 挿入は4サンプル要求するが素材は2サンプルしかない(実尺不足)
  const shortInsertPcm = new Float32Array([10, 20, 11, 21]);
  const bed = buildInsertBedPcm({
    props,
    layout,
    cutPcm: CUT_PCM_I1,
    insertPcms: [shortInsertPcm],
    sampleRate: 4,
    channels: 2,
  });
  assert.deepEqual(
    Array.from(bed),
    [10, 20, 11, 21, 0, 0, 0, 0, 100, 200, 101, 201, 102, 202, 103, 203],
  );
});

// ---- I-6: BGM は加算される(ベース・挿入いずれの区間でも) ----

test("I-6: BGM ありで mixBgmPcm の出力が加算されている", () => {
  const props = mkI1Props();
  const layout = okLayout(props);
  const bgmPcm = new Float32Array(Array.from({ length: 16 }, (_, i) => i * 1000));
  const bed = buildInsertBedPcm({
    props,
    layout,
    cutPcm: CUT_PCM_I1,
    insertPcms: [INSERT_PCM_I1],
    bgmPcm,
    sampleRate: 4,
    channels: 2,
  });
  const withoutBgm = [10, 20, 11, 21, 12, 22, 13, 23, 100, 200, 101, 201, 102, 202, 103, 203];
  const expected = withoutBgm.map((v, i) => v + bgmPcm[i]);
  assert.deepEqual(Array.from(bed), expected);
});

// ---- I-7: 出力長 ----

test("I-7: 出力長は bgmMixSampleCount(totalFrames, sr, fps) * channels", () => {
  const props = mkI1Props();
  const layout = okLayout(props);
  const bed = buildInsertBedPcm({
    props,
    layout,
    cutPcm: CUT_PCM_I1,
    insertPcms: [INSERT_PCM_I1],
    sampleRate: 4,
    channels: 2,
  });
  assert.equal(bed.length, bgmMixSampleCount(layout.totalFrames, 4, 2) * 2);
});

// ---- I-8: buildPcmEncodeArgs の argv 固定 ----

test("I-8: buildPcmEncodeArgs は f32le 入力を apad,atrim,asetpts 整形して AAC 192k へ1回だけエンコードする", () => {
  const args = buildPcmEncodeArgs({
    pcmPath: "/rec/render.fast/.insert-mix-bed.f32le",
    outM4a: "/rec/render.fast/audio.m4a",
    durationSec: 6303 / 30,
  });
  assert.deepEqual(args, [
    "-y", "-v", "error",
    "-f", "f32le",
    "-ar", "48000",
    "-ac", "2",
    "-i", "/rec/render.fast/.insert-mix-bed.f32le",
    "-af", `apad,atrim=duration=${6303 / 30},asetpts=N/SR/TB`,
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "/rec/render.fast/audio.m4a",
  ]);
});

test("I-8b: durationSec が正でなければ throw", () => {
  assert.throws(() => buildPcmEncodeArgs({ pcmPath: "/a.f32le", outM4a: "/o.m4a", durationSec: 0 }));
  assert.throws(() => buildPcmEncodeArgs({ pcmPath: "/a.f32le", outM4a: "/o.m4a", durationSec: -1 }));
});
