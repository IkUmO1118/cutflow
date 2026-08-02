import { test } from "node:test";
import assert from "node:assert/strict";
import { stillsProxyArgs } from "../src/stages/proxy.ts";

function args(): string[] {
  return stillsProxyArgs({
    input: "in.m4a",
    audioParts: ["[0:a]anull[a0]"],
    loudnorm: "anull",
    output: "proxy.m4a",
  });
}

test("stillsProxyArgs: +faststart を必ず含む", () => {
  const a = args();
  const i = a.indexOf("-movflags");
  assert.ok(i >= 0);
  assert.equal(a[i + 1], "+faststart");
});

test("stillsProxyArgs: 映像ストリームを map しない", () => {
  const a = args();
  assert.ok(!a.includes("[vout]"));
});
