import test from "node:test";
import assert from "node:assert/strict";
import { fmtTime, parseTimecode } from "../editor/client/timecode.ts";

test("parseTimecode inverts fmtTime to centisecond precision", () => {
  for (const t of [0, 0.5, 12.34, 59.5, 83.9, 123.45, 599.99]) {
    const back = parseTimecode(fmtTime(t));
    assert.ok(back !== null && Math.abs(back - t) <= 0.005, `t=${t} -> ${fmtTime(t)} -> ${back}`);
  }
});
test("parseTimecode accepts bare seconds and rejects garbage", () => {
  assert.equal(parseTimecode("90"), 90);
  assert.equal(parseTimecode("90.5"), 90.5);
  for (const bad of ["", "ab", "1:2:3", ":", "-5", "1:xx"]) assert.equal(parseTimecode(bad), null);
});
