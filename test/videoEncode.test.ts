// lib/videoEncode.ts — proxy.ts / preview.ts が共有するビデオエンコード引数。
// GOP 1秒(-g 30)と +faststart はエンコーダに依らず必ず付くこと、
// videoEncoder 省略時は videotoolbox(新既定)、"libx264" 指定で
// 従来の ultrafast+CRF に戻ることを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { videoEncodeArgs } from "../src/lib/videoEncode.ts";
import type { Config } from "../src/lib/config.ts";

test("videoEncodeArgs: 省略時は videotoolbox(新既定)", () => {
  const args = videoEncodeArgs({ preview: { width: 1280 } } as Config);
  assert.deepEqual(args, [
    "-c:v", "h264_videotoolbox", "-q:v", "50",
    "-g", "30", "-movflags", "+faststart",
  ]);
});

test("videoEncodeArgs: libx264 指定で従来の ultrafast+CRF に戻る", () => {
  const args = videoEncodeArgs({
    preview: { width: 1280, videoEncoder: "libx264" },
  } as Config);
  assert.deepEqual(args, [
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-g", "30", "-movflags", "+faststart",
  ]);
});

test("videoEncodeArgs: 両エンコーダとも -g 30 / +faststart を含む", () => {
  for (const encoder of [undefined, "libx264", "videotoolbox"] as const) {
    const args = videoEncodeArgs({ preview: { width: 1280, videoEncoder: encoder } } as Config);
    assert.ok(args.includes("-g"));
    assert.equal(args[args.indexOf("-g") + 1], "30");
    assert.ok(args.includes("+faststart"));
  }
});
