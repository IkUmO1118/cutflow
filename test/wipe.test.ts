import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { wipeProgressAt } from "../src/lib/wipe.ts";

test("wipeProgressAt: 区間外は通常ワイプ、中央は全画面", () => {
  const spans = [{ start: 1, end: 5 }];
  strictEqual(wipeProgressAt(0, spans, 0.3), 0);
  strictEqual(wipeProgressAt(2, spans, 0.3), 1);
  strictEqual(wipeProgressAt(5, spans, 0.3), 0);
});

test("wipeProgressAt: 入りと戻りの遷移秒を独立指定できる", () => {
  const spans = [{
    start: 0,
    end: 10,
    transitionInSec: 2,
    transitionOutSec: 0,
  }];
  strictEqual(wipeProgressAt(1, spans, 0.3), 0.5);
  strictEqual(wipeProgressAt(9.99, spans, 0.3), 1);
});

test("wipeProgressAt: 旧 transitionSec は両方向へ適用される", () => {
  const spans = [{ start: 0, end: 10, transitionSec: 2 }];
  strictEqual(wipeProgressAt(1, spans, 0.3), 0.5);
  strictEqual(wipeProgressAt(9, spans, 0.3), 0.5);
});

test("wipeProgressAt: 短い区間では各遷移を半分へ縮める", () => {
  const spans = [{
    start: 0,
    end: 1,
    transitionInSec: 5,
    transitionOutSec: 3,
  }];
  strictEqual(wipeProgressAt(0.5, spans, 0.3), 1);
});
