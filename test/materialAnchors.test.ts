// src/lib/materialAnchors.ts(M1+M4 の純ロジック)+ 応答パーサの堅牢性を固定する。
// §docs/plans/2026-07-11-m1-material-placement-candidates-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAnchors,
  buildMaterialChoices,
  placementsToOverlays,
} from "../src/lib/materialAnchors.ts";
import type { MaterialAnchor, MaterialChoice } from "../src/lib/materialAnchors.ts";
import { parsePlacementsResponse } from "../src/stages/planMaterials.ts";
import type { CutPlan, Transcript } from "../src/types.ts";
import type { MaterialsIndex } from "../src/lib/materials.ts";

function cutplan(segments: { start: number; end: number; action: "keep" | "cut" }[]): CutPlan {
  return {
    approved: false,
    segments: segments.map((s) => ({ ...s, reason: "" })),
  };
}

function transcript(segments: { start: number; end: number; text: string }[]): Transcript {
  return {
    language: "ja",
    model: "test",
    segments: segments.map((s) => ({ ...s, track: 1 })),
  };
}

/* ---------------- buildAnchors ---------------- */

test("buildAnchors: keep span だけをアンカー化し、cut span は除外", () => {
  const cp = cutplan([
    { start: 0, end: 10, action: "keep" },
    { start: 10, end: 15, action: "cut" },
    { start: 15, end: 25, action: "keep" },
  ]);
  const t = transcript([{ start: 0, end: 25, text: "hello" }]);
  const anchors = buildAnchors(cp, t, 3.0);
  assert.deepEqual(
    anchors.map((a) => [a.id, a.start, a.end]),
    [
      [1, 0, 10],
      [2, 15, 25],
    ],
  );
});

test("buildAnchors: minSpanSec 未満の span は除外", () => {
  const cp = cutplan([
    { start: 0, end: 2, action: "keep" }, // 2秒 < 3.0 → 除外
    { start: 10, end: 20, action: "keep" },
  ]);
  const t = transcript([]);
  const anchors = buildAnchors(cp, t, 3.0);
  assert.deepEqual(anchors.map((a) => a.id), [1]);
  assert.deepEqual([anchors[0].start, anchors[0].end], [10, 20]);
});

test("buildAnchors: id は1始まり連番", () => {
  const cp = cutplan([
    { start: 0, end: 5, action: "keep" },
    { start: 10, end: 15, action: "keep" },
    { start: 20, end: 25, action: "keep" },
  ]);
  const anchors = buildAnchors(cp, transcript([]), 3.0);
  assert.deepEqual(anchors.map((a) => a.id), [1, 2, 3]);
});

test("buildAnchors: transcriptText は span 内に中点が入る語だけ(words 優先)", () => {
  const cp = cutplan([{ start: 0, end: 10, action: "keep" }]);
  const t: Transcript = {
    language: "ja",
    model: "test",
    segments: [
      {
        start: 0,
        end: 10,
        text: "ignored-segment-text",
        track: 1,
        words: [
          { text: "hello", start: 1, end: 2 }, // mid=1.5 ∈ [0,10)
          { text: "world", start: 9, end: 20 }, // mid=14.5 ∉ [0,10)
        ],
      },
    ],
  };
  const anchors = buildAnchors(cp, t, 3.0);
  assert.equal(anchors[0].transcriptText, "hello");
});

test("buildAnchors: words が無ければ overlap segment の全文にフォールバック", () => {
  const cp = cutplan([{ start: 0, end: 10, action: "keep" }]);
  const t = transcript([{ start: 0, end: 10, text: "no words here" }]);
  const anchors = buildAnchors(cp, t, 3.0);
  assert.equal(anchors[0].transcriptText, "no words here");
});

/* ---------------- buildMaterialChoices ---------------- */

function materialsIndex(materials: MaterialsIndex["materials"]): MaterialsIndex {
  return { schemaVersion: 1, capturedAt: "2026-01-01T00:00:00.000Z", materials };
}

test("buildMaterialChoices: present:false(dangling)を除外", () => {
  const idx = materialsIndex([
    { file: "materials/a.mp4", present: true, kind: "video", references: [], used: false },
    { file: "materials/b.mp4", present: false, kind: "video", references: [], used: true },
  ]);
  const choices = buildMaterialChoices(idx);
  assert.deepEqual(choices.map((c) => c.file), ["materials/a.mp4"]);
});

test("buildMaterialChoices: kind unknown/audio を除外", () => {
  const idx = materialsIndex([
    { file: "materials/a.mp4", present: true, kind: "video", references: [], used: false },
    { file: "materials/x.txt", present: true, kind: "unknown", references: [], used: false },
    { file: "materials/song.mp3", present: true, kind: "audio", references: [], used: false },
  ]);
  const choices = buildMaterialChoices(idx);
  assert.deepEqual(choices.map((c) => c.file), ["materials/a.mp4"]);
});

test("buildMaterialChoices: used:true でも候補に残る", () => {
  const idx = materialsIndex([
    {
      file: "materials/a.mp4",
      present: true,
      kind: "video",
      references: [{ as: "overlay", start: 0, end: 1 }],
      used: true,
    },
  ]);
  const choices = buildMaterialChoices(idx);
  assert.equal(choices.length, 1);
});

test("buildMaterialChoices: durationSec/hasAudio/ocrPreview/transcribePreview を引き回す", () => {
  const idx = materialsIndex([
    {
      file: "materials/a.mp4",
      present: true,
      kind: "video",
      references: [],
      used: false,
      probe: { durationSec: 12.5, hasAudio: true },
      ocr: { file: "materials/a.mp4", coordSpace: "material-frame-px", lineCount: 2, preview: ["line1", "line2"] },
      transcribe: { file: "materials/a.mp4", segmentCount: 3, preview: "hello world" },
    },
  ]);
  const choices = buildMaterialChoices(idx);
  assert.deepEqual(choices[0], {
    id: 1,
    file: "materials/a.mp4",
    kind: "video",
    durationSec: 12.5,
    hasAudio: true,
    ocrPreview: ["line1", "line2"],
    transcribePreview: "hello world",
  });
});

test("buildMaterialChoices: id は1始まり連番", () => {
  const idx = materialsIndex([
    { file: "materials/a.mp4", present: true, kind: "video", references: [], used: false },
    { file: "materials/b.png", present: true, kind: "image", references: [], used: false },
  ]);
  const choices = buildMaterialChoices(idx);
  assert.deepEqual(choices.map((c) => c.id), [1, 2]);
});

/* ---------------- placementsToOverlays ---------------- */

const CFG = { minSpanSec: 3.0, maxPlacements: 8, defaultVolume: 0, defaultFit: "contain" as const };

function anchor(id: number, start: number, end: number): MaterialAnchor {
  return { id, start, end, transcriptText: "" };
}

function videoChoice(id: number, file: string, durationSec?: number): MaterialChoice {
  return { id, file, kind: "video", ...(durationSec !== undefined ? { durationSec } : {}) };
}

function imageChoice(id: number, file: string): MaterialChoice {
  return { id, file, kind: "image" };
}

test("placementsToOverlays: 存在しない anchorId / materialId を捨てる", () => {
  const anchors = [anchor(1, 0, 10)];
  const choices = [videoChoice(1, "materials/a.mp4", 20)];
  const out = placementsToOverlays(
    [
      { anchorId: 99, materialId: 1, reason: "" },
      { anchorId: 1, materialId: 99, reason: "" },
      { anchorId: 1, materialId: 1, reason: "" },
    ],
    anchors,
    choices,
    CFG,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "materials/a.mp4");
});

test("placementsToOverlays: overlay の start/end はアンカーの実区間と一致", () => {
  const anchors = [anchor(1, 12.3, 15.8)];
  const choices = [videoChoice(1, "materials/a.mp4", 20)];
  const out = placementsToOverlays(
    [{ anchorId: 1, materialId: 1, reason: "" }],
    anchors,
    choices,
    CFG,
  );
  assert.equal(out[0].start, 12.3);
  assert.equal(out[0].end, 15.8);
});

test("placementsToOverlays: 動画実尺 < span 尺 → end が start+実尺へ詰まる(尺超過を作らない)", () => {
  const anchors = [anchor(1, 0, 10)];
  const choices = [videoChoice(1, "materials/a.mp4", 4)];
  const out = placementsToOverlays(
    [{ anchorId: 1, materialId: 1, reason: "" }],
    anchors,
    choices,
    CFG,
  );
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 4);
});

test("placementsToOverlays: 画像素材は span いっぱい表示・volume は付けない", () => {
  const anchors = [anchor(1, 0, 10)];
  const choices = [imageChoice(1, "materials/a.png")];
  const out = placementsToOverlays(
    [{ anchorId: 1, materialId: 1, reason: "" }],
    anchors,
    choices,
    CFG,
  );
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 10);
  assert.equal("volume" in out[0], false);
});

test("placementsToOverlays: 動画素材には既定 volume が付く", () => {
  const anchors = [anchor(1, 0, 10)];
  const choices = [videoChoice(1, "materials/a.mp4", 20)];
  const out = placementsToOverlays(
    [{ anchorId: 1, materialId: 1, reason: "" }],
    anchors,
    choices,
    CFG,
  );
  assert.equal(out[0].volume, 0);
});

test("placementsToOverlays: 同一 anchor への重複配置は先着優先で間引かれる", () => {
  const anchors = [anchor(1, 0, 10)];
  const choices = [videoChoice(1, "materials/a.mp4", 20), videoChoice(2, "materials/b.mp4", 20)];
  const out = placementsToOverlays(
    [
      { anchorId: 1, materialId: 1, reason: "first" },
      { anchorId: 1, materialId: 2, reason: "second" },
    ],
    anchors,
    choices,
    CFG,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "materials/a.mp4");
});

test("placementsToOverlays: maxPlacements で打ち切られる", () => {
  const anchors = [anchor(1, 0, 5), anchor(2, 10, 15), anchor(3, 20, 25)];
  const choices = [videoChoice(1, "materials/a.mp4", 20)];
  const out = placementsToOverlays(
    [
      { anchorId: 1, materialId: 1, reason: "" },
      { anchorId: 2, materialId: 1, reason: "" },
      { anchorId: 3, materialId: 1, reason: "" },
    ],
    anchors,
    choices,
    { ...CFG, maxPlacements: 2 },
  );
  assert.equal(out.length, 2);
});

test("placementsToOverlays: defaultRect を付けると PIP になる", () => {
  const anchors = [anchor(1, 0, 10)];
  const choices = [videoChoice(1, "materials/a.mp4", 20)];
  const out = placementsToOverlays(
    [{ anchorId: 1, materialId: 1, reason: "" }],
    anchors,
    choices,
    { ...CFG, defaultRect: { x: 640, y: 40, w: 600, h: 338 } },
  );
  assert.deepEqual(out[0].rect, { x: 640, y: 40, w: 600, h: 338 });
});

/* ---------------- parsePlacementsResponse(応答パーサの堅牢性) ---------------- */

test("parsePlacementsResponse: 正例(素の JSON)", () => {
  const raw = `{ "placements": [ { "anchorId": 1, "materialId": 2, "reason": "一致" } ] }`;
  assert.deepEqual(parsePlacementsResponse(raw), {
    placements: [{ anchorId: 1, materialId: 2, reason: "一致" }],
  });
});

test("parsePlacementsResponse: コードフェンス・前後の説明文を許容", () => {
  const raw =
    "選びました。\n```json\n" +
    `{ "placements": [ { "anchorId": 1, "materialId": 1, "reason": "r" } ] }` +
    "\n```\n以上です。";
  assert.deepEqual(parsePlacementsResponse(raw), {
    placements: [{ anchorId: 1, materialId: 1, reason: "r" }],
  });
});

test("parsePlacementsResponse: placements 欠如→空配列", () => {
  assert.deepEqual(parsePlacementsResponse("{}"), { placements: [] });
  assert.deepEqual(parsePlacementsResponse(`{ "placements": "nope" }`), { placements: [] });
});

test("parsePlacementsResponse: anchorId・materialId が数値でない要素を落とす", () => {
  const raw = `{
    "placements": [
      { "anchorId": 1, "materialId": "2", "reason": "bad" },
      { "anchorId": "1", "materialId": 2, "reason": "bad" },
      { "anchorId": 3, "materialId": 4, "reason": "ok" }
    ]
  }`;
  assert.deepEqual(parsePlacementsResponse(raw), {
    placements: [{ anchorId: 3, materialId: 4, reason: "ok" }],
  });
});

test("parsePlacementsResponse: JSON が無ければ投げる", () => {
  assert.throws(() => parsePlacementsResponse("JSON はありません"), /JSON が見つかりません/);
});

test("parsePlacementsResponse: 壊れた JSON は投げる", () => {
  assert.throws(() => parsePlacementsResponse(`{ "placements": [ { ] }`), /パースに失敗/);
});
