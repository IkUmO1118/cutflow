// src/lib/effectAnchors.ts(E1+E2 の純ロジック)+ 応答パーサの堅牢性を固定する。
// §docs/plans/2026-07-11-e1-e2-effect-anchor-candidates-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEffectAnchors,
  decisionsToOverlays,
  limitNoneDecisions,
} from "../src/lib/effectAnchors.ts";
import type {
  EffectAnchor,
  EffectDecision,
  EffectOverlayCfg,
  EffectPlacementCfg,
  MotionLike,
  OcrSidecar,
} from "../src/lib/effectAnchors.ts";
import { parseDecisionsResponse } from "../src/stages/planEffects.ts";
import type { CutPlan, Overlays, Transcript } from "../src/types.ts";

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

const ACFG: EffectPlacementCfg = {
  maxDecisions: 8,
  anchorWindowSec: 2,
  minSceneScore: 0.5,
  minOcrBoxAreaPx: 100,
  minZoomRect: { w: 100, h: 100 },
  defaultBlurStrength: 0.5,
};

/* ---------------- buildEffectAnchors: OCR ---------------- */

test("buildEffectAnchors: OCR box が小さすぎる行は除外(minOcrBoxAreaPx)", () => {
  const cp = cutplan([{ start: 0, end: 20, action: "keep" }]);
  const t = transcript([]);
  const ocr: OcrSidecar[] = [
    {
      sourceSec: 5,
      lines: [
        { text: "small", box: { x: 0, y: 0, w: 5, h: 5 } }, // area=25 < 100
        { text: "big", box: { x: 10, y: 10, w: 50, h: 50 } }, // area=2500 >= 100
      ],
    },
  ];
  const anchors = buildEffectAnchors(cp, t, ocr, null, ACFG);
  const ocrAnchors = anchors.filter((a) => a.source === "ocr");
  assert.equal(ocrAnchors.length, 1);
  assert.equal(ocrAnchors[0].text, "big");
  assert.deepEqual(ocrAnchors[0].rect, { x: 10, y: 10, w: 50, h: 50 });
});

test("buildEffectAnchors: OCR アンカーは cut span からは作らない", () => {
  const cp = cutplan([
    { start: 0, end: 10, action: "keep" },
    { start: 10, end: 20, action: "cut" },
    { start: 20, end: 30, action: "keep" },
  ]);
  const t = transcript([]);
  const ocr: OcrSidecar[] = [
    { sourceSec: 15, lines: [{ text: "x", box: { x: 0, y: 0, w: 50, h: 50 } }] }, // cut span
  ];
  const anchors = buildEffectAnchors(cp, t, ocr, null, ACFG);
  assert.equal(anchors.filter((a) => a.source === "ocr").length, 0);
});

/* ---------------- buildEffectAnchors: motion ---------------- */

test("buildEffectAnchors: sceneScore が下限以下の motion サンプルは除外", () => {
  const cp = cutplan([{ start: 0, end: 20, action: "keep" }]);
  const t = transcript([]);
  const motion: MotionLike = {
    motion: [
      { outSec: 5, sourceSec: 5, sceneScore: 0.3 }, // <= 0.5 → 除外
      { outSec: 12, sourceSec: 12, sceneScore: 0.9 }, // > 0.5 → 採用
    ],
    frozen: [],
  };
  const anchors = buildEffectAnchors(cp, t, [], motion, ACFG);
  const motionAnchors = anchors.filter((a) => a.source === "motion");
  assert.equal(motionAnchors.length, 1);
  assert.ok(motionAnchors[0].start <= 12 && motionAnchors[0].end >= 12);
});

test("buildEffectAnchors: motion アンカーは rect を持たない", () => {
  const cp = cutplan([{ start: 0, end: 20, action: "keep" }]);
  const t = transcript([]);
  const motion: MotionLike = { motion: [{ outSec: 5, sourceSec: 5, sceneScore: 0.9 }], frozen: [] };
  const anchors = buildEffectAnchors(cp, t, [], motion, ACFG);
  const motionAnchors = anchors.filter((a) => a.source === "motion");
  assert.equal(motionAnchors.length, 1);
  assert.equal(motionAnchors[0].rect, undefined);
});

test("buildEffectAnchors: motion アンカーも cut span からは作らない", () => {
  const cp = cutplan([
    { start: 0, end: 10, action: "keep" },
    { start: 10, end: 20, action: "cut" },
    { start: 20, end: 30, action: "keep" },
  ]);
  const t = transcript([]);
  const motion: MotionLike = { motion: [{ outSec: 15, sourceSec: 15, sceneScore: 0.9 }], frozen: [] };
  const anchors = buildEffectAnchors(cp, t, [], motion, ACFG);
  assert.equal(anchors.filter((a) => a.source === "motion").length, 0);
});

test("buildEffectAnchors: 重なる motion ウィンドウはマージして1アンカーにする", () => {
  const cp = cutplan([{ start: 0, end: 100, action: "keep" }]);
  const t = transcript([]);
  // anchorWindowSec=2(half=1): 10→[9,11], 10.5→[9.5,11.5] は重なる → マージ
  const motion: MotionLike = {
    motion: [
      { outSec: 10, sourceSec: 10, sceneScore: 0.9 },
      { outSec: 10.5, sourceSec: 10.5, sceneScore: 0.6 },
      { outSec: 50, sourceSec: 50, sceneScore: 0.9 }, // 離れているので別アンカー
    ],
    frozen: [],
  };
  const anchors = buildEffectAnchors(cp, t, [], motion, ACFG);
  const motionAnchors = anchors.filter((a) => a.source === "motion").sort((a, b) => a.start - b.start);
  assert.equal(motionAnchors.length, 2);
  assert.equal(motionAnchors[0].start, 9);
  assert.equal(motionAnchors[0].end, 11.5);
});

test("buildEffectAnchors: frozen(静止)区間は timeline で元収録の秒へ変換される", () => {
  // 単一 keep [50,150] → output 0..100 の1:1写像(offset +50)
  const cp = cutplan([{ start: 50, end: 150, action: "keep" }]);
  const t = transcript([]);
  const motion: MotionLike = {
    motion: [],
    frozen: [{ outSec: 10, endOutSec: 20, lenSec: 10 }],
  };
  const anchors = buildEffectAnchors(cp, t, [], motion, ACFG);
  const motionAnchors = anchors.filter((a) => a.source === "motion");
  assert.equal(motionAnchors.length, 1);
  assert.equal(motionAnchors[0].start, 60);
  assert.equal(motionAnchors[0].end, 70);
  assert.match(motionAnchors[0].text, /静止/);
});

/* ---------------- buildEffectAnchors: speech / id / rect ---------------- */

test("buildEffectAnchors: speech アンカーは十分な尺の keep span ごとに1件(rect無し)", () => {
  const cp = cutplan([
    { start: 0, end: 1, action: "keep" }, // 1秒 < anchorWindowSec(2) → 除外
    { start: 10, end: 30, action: "keep" },
  ]);
  const t = transcript([{ start: 10, end: 30, text: "hello world" }]);
  const anchors = buildEffectAnchors(cp, t, [], null, ACFG);
  const speechAnchors = anchors.filter((a) => a.source === "speech");
  assert.equal(speechAnchors.length, 1);
  assert.equal(speechAnchors[0].start, 10);
  assert.equal(speechAnchors[0].end, 30);
  assert.equal(speechAnchors[0].rect, undefined);
  assert.equal(speechAnchors[0].text, "hello world");
});

test("buildEffectAnchors: id は時系列順の1始まり連番", () => {
  const cp = cutplan([{ start: 0, end: 100, action: "keep" }]);
  const t = transcript([{ start: 0, end: 100, text: "speech" }]);
  const ocr: OcrSidecar[] = [{ sourceSec: 5, lines: [{ text: "a", box: { x: 0, y: 0, w: 50, h: 50 } }] }];
  const motion: MotionLike = { motion: [{ outSec: 20, sourceSec: 20, sceneScore: 0.9 }], frozen: [] };
  const anchors = buildEffectAnchors(cp, t, ocr, motion, ACFG);
  assert.deepEqual(anchors.map((a) => a.id), anchors.map((_, i) => i + 1));
  // 時系列順であること
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(anchors[i].start >= anchors[i - 1].start);
  }
});

test("buildEffectAnchors: OCR/motion 知覚が無ければ speech アンカーだけになる", () => {
  const cp = cutplan([{ start: 0, end: 10, action: "keep" }]);
  const t = transcript([{ start: 0, end: 10, text: "only speech" }]);
  const anchors = buildEffectAnchors(cp, t, [], null, ACFG);
  assert.deepEqual(anchors.map((a) => a.source), ["speech"]);
});

/* ---------------- decisionsToOverlays ---------------- */

const ZCFG: EffectOverlayCfg = {
  ...ACFG,
  minZoomRect: { w: 200, h: 200 },
  outW: 1920,
  outH: 1080,
};

function anchor(id: number, start: number, end: number, rect?: EffectAnchor["rect"]): EffectAnchor {
  return { id, start, end, source: "ocr", text: "", ...(rect ? { rect } : {}) };
}

test("decisionsToOverlays: 存在しない anchorId を捨てる", () => {
  const anchors = [anchor(1, 0, 10, { x: 100, y: 100, w: 300, h: 300 })];
  const out = decisionsToOverlays(
    [
      { anchorId: 99, effect: "zoom", reason: "" },
      { anchorId: 1, effect: "zoom", reason: "" },
    ],
    anchors,
    ZCFG,
  );
  assert.equal(out.zooms?.length, 1);
});

test("decisionsToOverlays: rect の無いアンカーへの zoom/blur/annotation を捨てる", () => {
  const anchors = [anchor(1, 0, 10)]; // rect無し
  const out = decisionsToOverlays(
    [
      { anchorId: 1, effect: "zoom", reason: "" },
      { anchorId: 1, effect: "blur", reason: "" },
      { anchorId: 1, effect: "annotation", reason: "" },
    ],
    anchors,
    ZCFG,
  );
  assert.equal(out.zooms, undefined);
  assert.equal(out.blurs, undefined);
  assert.equal(out.annotations, undefined);
});

test("decisionsToOverlays: effect='none' は何も生成しない", () => {
  const anchors = [anchor(1, 0, 10, { x: 0, y: 0, w: 300, h: 300 })];
  const out = decisionsToOverlays([{ anchorId: 1, effect: "none", reason: "" }], anchors, ZCFG);
  assert.deepEqual(out, {});
});

test("decisionsToOverlays: 時間衝突する zoom は先着優先で間引く", () => {
  const anchors = [
    anchor(1, 0, 10, { x: 0, y: 0, w: 300, h: 300 }),
    anchor(2, 5, 15, { x: 100, y: 100, w: 300, h: 300 }), // #1 と時間重複
    anchor(3, 20, 30, { x: 200, y: 200, w: 300, h: 300 }), // 重ならない
  ];
  const out = decisionsToOverlays(
    [
      { anchorId: 1, effect: "zoom", reason: "" },
      { anchorId: 2, effect: "zoom", reason: "" },
      { anchorId: 3, effect: "zoom", reason: "" },
    ],
    anchors,
    ZCFG,
  );
  assert.equal(out.zooms?.length, 2);
  assert.deepEqual(
    out.zooms?.map((z) => [z.start, z.end]),
    [
      [0, 10],
      [20, 30],
    ],
  );
});

test("decisionsToOverlays: zoom rect が minZoomRect 未満なら中心保存で拡大", () => {
  const anchors = [anchor(1, 0, 10, { x: 100, y: 100, w: 50, h: 50 })]; // 中心(125,125)
  const out = decisionsToOverlays([{ anchorId: 1, effect: "zoom", reason: "" }], anchors, ZCFG);
  const rect = out.zooms?.[0].rect;
  assert.ok(rect);
  assert.equal(rect!.w, 200);
  assert.equal(rect!.h, 200);
  assert.equal(rect!.x, 25); // 125 - 200/2
  assert.equal(rect!.y, 25);
});

test("decisionsToOverlays: blur/box の rect が出力解像度外なら clamp する", () => {
  const anchors = [anchor(1, 0, 10, { x: 1800, y: 1000, w: 300, h: 200 })]; // 右下へはみ出す
  const out = decisionsToOverlays([{ anchorId: 1, effect: "blur", reason: "" }], anchors, ZCFG);
  const rect = out.blurs?.[0].rect;
  assert.ok(rect);
  assert.ok(rect!.x + rect!.w <= ZCFG.outW);
  assert.ok(rect!.y + rect!.h <= ZCFG.outH);
  assert.ok(rect!.x >= 0 && rect!.y >= 0);
});

test("decisionsToOverlays: blur の既定 strength", () => {
  const anchors = [anchor(1, 0, 10, { x: 0, y: 0, w: 300, h: 300 })];
  const out = decisionsToOverlays([{ anchorId: 1, effect: "blur", reason: "" }], anchors, ZCFG);
  assert.equal(out.blurs?.[0].strength, ZCFG.defaultBlurStrength);
  assert.equal(out.blurs?.[0].strength, 0.5);
});

test("decisionsToOverlays: annotation は type='box' のみを生成する", () => {
  const anchors = [anchor(1, 0, 10, { x: 0, y: 0, w: 300, h: 300 })];
  const out = decisionsToOverlays([{ anchorId: 1, effect: "annotation", reason: "" }], anchors, ZCFG);
  assert.equal(out.annotations?.length, 1);
  assert.equal(out.annotations?.[0].type, "box");
});

test("decisionsToOverlays: 非noneの effectReasonId を各 overlays.reasonId へsticky copy", () => {
  const anchors = [
    anchor(1, 0, 5, { x: 0, y: 0, w: 300, h: 300 }),
    anchor(2, 10, 15, { x: 0, y: 0, w: 300, h: 300 }),
    anchor(3, 20, 25, { x: 0, y: 0, w: 300, h: 300 }),
  ];
  const out = decisionsToOverlays([
    { anchorId: 1, effect: "zoom", effectReasonId: "tiny-target", reason: "" },
    { anchorId: 2, effect: "blur", effectReasonId: "secret-exposure", reason: "" },
    { anchorId: 3, effect: "annotation", effectReasonId: "attention-scatter", reason: "" },
  ], anchors, ZCFG);
  assert.equal(out.zooms?.[0].reasonId, "tiny-target");
  assert.equal(out.blurs?.[0].reasonId, "secret-exposure");
  assert.equal(out.annotations?.[0].reasonId, "attention-scatter");
});

test("limitNoneDecisions: disabledは参照同一・無制限", () => {
  const decisions = Array.from({ length: 20 }, (_, i): EffectDecision => ({
    anchorId: i + 1, effect: "none", effectReasonId: "already-legible", reason: "",
  }));
  assert.equal(limitNoneDecisions(decisions, 20, false), decisions);
});

test("limitNoneDecisions: 小規模はnone 12件、非noneは別予算で全件保持", () => {
  const none = Array.from({ length: 20 }, (_, i): EffectDecision => ({
    anchorId: i + 1, effect: "none", effectReasonId: "already-legible", reason: "",
  }));
  const decisions: EffectDecision[] = [
    ...none.slice(0, 5),
    { anchorId: 100, effect: "zoom", effectReasonId: "tiny-target", reason: "" },
    ...none.slice(5),
    { anchorId: 101, effect: "blur", effectReasonId: "secret-exposure", reason: "" },
  ];
  const limited = limitNoneDecisions(decisions, 20, true);
  assert.equal(limited.filter((d) => d.effect === "none").length, 12);
  assert.equal(limited.filter((d) => d.effect !== "none").length, 2);
});

test("limitNoneDecisions: 12アンカー未満ではアンカー総数を超えて保持しない", () => {
  const decisions = Array.from({ length: 20 }, (_, i): EffectDecision => ({
    anchorId: (i % 5) + 1, effect: "none", effectReasonId: "already-legible", reason: "",
  }));
  assert.equal(limitNoneDecisions(decisions, 5, true).length, 5);
});

test("limitNoneDecisions: 大規模125アンカーはceil(12.5)=13件", () => {
  const decisions = Array.from({ length: 30 }, (_, i): EffectDecision => ({
    anchorId: i + 1, effect: "none", effectReasonId: "concept-talk", reason: "",
  }));
  assert.equal(limitNoneDecisions(decisions, 125, true).length, 13);
});

test("decisionsToOverlays: maxDecisions で打ち切る", () => {
  const anchors = [
    anchor(1, 0, 5, { x: 0, y: 0, w: 300, h: 300 }),
    anchor(2, 10, 15, { x: 0, y: 0, w: 300, h: 300 }),
    anchor(3, 20, 25, { x: 0, y: 0, w: 300, h: 300 }),
  ];
  const decisions: EffectDecision[] = [
    { anchorId: 1, effect: "zoom", reason: "" },
    { anchorId: 2, effect: "blur", reason: "" },
    { anchorId: 3, effect: "annotation", reason: "" },
  ];
  const out = decisionsToOverlays(decisions, anchors, { ...ZCFG, maxDecisions: 2 });
  const total = (out.zooms?.length ?? 0) + (out.blurs?.length ?? 0) + (out.annotations?.length ?? 0);
  assert.equal(total, 2);
});

test("decisionsToOverlays: 既存 overlays の他フィールドを保持したままマージできる", () => {
  const existing: Overlays = {
    overlays: [{ start: 0, end: 5, file: "materials/a.mp4", fit: "contain" }],
    inserts: [],
    captionTracks: [{ track: 1 }],
    zooms: [{ start: 0, end: 1, rect: { x: 0, y: 0, w: 100, h: 100 } }], // 上書きされるはず
  };
  const anchors = [anchor(1, 10, 20, { x: 0, y: 0, w: 300, h: 300 })];
  const generated = decisionsToOverlays([{ anchorId: 1, effect: "blur", reason: "" }], anchors, ZCFG);
  const merged: Overlays = { ...existing, zooms: generated.zooms, blurs: generated.blurs, annotations: generated.annotations };
  assert.deepEqual(merged.overlays, existing.overlays);
  assert.deepEqual(merged.inserts, existing.inserts);
  assert.deepEqual(merged.captionTracks, existing.captionTracks);
  assert.equal(merged.zooms, undefined); // 新生成が0件なので消える
  assert.equal(merged.blurs?.length, 1);
});

/* ---------------- parseDecisionsResponse(応答パーサの堅牢性) ---------------- */

test("parseDecisionsResponse: 正例(素の JSON)", () => {
  const raw = `{ "decisions": [ { "anchorId": 1, "effect": "zoom", "reason": "見せ場" } ] }`;
  assert.deepEqual(parseDecisionsResponse(raw), {
    decisions: [{ anchorId: 1, effect: "zoom", reason: "見せ場" }],
  });
});

test("parseDecisionsResponse: コードフェンス・前後の説明文を許容", () => {
  const raw =
    "選びました。\n```json\n" +
    `{ "decisions": [ { "anchorId": 1, "effect": "none", "reason": "r" } ] }` +
    "\n```\n以上です。";
  assert.deepEqual(parseDecisionsResponse(raw), {
    decisions: [{ anchorId: 1, effect: "none", reason: "r" }],
  });
});

test("parseDecisionsResponse: effectReasonId は文字列のときだけstickyに保持", () => {
  const raw = `{ "decisions": [
    { "anchorId": 1, "effect": "zoom", "effectReasonId": "tiny-target", "reason": "r" },
    { "anchorId": 2, "effect": "none", "effectReasonId": 42, "reason": "r" }
  ] }`;
  assert.deepEqual(parseDecisionsResponse(raw), {
    decisions: [
      { anchorId: 1, effect: "zoom", effectReasonId: "tiny-target", reason: "r" },
      { anchorId: 2, effect: "none", reason: "r" },
    ],
  });
});

test("parseDecisionsResponse: decisions 欠如→空配列", () => {
  assert.deepEqual(parseDecisionsResponse("{}"), { decisions: [] });
  assert.deepEqual(parseDecisionsResponse(`{ "decisions": "nope" }`), { decisions: [] });
});

test("parseDecisionsResponse: anchorId が数値でない要素を落とす", () => {
  const raw = `{
    "decisions": [
      { "anchorId": "1", "effect": "zoom", "reason": "bad" },
      { "anchorId": 2, "effect": "zoom", "reason": "ok" }
    ]
  }`;
  assert.deepEqual(parseDecisionsResponse(raw), {
    decisions: [{ anchorId: 2, effect: "zoom", reason: "ok" }],
  });
});

test("parseDecisionsResponse: effect が enum 外の要素を落とす", () => {
  const raw = `{
    "decisions": [
      { "anchorId": 1, "effect": "arrow", "reason": "bad" },
      { "anchorId": 2, "effect": "blur", "reason": "ok" }
    ]
  }`;
  assert.deepEqual(parseDecisionsResponse(raw), {
    decisions: [{ anchorId: 2, effect: "blur", reason: "ok" }],
  });
});

test("parseDecisionsResponse: JSON が無ければ投げる", () => {
  assert.throws(() => parseDecisionsResponse("JSON はありません"), /JSON が見つかりません/);
});

test("parseDecisionsResponse: 壊れた JSON は投げる", () => {
  assert.throws(() => parseDecisionsResponse(`{ "decisions": [ { ] }`), /パースに失敗/);
});
