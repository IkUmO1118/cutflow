// lib/videoEncode.ts — proxy.ts / preview.ts が共有するビデオエンコード引数。
// GOP 既定1秒(-g 30)と +faststart はエンコーダに依らず必ず付くこと、
// videoEncoder 省略時は videotoolbox(新既定)、"libx264" 指定で
// 従来の ultrafast+CRF に戻ること、gopFrames 指定(プロキシの
// カット境界シーク用の短 GOP)が -g に反映されることを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROXY_GOP_FRAMES, videoEncodeArgs } from "../src/lib/videoEncode.ts";
import type { Config } from "../src/lib/config.ts";

test("videoEncodeArgs: 省略時は videotoolbox(新既定)", () => {
  const args = videoEncodeArgs({ preview: { width: 1280 } } as Config);
  assert.deepEqual(args, [
    "-c:v", "h264_videotoolbox", "-q:v", "65",
    "-g", "30", "-movflags", "+faststart",
  ]);
});

test("videoEncodeArgs: libx264 指定で従来の ultrafast+CRF に戻る", () => {
  const args = videoEncodeArgs({
    preview: { width: 1280, videoEncoder: "libx264" },
  } as Config);
  assert.deepEqual(args, [
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24",
    "-g", "30", "-movflags", "+faststart",
  ]);
});

test("videoEncodeArgs: 両エンコーダとも既定 -g 30 / +faststart を含む", () => {
  for (const encoder of [undefined, "libx264", "videotoolbox"] as const) {
    const args = videoEncodeArgs({ preview: { width: 1280, videoEncoder: encoder } } as Config);
    assert.ok(args.includes("-g"));
    assert.equal(args[args.indexOf("-g") + 1], "30");
    assert.ok(args.includes("+faststart"));
  }
});

test("videoEncodeArgs: gopFrames 指定が -g に反映される(プロキシの短 GOP)", () => {
  for (const encoder of ["libx264", "videotoolbox"] as const) {
    const args = videoEncodeArgs(
      { preview: { width: 1280, videoEncoder: encoder } } as Config,
      { gopFrames: PROXY_GOP_FRAMES },
    );
    assert.equal(args[args.indexOf("-g") + 1], String(PROXY_GOP_FRAMES));
  }
});
