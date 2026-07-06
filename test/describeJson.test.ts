// stages/describe.ts の describeJson(dir)(機械可読な完全射影)を固定する。
// タスク1の「全部入り」リッチ fixture(buildRichFixture)を再掲・再利用し、
// 散文 describe() では失われる情報(36字超発話・タイトル全件・演出の全
// フィールド・元⇔出力の対応)がそのまま JSON に残ることを検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("演出の全フィールドが verbatim(overlays/inserts/zooms/blurs/colorFilter)", () => {
  withTmpDir(buildRichFixture, (dir) => {
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
    assert.equal(proj.overlays.blurs[0].type, "mosaic");
    assert.equal(proj.overlays.blurs[0].strength, 0.7);
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

test("決定論: 同じ入力から同じバイト列(JSON.stringify が安定)", () => {
  withTmpDir(buildRichFixture, (dir) => {
    const a = JSON.stringify(describeJson(dir));
    const b = JSON.stringify(describeJson(dir));
    assert.equal(a, b);
  });
});
