// test/openscreenZoomSpring.test.ts — 忠実性の担保(P1)。OpenScreen v1.7.0
// `videoPlayback/zoomSpring.test.ts` の5ケースをそのまま移植して、
// zoomSpring(motion の spring() generator を使う軸ごとの交差スナップ)の
// 逐語移植を数値一致(挙動一致)で固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createZoomSpringState,
  resetZoomSpring,
  stepZoomSpring,
} from "../src/lib/vendor/openscreen/zoomSpring.ts";

const DT = 1000 / 60;

test("zoom spring chase: resetZoomSpring snaps every axis exactly to the target", () => {
  const state = createZoomSpringState();
  resetZoomSpring(state, { scale: 1.8, x: -120, y: 40 });
  assert.deepEqual(stepZoomSpring(state, { scale: 1.8, x: -120, y: 40 }, DT), {
    scale: 1.8,
    x: -120,
    y: 40,
  });
});

test("zoom spring chase: eases into a jumped target instead of snapping (velocity continuity)", () => {
  const state = createZoomSpringState();
  resetZoomSpring(state, { scale: 1, x: 0, y: 0 });
  // Target jumps from 1 to 2; a single step must NOT teleport there.
  const first = stepZoomSpring(state, { scale: 2, x: 0, y: 0 }, DT);
  assert.ok(first.scale > 1);
  assert.ok(first.scale < 2);
});

test("zoom spring chase: converges to a static target without overshooting it", () => {
  const state = createZoomSpringState();
  resetZoomSpring(state, { scale: 1, x: 0, y: 0 });
  const target = { scale: 2.2, x: 0, y: 0 };
  let maxScale = 1;
  let last = 1;
  for (let i = 0; i < 200; i++) {
    last = stepZoomSpring(state, target, DT).scale;
    maxScale = Math.max(maxScale, last);
  }
  assert.ok(Math.abs(last - 2.2) < 0.5 * 10 ** -2); // settled onto the target
  assert.ok(maxScale <= 2.2 + 1e-6); // never overshot past it
});

test("zoom spring chase: does not overshoot when the target reverses mid-motion", () => {
  const state = createZoomSpringState();
  resetZoomSpring(state, { scale: 1, x: 0, y: 0 });
  // Build upward momentum chasing a high target...
  for (let i = 0; i < 8; i++) stepZoomSpring(state, { scale: 3, x: 0, y: 0 }, DT);
  // ...then reverse the target below the current value; momentum must not carry it past.
  const reverseTarget = { scale: 1.5, x: 0, y: 0 };
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 200; i++) {
    min = Math.min(min, stepZoomSpring(state, reverseTarget, DT).scale);
  }
  assert.ok(min >= 1.5 - 1e-6); // never dipped below the reversed target
});

test("zoom spring chase: steps each axis independently", () => {
  const state = createZoomSpringState();
  resetZoomSpring(state, { scale: 1, x: 0, y: 0 });
  const out = stepZoomSpring(state, { scale: 1, x: 100, y: 0 }, DT);
  assert.equal(out.scale, 1); // already at target → unchanged
  assert.ok(out.x > 0);
  assert.ok(out.x < 100);
  assert.equal(out.y, 0);
});
