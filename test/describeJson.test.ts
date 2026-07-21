// stages/describe.ts の describeJson(dir)(機械可読な完全射影)を固定する。
// タスク1の「全部入り」リッチ fixture(buildRichFixture)を再掲・再利用し、
// 散文 describe() では失われる情報(36字超発話・タイトル全件・演出の全
// フィールド・元⇔出力の対応)がそのまま JSON に残ることを検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeJson } from "../src/stages/describe.ts";
import {
  buildRichFixture,
  LONG_CAPTION_TEXT,
  LOST_CAPTION_TEXT,
} from "./describe.test.ts";

function withTmpDir(build: (dir: string) => void, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-describeJson-"));
  try {
    build(dir);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("schemaVersion === 1", () => {
  withTmpDir(buildRichFixture, (dir) => {
    assert.equal(describeJson(dir).schemaVersion, 1);
  });
});

test("全文主義: 36字超の発話が captions[].text / cuts[].lostCaptions[].text に切り捨てなしで現れる", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const proj = describeJson(dir);

    assert.ok(LONG_CAPTION_TEXT.length > 36);
    assert.ok(LOST_CAPTION_TEXT.length > 36);

    const longCaption = proj.captions.find((c) => c.text === LONG_CAPTION_TEXT);
    assert.ok(longCaption, "36字超の発話が captions に切り捨てなしで存在すること");
    assert.equal(longCaption!.text.includes("…"), false);

    const lost = proj.cuts.flatMap((c) => c.lostCaptions);
    const lostLong = lost.find((c) => c.text === LOST_CAPTION_TEXT);
    assert.ok(lostLong, "36字超の消える発言が lostCaptions に切り捨てなしで存在すること");
    assert.equal(lostLong!.text.includes("…"), false);
  });
});

test("タイトル全件: meta.titles が meta.json の件数と一致し slice(0,3) されない", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const proj = describeJson(dir);
    assert.equal(proj.meta.titles.length, 5);
    assert.deepEqual(proj.meta.titles, [
      "タイトル案1",
      "タイトル案2",
      "タイトル案3",
      "タイトル案4",
      "タイトル案5",
    ]);
  });
});

test("元⇔出力写像: keep の outStart/outEnd が toOutputTime と一致", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const proj = describeJson(dir);
    assert.deepEqual(
      proj.keeps.map((k) => [k.start, k.end, k.outStart, k.outEnd]),
      [
        [0, 40, 0, 40],
        [50, 150, 40, 140],
        [160, 200, 145, 185],
      ],
    );
  });
});

test("カット内テロップは out:[] / keepIndex:null / visible:false", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const proj = describeJson(dir);
    const cutCaption = proj.captions.find((c) => c.text === LOST_CAPTION_TEXT);
    assert.ok(cutCaption);
    assert.deepEqual(cutCaption!.out, []);
    assert.equal(cutCaption!.keepIndex, null);
    assert.equal(cutCaption!.visible, false);
  });
});

test("境界をまたぐテロップは重なる keep 部分だけ out に残る(見える扱い)", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const proj = describeJson(dir);
    const boundary = proj.captions.find((c) => c.text === "境界をまたぐ発言");
    assert.ok(boundary);
    // keep0 は 0–40。発言は 38–43 なので、見えるのは 38–40 だけ
    assert.deepEqual(boundary!.out, [{ start: 38, end: 40 }]);
    assert.equal(boundary!.keepIndex, 0);
    assert.equal(boundary!.visible, true);
  });
});

test("章の out は snapToOutput と一致(カット内はスナップ先の出力秒)", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const proj = describeJson(dir);
    assert.deepEqual(
      proj.chapters.map((c) => [c.start, c.out, c.title]),
      [
        [0, 0, "導入"],
        [45, 40, "スナップ章"],
      ],
    );
  });
});

test("セグメント個別のテロップ pos/style/words のみ verbatim(トラック標準は解決しない)", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const proj = describeJson(dir);
    const withStyle = proj.captions.find((c) => c.track === 2);
    assert.ok(withStyle);
    assert.deepEqual(withStyle!.pos, { x: 960, y: 900 });
    assert.deepEqual(withStyle!.style, {
      fontSizePx: 40,
      color: "#ffff00",
      outlineColor: "none",
    });
    assert.equal(withStyle!.words?.length, 2);
    // pos/style 指定の無いテロップにはキー自体が無い(捏造しない)
    const plain = proj.captions.find((c) => c.text === "こんにちは");
    assert.ok(plain);
    assert.equal("pos" in plain!, false);
    assert.equal("style" in plain!, false);
    assert.equal("words" in plain!, false);
  });
});

test("演出の全フィールドが verbatim(overlays/inserts/zooms/blurs/annotations/colorFilter)", () => {
  withTmpDir((dir) => {
    buildRichFixture(dir);
    writeFileSync(join(dir, "overlays.json"), JSON.stringify({
      overlays: [
        {
          start: 5,
          end: 9,
          file: "materials/slide.png",
          track: 2,
          fit: "contain",
          opacity: 0.9,
          fadeInSec: 0.5,
        },
        { start: 60, end: 65, file: "materials/missing.png" },
      ],
      inserts: [
        {
          at: 100,
          file: "materials/insert.mp4",
          durationSec: 5,
          volume: 1,
          fadeInSec: 0.2,
        },
      ],
      wipeFull: [{ start: 20, end: 25 }],
      zooms: [
        { start: 70, end: 75, rect: { x: 0, y: 0, w: 960, h: 1080 }, easeSec: 0.3, reasonId: "tiny-target" },
      ],
      blurs: [
        {
          start: 80,
          end: 85,
          rect: { x: 100, y: 100, w: 200, h: 100 },
          strength: 0.7,
          reasonId: "secret-exposure",
        },
      ],
      annotations: [
        {
          id: "ann_abc123",
          type: "box",
          start: 86,
          end: 88,
          rect: { x: 120, y: 140, w: 220, h: 110 },
          color: "#ff0000",
          fill: "rgba(255,0,0,0.2)",
          reasonId: "attention-scatter",
        },
      ],
      hideCaption: [{ start: 90, end: 92 }],
      colorFilter: { brightness: 1.1, contrast: 1.05, saturate: 0.95 },
      layerOrder: ["ov1", "wipe", "caption"],
      captionTracks: [
        { track: 1, name: "本文" },
        { track: 2, name: "補足", x: 960, y: 900, anchor: "center" },
      ],
    }, null, 2), "utf8");
  }, (dir) => {
    const proj = describeJson(dir);
    const missing = proj.overlays.materials.find((m) => m.file === "materials/missing.png");
    assert.ok(missing);
    assert.equal(missing!.exists, false);
    const slide = proj.overlays.materials.find((m) => m.file === "materials/slide.png");
    assert.ok(slide);
    assert.equal(slide!.exists, true);
    assert.equal(slide!.opacity, 0.9);
    assert.equal(slide!.fadeInSec, 0.5);

    assert.equal(proj.overlays.inserts.length, 1);
    assert.deepEqual(proj.overlays.inserts[0].out, { start: 90, end: 95 });

    assert.equal(proj.overlays.zooms[0].rect.w, 960);
    assert.equal(proj.overlays.zooms[0].easeSec, 0.3);
    assert.equal(proj.overlays.zooms[0].reasonId, "tiny-target");
    assert.deepEqual(proj.overlays.blurs[0].rect, { x: 100, y: 100, w: 200, h: 100 });
    assert.equal(proj.overlays.blurs[0].strength, 0.7);
    assert.equal(proj.overlays.blurs[0].reasonId, "secret-exposure");
    assert.equal(proj.overlays.annotations[0].id, "ann_abc123");
    assert.equal(proj.overlays.annotations[0].type, "box");
    assert.equal(proj.overlays.annotations[0].reasonId, "attention-scatter");
    assert.deepEqual(proj.overlays.annotations[0].out, [{ start: 76, end: 78 }]);
    assert.deepEqual(proj.overlays.colorFilter, {
      brightness: 1.1,
      contrast: 1.05,
      saturate: 0.95,
    });
  });
});

test("ショート: ranges は verbatim、mergedRanges はショート専用 timeline で出力秒を持つ", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const proj = describeJson(dir);
    const short2 = proj.shorts.find((s) => s.name === "short-2");
    assert.ok(short2);
    // 隣接する2区間(110–115, 115–120)は verbatim には両方残るが
    assert.equal(short2!.ranges.length, 2);
    // mergedRanges は1本にまとまる(ショート専用 timeline)
    assert.deepEqual(short2!.mergedRanges, [
      { index: 0, start: 110, end: 120, durationSec: 10, outStart: 0, outEnd: 10 },
    ]);
    assert.equal(short2!.outDurationSec, 10);
    assert.equal(short2!.profile, "vertical");
  });
});

test("容器常在: overlays/bgm/chapters/meta/shorts が無い最小フォルダでも全トップレベルキーが存在", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-describeJson-min-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data), "utf8");
    write("manifest.json", {
      dir,
      source: "raw.mkv",
      durationSec: 100,
      layout: "plain",
      video: {
        width: 1080,
        height: 1920,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1080, h: 1920 },
      },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-06T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 100, action: "keep", reason: "本編" }],
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [],
    });

    const proj = describeJson(dir);
    assert.deepEqual(proj.overlays.materials, []);
    assert.deepEqual(proj.overlays.inserts, []);
    assert.deepEqual(proj.overlays.wipeFull, []);
    assert.deepEqual(proj.overlays.zooms, []);
    assert.deepEqual(proj.overlays.blurs, []);
    assert.deepEqual(proj.overlays.annotations, []);
    assert.deepEqual(proj.overlays.hideCaption, []);
    assert.equal(proj.overlays.colorFilter, null);
    assert.equal(proj.overlays.layerOrder, null);
    assert.deepEqual(proj.overlays.captionTracks, []);
    assert.deepEqual(proj.bgm, { source: "none" });
    assert.deepEqual(proj.chapters, []);
    assert.deepEqual(proj.meta, { titles: [], description: "" });
    assert.deepEqual(proj.shorts, []);
    // plain レイアウトかつ cameraRegion 省略時は捏造しない(規則C)
    assert.equal("cameraRegion" in proj.source.video, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keyframes: sourceAt と outputTimes を materials/blurs/annotations に載せる", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-describeJson-keyframes-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data), "utf8");
    write("manifest.json", {
      dir,
      source: "raw.mkv",
      durationSec: 20,
      layout: "plain",
      video: {
        width: 1920,
        height: 1080,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
      },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-09T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [
        { start: 0, end: 5, action: "keep", reason: "a" },
        { start: 10, end: 15, action: "keep", reason: "b" },
      ],
    });
    write("transcript.json", { language: "ja", model: "test", segments: [] });
    write("overlays.json", {
      overlays: [{
        start: 0,
        end: 15,
        file: "materials/pip.png",
        keyframes: [{ at: 10, values: { x: 100 } }],
      }],
      blurs: [{
        start: 0,
        end: 15,
        rect: { x: 0, y: 0, w: 10, h: 10 },
        keyframes: [{ at: 7, values: { x: 10 } }],
      }],
      annotations: [{
        type: "box",
        start: 0,
        end: 15,
        rect: { x: 0, y: 0, w: 10, h: 10 },
        keyframes: [{ at: 15, values: { x: 20 } }],
      }],
    });
    mkdirSync(join(dir, "materials"), { recursive: true });
    writeFileSync(join(dir, "materials", "pip.png"), "", { flag: "w" });
    const proj = describeJson(dir);
    assert.deepEqual(proj.overlays.materials[0].keyframes, [
      { sourceAt: 10, outputTimes: [5], values: { x: 100 } },
    ]);
    assert.deepEqual(proj.overlays.blurs[0].keyframes, [
      { sourceAt: 7, outputTimes: [], values: { x: 10 } },
    ]);
    assert.deepEqual(proj.overlays.annotations[0]?.keyframes, [
      { sourceAt: 15, outputTimes: [10], values: { x: 20 } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("決定論: 同じ入力から同じバイト列(JSON.stringify が安定)", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const a = JSON.stringify(describeJson(dir));
    const b = JSON.stringify(describeJson(dir));
    assert.equal(a, b);
  });
});

/* ---------------- 安定 id(§docs/plans/2026-07-07-stable-ids-design.md) ---------------- */

test("id 無し fixture(buildRichFixture)は射影のどこにも id キーが現れない(規則C不変)", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const proj = describeJson(dir);
    for (const c of proj.captions) assert.equal("id" in c, false);
    for (const m of proj.overlays.materials) assert.equal("id" in m, false);
    for (const i of proj.overlays.inserts) assert.equal("id" in i, false);
    for (const w of proj.overlays.wipeFull) assert.equal("id" in w, false);
    for (const z of proj.overlays.zooms) assert.equal("id" in z, false);
    for (const b of proj.overlays.blurs) assert.equal("id" in b, false);
    for (const h of proj.overlays.hideCaption) assert.equal("id" in h, false);
    for (const ch of proj.chapters) assert.equal("id" in ch, false);
    for (const s of proj.shorts) for (const r of s.ranges) assert.equal("id" in r, false);
  });
});

test("id 付き fixture: 各 *Entry に id が載る(index の次)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-describeJson-ids-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data), "utf8");
    write("manifest.json", {
      dir,
      source: "raw.mkv",
      durationSec: 100,
      layout: "plain",
      video: {
        width: 1080,
        height: 1920,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1080, h: 1920 },
      },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-06T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ id: "seg_a1a1a1", start: 0, end: 100, action: "keep", reason: "本編" }],
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [{ id: "cap_b2b2b2", start: 1, end: 3, text: "こんにちは" }],
    });
    write("overlays.json", {
      overlays: [{ id: "mat_c3c3c3", start: 0, end: 1, file: "a.png" }],
      inserts: [{ id: "ins_d4d4d4", at: 1, file: "b.mp4", durationSec: 2 }],
      wipeFull: [{ id: "wf_e5e5e5", start: 0, end: 1 }],
      hideCaption: [{ id: "hc_f6f6f6", start: 0, end: 1 }],
      zooms: [{ id: "zm_g7g7g7", start: 0, end: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      blurs: [{ id: "bl_h8h8h8", start: 0, end: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
    });
    write("chapters.json", { chapters: [{ id: "ch_i9i9i9", start: 0, title: "導入" }] });
    write("shorts.json", {
      shorts: [{ name: "s1", approved: false, ranges: [{ id: "rg_j0j0j0", start: 0, end: 1 }] }],
    });

    const proj = describeJson(dir);
    assert.equal(proj.captions[0].id, "cap_b2b2b2");
    assert.equal(proj.overlays.materials[0].id, "mat_c3c3c3");
    assert.equal(proj.overlays.inserts[0].id, "ins_d4d4d4");
    assert.equal(proj.overlays.wipeFull[0].id, "wf_e5e5e5");
    assert.equal(proj.overlays.hideCaption[0].id, "hc_f6f6f6");
    assert.equal(proj.overlays.zooms[0].id, "zm_g7g7g7");
    assert.equal(proj.overlays.blurs[0].id, "bl_h8h8h8");
    assert.equal(proj.chapters[0].id, "ch_i9i9i9");
    assert.equal(proj.shorts[0].ranges[0].id, "rg_j0j0j0");
    // id は index の次のキー(先頭側)に置かれる
    assert.deepEqual(Object.keys(proj.captions[0]).slice(0, 2), ["index", "id"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
