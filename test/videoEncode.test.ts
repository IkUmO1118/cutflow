// lib/videoEncode.ts — proxy.ts / preview.ts が共有するビデオエンコード引数。
// GOP 既定1秒(-g 30)と +faststart はエンコーダに依らず必ず付くこと、
// videoEncoder 省略時は videotoolbox(新既定)、"libx264" 指定で
// 従来の ultrafast+CRF に戻ること、gopFrames 指定(プロキシの
// カット境界シーク用の短 GOP)が -g に反映されることを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROXY_GOP_FRAMES, proxyGopFrames, videoEncodeArgs } from "../src/lib/videoEncode.ts";
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

/* ------------------------------------------------------------------ */
/* M1: preview.proxyIntra(オールイントラ proxy)。
 * §docs/plans/2026-07-28-engine-m1-media-metrics-design.md Phase 1 */

test("videoEncodeArgs: gopFrames:1(オールイントラ)は libx264 に -x264-params を追加する", () => {
  const args = videoEncodeArgs(
    { preview: { width: 1280, videoEncoder: "libx264" } } as Config,
    { gopFrames: 1 },
  );
  assert.equal(args[args.indexOf("-g") + 1], "1");
  assert.ok(args.includes("-x264-params"));
  assert.equal(args[args.indexOf("-x264-params") + 1], "keyint=1:min-keyint=1:scenecut=0");
});

test("videoEncodeArgs: gopFrames:1 は videotoolbox には -x264-params を追加しない(-g 1 のみ)", () => {
  const args = videoEncodeArgs(
    { preview: { width: 1280, videoEncoder: "videotoolbox" } } as Config,
    { gopFrames: 1 },
  );
  assert.equal(args[args.indexOf("-g") + 1], "1");
  assert.ok(!args.includes("-x264-params"));
});

test("proxyGopFrames: proxyIntra:true は 1、false/未設定は PROXY_GOP_FRAMES", () => {
  assert.equal(
    proxyGopFrames({ preview: { width: 1280, proxyIntra: true } } as Config),
    1,
  );
  assert.equal(
    proxyGopFrames({ preview: { width: 1280, proxyIntra: false } } as Config),
    PROXY_GOP_FRAMES,
  );
  assert.equal(
    proxyGopFrames({ preview: { width: 1280 } } as Config),
    PROXY_GOP_FRAMES,
  );
});
