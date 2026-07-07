// lib/materials.ts(素材知覚。タスク2)の純関数群を、注入した probe 結果で
// 固定する。実 ffprobe/ffmpeg には一切依存しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFileSet,
  buildMaterialEntry,
  buildMaterialsIndex,
  buildReferences,
  classifyKind,
  fingerprintEquals,
  groupReferencesByFile,
  materialSlug,
} from "../src/lib/materials.ts";
import type { MaterialInput } from "../src/lib/materials.ts";
import type { Bgm, Overlays } from "../src/types.ts";

/* ---------------- classifyKind ---------------- */

test("classifyKind: 拡張子で種別判定(大文字小文字を区別しない)", () => {
  assert.equal(classifyKind("materials/opening.mp4"), "video");
  assert.equal(classifyKind("materials/opening.MOV"), "video");
  assert.equal(classifyKind("materials/slide-01.png"), "image");
  assert.equal(classifyKind("materials/favicon.PNG"), "image");
  assert.equal(classifyKind("bgm.mp3"), "audio");
  assert.equal(classifyKind("materials/.DS_Store"), "unknown");
  assert.equal(classifyKind("materials/notes.txt"), "unknown");
});

/* ---------------- buildReferences / groupReferencesByFile ---------------- */

test("buildReferences: overlays[].file を overlay 参照として集める(id 併記)", () => {
  const overlays: Overlays = {
    overlays: [{ id: "mat_ab12cd", start: 0, end: 4, file: "materials/opening.mp4" }],
  };
  const refs = buildReferences(overlays, null);
  assert.deepEqual(refs, [
    { file: "materials/opening.mp4", ref: { as: "overlay", id: "mat_ab12cd", start: 0, end: 4 } },
  ]);
});

test("buildReferences: inserts[].file を insert 参照として集める(id 省略可)", () => {
  const overlays: Overlays = {
    inserts: [{ at: 12.5, file: "materials/opening.mp4", durationSec: 4 }],
  };
  const refs = buildReferences(overlays, null);
  assert.deepEqual(refs, [
    { file: "materials/opening.mp4", ref: { as: "insert", at: 12.5, durationSec: 4 } },
  ]);
});

test("buildReferences: bgm.tracks[].file を bgm 参照として集める", () => {
  const bgm: Bgm = { tracks: [{ id: "bg_112233", start: 0, end: 30, file: "materials/theme.mp3" }] };
  const refs = buildReferences(null, bgm);
  assert.deepEqual(refs, [
    { file: "materials/theme.mp3", ref: { as: "bgm", id: "bg_112233", start: 0, end: 30 } },
  ]);
});

test("buildReferences: overlays/inserts/bgm が無ければ空配列(overlays=null, bgm=null)", () => {
  assert.deepEqual(buildReferences(null, null), []);
  assert.deepEqual(buildReferences({}, {}), []);
});

test("buildReferences: 同一ファイルが複数箇所から参照されてもよい(複数 MaterialRef)", () => {
  const overlays: Overlays = {
    overlays: [{ start: 0, end: 4, file: "materials/opening.mp4" }],
    inserts: [{ at: 12.5, file: "materials/opening.mp4", durationSec: 4 }],
  };
  const refs = buildReferences(overlays, null);
  assert.equal(refs.length, 2);
  const grouped = groupReferencesByFile(refs);
  assert.equal(grouped.get("materials/opening.mp4")?.length, 2);
  assert.equal(grouped.get("materials/opening.mp4")?.[0].as, "overlay");
  assert.equal(grouped.get("materials/opening.mp4")?.[1].as, "insert");
});

/* ---------------- materialSlug ---------------- */

test("materialSlug: パス区切りを __ に置換する", () => {
  assert.equal(materialSlug("materials/slide-01.png"), "materials__slide-01.png");
  assert.equal(materialSlug("materials/sub/dir/a.mp4"), "materials__sub__dir__a.mp4");
  assert.equal(materialSlug("bgm.mp3"), "bgm.mp3");
});

test("materialSlug: 同一 stem・別拡張子は衝突しない", () => {
  assert.notEqual(materialSlug("materials/a.mp4"), materialSlug("materials/a.png"));
});

test("materialSlug: materials/ 直下以外の参照(root の bgm.mp3 等)でも衝突しない", () => {
  assert.notEqual(materialSlug("bgm.mp3"), materialSlug("materials/bgm.mp3"));
});

/* ---------------- fingerprintEquals ---------------- */

test("fingerprintEquals: mtime・size が両方一致すれば true", () => {
  assert.equal(
    fingerprintEquals({ mtimeMs: 100, size: 200 }, { mtimeMs: 100, size: 200 }),
    true,
  );
});

test("fingerprintEquals: mtime か size のどちらかが違えば false", () => {
  assert.equal(fingerprintEquals({ mtimeMs: 100, size: 200 }, { mtimeMs: 101, size: 200 }), false);
  assert.equal(fingerprintEquals({ mtimeMs: 100, size: 200 }, { mtimeMs: 100, size: 201 }), false);
});

test("fingerprintEquals: どちらかが未取得(undefined)なら false(再利用しない)", () => {
  assert.equal(fingerprintEquals(undefined, { mtimeMs: 100, size: 200 }), false);
  assert.equal(fingerprintEquals({ mtimeMs: 100, size: 200 }, undefined), false);
  assert.equal(fingerprintEquals(undefined, undefined), false);
});

/* ---------------- buildFileSet ---------------- */

test("buildFileSet: present ∪ referenced の和集合・重複排除・ソート済み", () => {
  const present = ["materials/opening.mp4", "materials/slide-01.png"];
  const referenced = ["materials/opening.mp4", "materials/ghost.mp4"];
  assert.deepEqual(buildFileSet(present, referenced), [
    "materials/ghost.mp4",
    "materials/opening.mp4",
    "materials/slide-01.png",
  ]);
});

test("buildFileSet: materials/ 外(root の bgm.mp3 等)の参照も含む", () => {
  assert.deepEqual(buildFileSet(["materials/a.mp4"], ["bgm.mp3"]), ["bgm.mp3", "materials/a.mp4"]);
});

/* ---------------- buildMaterialEntry / buildMaterialsIndex ---------------- */

test("buildMaterialEntry: 未使用素材(present:true, references:[])は used:false", () => {
  const input: MaterialInput = {
    file: "materials/slide-01.png",
    present: true,
    kind: "image",
    fingerprint: { mtimeMs: 1, size: 100 },
    probe: { width: 3840, height: 2160, hasAudio: false, videoCodec: "png" },
  };
  const entry = buildMaterialEntry(input, []);
  assert.equal(entry.used, false);
  assert.equal(entry.present, true);
  assert.deepEqual(entry.references, []);
});

test("buildMaterialEntry: dangling 参照(present:false, references 有り)は used:true・probe/fingerprint 省略", () => {
  const input: MaterialInput = { file: "materials/ghost.mp4", present: false, kind: "video" };
  const refs = [{ as: "overlay" as const, id: "mat_9911zz", start: 30, end: 34 }];
  const entry = buildMaterialEntry(input, refs);
  assert.equal(entry.used, true);
  assert.equal(entry.present, false);
  assert.equal("fingerprint" in entry, false);
  assert.equal("probe" in entry, false);
  assert.deepEqual(entry.references, refs);
});

test("buildMaterialEntry: opt-in 層(frame/ocr/transcribe)は注入されたときだけキーが出る", () => {
  const withoutLayers = buildMaterialEntry(
    { file: "materials/opening.mp4", present: true, kind: "video" },
    [],
  );
  assert.equal("frame" in withoutLayers, false);
  assert.equal("ocr" in withoutLayers, false);
  assert.equal("transcribe" in withoutLayers, false);

  const withLayers = buildMaterialEntry(
    {
      file: "materials/opening.mp4",
      present: true,
      kind: "video",
      frame: { file: "materials.probe/materials__opening.mp4.png", atSec: 2.01, width: 1920, height: 1080 },
      ocr: { file: "materials.probe/materials__opening.mp4.ocr.json", coordSpace: "material-frame-px", lineCount: 2, preview: ["a", "b"] },
      transcribe: { file: "materials.probe/materials__opening.mp4.transcribe.json", segmentCount: 3, preview: "hello" },
    },
    [],
  );
  assert.ok(withLayers.frame);
  assert.ok(withLayers.ocr);
  assert.ok(withLayers.transcribe);
});

test("buildMaterialsIndex: present∪参照の全素材を組み立て、schemaVersion/capturedAt を持つ", () => {
  const overlays: Overlays = {
    overlays: [{ id: "mat_ab12cd", start: 0, end: 4, file: "materials/opening.mp4" }],
  };
  const bgm: Bgm = { tracks: [] };
  const refs = buildReferences(overlays, bgm);
  const byFile = groupReferencesByFile(refs);
  const files = buildFileSet(
    ["materials/opening.mp4", "materials/slide-01.png"],
    [...byFile.keys(), "materials/ghost.mp4"],
  );
  const inputs: MaterialInput[] = files.map((file) => ({
    file,
    present: file !== "materials/ghost.mp4",
    kind: classifyKind(file),
  }));
  // dangling 参照(ghost.mp4)にも references を通す(present は inputs 側で決まる)
  byFile.set("materials/ghost.mp4", [{ as: "overlay", id: "mat_9911zz", start: 30, end: 34 }]);

  const index = buildMaterialsIndex(inputs, byFile, "2026-07-07T00:00:00.000Z");
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.capturedAt, "2026-07-07T00:00:00.000Z");
  assert.equal(index.materials.length, 3);

  const opening = index.materials.find((m) => m.file === "materials/opening.mp4")!;
  assert.equal(opening.used, true);
  assert.equal(opening.present, true);

  const slide = index.materials.find((m) => m.file === "materials/slide-01.png")!;
  assert.equal(slide.used, false);
  assert.equal(slide.present, true);

  const ghost = index.materials.find((m) => m.file === "materials/ghost.mp4")!;
  assert.equal(ghost.used, true);
  assert.equal(ghost.present, false);
});
