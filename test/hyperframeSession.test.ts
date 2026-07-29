import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fatalHyperframeMessage,
  seekTimeMs,
  throwIfFatalHyperframeFailure,
} from "../src/lib/hyperframeSession.ts";

test("seekTimeMs: 秒を ms に変換する", () => {
  assert.equal(seekTimeMs(0), 0);
  assert.equal(seekTimeMs(1.5), 1500);
  assert.equal(seekTimeMs(1 / 30), 1000 / 30);
});

test("fatalHyperframeMessage: fatal:true だけを結合し、fatal:false は無視する", () => {
  assert.equal(
    fatalHyperframeMessage([
      { message: "warn only", fatal: false },
      { message: "first", fatal: true },
      { message: "second", fatal: true },
    ]),
    "first; second",
  );
  assert.equal(fatalHyperframeMessage([{ message: "warn only", fatal: false }]), null);
  assert.equal(fatalHyperframeMessage([]), null);
});

test("throwIfFatalHyperframeFailure: fatal が1件でもあれば Remotion 互換メッセージで throw", () => {
  assert.throws(
    () => throwIfFatalHyperframeFailure([{ message: "boom", fatal: true }]),
    /HyperFrame card failed \/ カードが失敗しました: boom/,
  );
  assert.doesNotThrow(() => throwIfFatalHyperframeFailure([{ message: "soft", fatal: false }]));
});
