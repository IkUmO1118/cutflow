// lib/fastRender.ts の純関数テスト(decideFastPath / buildSlowSegmentRemotionArgs /
// orderedFastJobs)。ffmpeg/Remotion を起動する runFastRender は対象外(coordinator が
// cold Before/After で実測する)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSlowSegmentRemotionArgs,
  decideFastPath,
  orderedFastJobs,
} from "../src/lib/fastRender.ts";
import { fastPlan } from "../src/lib/fastPlan.ts";
import { fastSegmentPath } from "../src/lib/fastSegment.ts";
import type { FastPlan } from "../src/lib/fastPlan.ts";
import type { Config } from "../src/lib/config.ts";
import type { RenderProps } from "../remotion/props.ts";

function mkProps(partial: Partial<RenderProps> & { durationSec?: number } = {}): RenderProps {
  return {
    videoFile: "cut.mp4",
    bgm: [],
    fps: 30,
    width: 1920,
    height: 1080,
    canvas: { w: 1920, h: 1080 },
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
    wipe: { widthPx: 480, marginPx: 32 },
    caption: { fontSizePx: 44 },
    captions: [{ start: 1, end: 3, text: "静的", track: 1 }],
    overlays: [],
    wipeFull: [],
    hideCaption: [],
    durationSec: 20,
    ...partial,
  };
}

function baseRenderCfg(overrides: Partial<Config["render"]> = {}): Config["render"] {
  return {
    wipeWidthPx: 480,
    wipeMarginPx: 32,
    captionFontSizePx: 44,
    chapterCardSec: 3,
    targetLufs: -14,
    bgm: { volumeDb: -14, fadeOutSec: 2 },
    ...overrides,
  };
}

function cfgWith(render: Partial<Config["render"]>): Config {
  return { render: baseRenderCfg(render) } as Config;
}

// ---- decideFastPath ----

test("decideFastPath: fastPath:false → 無効", () => {
  const decision = decideFastPath({ props: mkProps(), cfg: cfgWith({ fastPath: false }), composite: true });
  assert.deepEqual(decision, { activate: false, reason: "fastPath 無効" });
});

test("decideFastPath: fastPath:true, composite:false → 非composite経路", () => {
  const decision = decideFastPath({ props: mkProps(), cfg: cfgWith({ fastPath: true }), composite: false });
  assert.equal(decision.activate, false);
  assert.equal(!decision.activate && decision.reason, "非composite経路(cut.mp4 が出力解像度でない)");
});

test("decideFastPath: inserts があれば映像・音声ともに適格外", () => {
  const props = mkProps({ inserts: [{ start: 0, end: 5, file: "i.mp4", fit: "cover" }] });
  const decision = decideFastPath({ props, cfg: cfgWith({ fastPath: true }), composite: true });
  assert.deepEqual(decision, { activate: false, reason: "適格外: inserts" });
  const plan = fastPlan(props);
  assert.equal(plan.audioFastEligible, false);
  assert.ok(plan.audioFallback.some((reason) => reason.includes("挿入")));
});

test("decideFastPath: colorFilter(表現可能)は activate する(P5-3)", () => {
  const props = mkProps({ colorFilter: { brightness: 1.1 } });
  const decision = decideFastPath({ props, cfg: cfgWith({ fastPath: true }), composite: true });
  assert.equal(decision.activate, true);
});

test("decideFastPath: colorFilter(saturate>2.0776 で表現不能)は適格外", () => {
  const props = mkProps({ colorFilter: { saturate: 2.5 } });
  const decision = decideFastPath({ props, cfg: cfgWith({ fastPath: true }), composite: true });
  assert.equal(decision.activate, false);
  assert.ok(!decision.activate);
  if (!decision.activate) assert.ok(decision.reason.startsWith("適格外: colorFilter("));
});

test("decideFastPath: BGM があっても bgm-mix で activate", () => {
  const props = mkProps({ bgm: [{ file: "a.mp3", volumeDb: -18, start: 0, end: 20 }] });
  const decision = decideFastPath({ props, cfg: cfgWith({ fastPath: true }), composite: true });
  assert.equal(decision.activate, true);
  assert.ok(decision.activate);
  if (decision.activate) {
    assert.equal(decision.plan.audioMode, "bgm-mix");
    assert.equal(decision.plan.audioFastEligible, true);
  }
});

test("decideFastPath: 素材音声があれば音声適格外", () => {
  const props = mkProps({
    overlays: [{ start: 5, end: 10, file: "material.mp4", track: 1, fit: "contain", volume: 1 }],
  });
  const decision = decideFastPath({ props, cfg: cfgWith({ fastPath: true }), composite: true });
  assert.equal(decision.activate, false);
  const reason = !decision.activate ? decision.reason : "";
  assert.ok(reason.startsWith("音声適格外:"), reason);
  assert.ok(reason.includes("素材音声"), reason);
});

test("decideFastPath: 全編 zoom(coverage 0)は被覆率で非適用", () => {
  const props = mkProps({
    durationSec: 20,
    zooms: [{ start: 0, end: 20, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0 }],
  });
  const decision = decideFastPath({ props, cfg: cfgWith({ fastPath: true }), composite: true });
  assert.equal(decision.activate, false);
  const reason = !decision.activate ? decision.reason : "";
  assert.ok(reason.startsWith("被覆率"), reason);
});

test("decideFastPath: 全適格・被覆率が閾値以上なら activate", () => {
  const props = mkProps();
  const decision = decideFastPath({ props, cfg: cfgWith({ fastPath: true }), composite: true });
  assert.equal(decision.activate, true);
  const plan = fastPlan(props);
  assert.ok(decision.activate);
  if (decision.activate) {
    assert.equal(decision.plan.coverageRatio, plan.coverageRatio);
  }
});

test("decideFastPath: fastPathMinCoverage の上書きで activate が反転する", () => {
  const props = mkProps({
    durationSec: 30,
    zooms: [{ start: 9, end: 18, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0 }],
  });
  const plan = fastPlan(props);
  assert.ok(plan.coverageRatio > 0.5 && plan.coverageRatio < 0.9, `coverageRatio=${plan.coverageRatio}`);

  const low = decideFastPath({ props, cfg: cfgWith({ fastPath: true, fastPathMinCoverage: 0.5 }), composite: true });
  assert.equal(low.activate, true);

  const high = decideFastPath({ props, cfg: cfgWith({ fastPath: true, fastPathMinCoverage: 0.9 }), composite: true });
  assert.equal(high.activate, false);
});

// ---- buildSlowSegmentRemotionArgs ----

test("buildSlowSegmentRemotionArgs: --frames は半開区間→inclusive to-1", () => {
  const args = buildSlowSegmentRemotionArgs({
    propsPath: "/dir/render.props.json",
    publicDir: "/dir",
    outPath: "/dir/render.fast/segments/seg001.mp4",
    fromFrame: 1677,
    toFrame: 3518,
    hardwareAcceleration: "if-possible",
    resourceArgs: ["--concurrency", "4"],
  });
  assert.ok(args.includes("--frames=1677-3517"));
});

test("buildSlowSegmentRemotionArgs: 固定引数・resourceArgs を全て含む", () => {
  const propsPath = "/dir/render.props.json";
  const publicDir = "/dir";
  const outPath = "/dir/render.fast/segments/seg000.mp4";
  const hardwareAcceleration = "if-possible";
  const resourceArgs = ["--concurrency", "4", "--offthreadvideo-cache-size-in-bytes", "1000"];
  const args = buildSlowSegmentRemotionArgs({
    propsPath, publicDir, outPath, fromFrame: 0, toFrame: 90, hardwareAcceleration, resourceArgs,
  });
  assert.deepEqual(args.slice(0, 4), ["remotion", "render", "remotion/index.ts", "Main"]);
  assert.equal(args[4], outPath);
  assert.ok(args.includes("--muted"));
  assert.ok(args.includes("--codec"));
  assert.ok(args.includes("h264"));
  assert.ok(args.includes("--hardware-acceleration"));
  assert.ok(args.includes(hardwareAcceleration));
  assert.ok(args.includes("--public-dir"));
  assert.ok(args.includes(publicDir));
  assert.ok(args.includes("--props"));
  assert.ok(args.includes(propsPath));
  for (const r of resourceArgs) assert.ok(args.includes(r), `missing resourceArg ${r}`);
});

// ---- orderedFastJobs ----

test("orderedFastJobs: index/kind/outPath を保って3ジョブを返す", () => {
  const dir = "/dir";
  const plan: FastPlan = {
    eligible: true,
    wholeFallback: [],
    audioMode: "copy",
    audioFastEligible: true,
    audioFallback: [],
    spans: [
      { kind: "fast", fromFrame: 0, toFrame: 1677 },
      { kind: "slow", fromFrame: 1677, toFrame: 3518 },
      { kind: "fast", fromFrame: 3518, toFrame: 6301 },
    ],
    coverageRatio: 0.7,
    totalFrames: 6301,
    fps: 30,
  };
  const jobs = orderedFastJobs(dir, plan);
  assert.equal(jobs.length, 3);
  jobs.forEach((job, i) => {
    assert.equal(job.index, i);
    assert.equal(job.span.kind, plan.spans[i].kind);
    assert.equal(job.outPath, fastSegmentPath(dir, i));
  });
});
