// lib/fastRender.ts の純関数テスト(decideFastPath / buildSlowSegmentRemotionArgs /
// orderedFastJobs)。ffmpeg/Remotion を起動する runFastRender は対象外(coordinator が
// cold Before/After で実測する)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  buildSlowSegmentRemotionArgs,
  cleanupFastRenderTemps,
  decideFastPath,
  orderedFastJobs,
} from "../src/lib/fastRender.ts";
import { resolveFastBaseCapability } from "../src/lib/fastBaseCapability.ts";
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

function decisionFor(props: RenderProps, cfg: Config, composite: boolean) {
  const base = resolveFastBaseCapability({ props, composite });
  return decideFastPath({ props, cfg, base });
}

// ---- decideFastPath ----

test("decideFastPath: fastPath:false → 無効", () => {
  const decision = decisionFor(mkProps(), cfgWith({ fastPath: false }), true);
  assert.deepEqual(decision, { activate: false, reason: "fastPath 無効" });
});

test("decideFastPath: fastPath:true, composite:false → 非composite経路", () => {
  const decision = decisionFor(mkProps(), cfgWith({ fastPath: true }), false);
  assert.equal(decision.activate, false);
  assert.equal(!decision.activate && decision.reason, "非composite経路(cut.mp4 が出力解像度でない)");
});

test("decideFastPath: plain identityのlandscape/portraitをactivateする", () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
    const props = mkProps({
      width,
      height,
      canvas: { w: width, h: height },
      screenRegion: { x: 0, y: 0, w: width, h: height },
      cameraRegion: undefined,
    });
    const base = resolveFastBaseCapability({ props, composite: false });
    assert.deepEqual(base, { ok: true, mode: "plain-identity" });
    assert.equal(decideFastPath({ props, cfg: cfgWith({ fastPath: true }), base }).activate, true);
  }
});

test("decideFastPath: camera無しdesignのasset不足理由をそのまま返してfull fallback", () => {
  const props = mkProps({
    cameraRegion: undefined,
    design: {
      backgroundColor: "#001122",
      screen: { rect: { x: 100, y: 22, w: 1720, h: 968 }, radiusPx: 24, shadow: true },
    },
  });
  const base = resolveFastBaseCapability({ props, composite: false });
  assert.deepEqual(decideFastPath({ props, cfg: cfgWith({ fastPath: true }), base }), {
    activate: false,
    reason: "design基底asset不足(backdrop/screenMask)",
  });
});

test("decideFastPath: 挿入があっても映像・音声ともに適格(P5-4)。insert-mix で activate する", () => {
  const props = mkProps({
    baseSegments: [{ start: 5, videoStart: 0, durationSec: 15 }],
    inserts: [{ start: 0, end: 5, file: "i.mp4", fit: "cover" }],
  });
  const decision = decisionFor(props, cfgWith({ fastPath: true }), true);
  const plan = fastPlan(props);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.wholeFallback, []);
  assert.equal(plan.audioMode, "insert-mix");
  assert.equal(plan.audioFastEligible, true);
  assert.deepEqual(plan.audioFallback, []);
  assert.equal(decision.activate, true);
  assert.ok(decision.activate);
  if (decision.activate) assert.equal(decision.plan.audioMode, "insert-mix");
});

test("decideFastPath: 挿入 + 素材音声(overlays[].volume>0)は依然として音声適格外(素材音声は据え置き)", () => {
  const props = mkProps({
    baseSegments: [{ start: 5, videoStart: 0, durationSec: 15 }],
    inserts: [{ start: 0, end: 5, file: "i.mp4", fit: "cover" }],
    overlays: [{ start: 6, end: 8, file: "material.mp4", track: 1, fit: "contain", volume: 1 }],
  });
  const decision = decisionFor(props, cfgWith({ fastPath: true }), true);
  assert.equal(decision.activate, false);
  const reason = !decision.activate ? decision.reason : "";
  assert.ok(reason.startsWith("音声適格外:"), reason);
  assert.ok(reason.includes("素材音声"), reason);
});

test("decideFastPath: colorFilter(表現可能)は activate する(P5-3)", () => {
  const props = mkProps({ colorFilter: { brightness: 1.1 } });
  const decision = decisionFor(props, cfgWith({ fastPath: true }), true);
  assert.equal(decision.activate, true);
});

test("decideFastPath: colorFilter(saturate>2.0776 で表現不能)は適格外", () => {
  const props = mkProps({ colorFilter: { saturate: 2.5 } });
  const decision = decisionFor(props, cfgWith({ fastPath: true }), true);
  assert.equal(decision.activate, false);
  assert.ok(!decision.activate);
  if (!decision.activate) assert.ok(decision.reason.startsWith("適格外: colorFilter("));
});

test("decideFastPath: BGM があっても bgm-mix で activate", () => {
  const props = mkProps({ bgm: [{ file: "a.mp3", volumeDb: -18, start: 0, end: 20 }] });
  const decision = decisionFor(props, cfgWith({ fastPath: true }), true);
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
  const decision = decisionFor(props, cfgWith({ fastPath: true }), true);
  assert.equal(decision.activate, false);
  const reason = !decision.activate ? decision.reason : "";
  assert.ok(reason.startsWith("音声適格外:"), reason);
  assert.ok(reason.includes("素材音声"), reason);
});

test("decideFastPath: 全編 zoom(coverage 0)は被覆率で非適用", () => {
  const props = mkProps({
    durationSec: 20,
    zooms: [{ start: 0, end: 20, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 }],
  });
  const decision = decisionFor(props, cfgWith({ fastPath: true }), true);
  assert.equal(decision.activate, false);
  const reason = !decision.activate ? decision.reason : "";
  assert.ok(reason.startsWith("被覆率"), reason);
});

test("decideFastPath: 全適格・被覆率が閾値以上なら activate", () => {
  const props = mkProps();
  const decision = decisionFor(props, cfgWith({ fastPath: true }), true);
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
    zooms: [{ start: 9, end: 18, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 }],
  });
  const plan = fastPlan(props);
  assert.ok(plan.coverageRatio > 0.5 && plan.coverageRatio < 0.9, `coverageRatio=${plan.coverageRatio}`);

  const low = decisionFor(props, cfgWith({ fastPath: true, fastPathMinCoverage: 0.5 }), true);
  assert.equal(low.activate, true);

  const high = decisionFor(props, cfgWith({ fastPath: true, fastPathMinCoverage: 0.9 }), true);
  assert.equal(high.activate, false);
});

test("decideFastPath: compositeのdecision/planは能力ゲート導入前と同値", () => {
  const props = mkProps();
  const plan = fastPlan(props);
  assert.deepEqual(
    decisionFor(props, cfgWith({ fastPath: true }), true),
    { activate: true, plan },
  );
});

test("decideFastPath: asset完備のdesign基底はactivateする", () => {
  const props = mkProps({
    canvas: { w: 3840, h: 1080 },
    design: {
      backgroundColor: "#001122",
      screen: { rect: { x: 100, y: 22, w: 1720, h: 968 }, radiusPx: 24, shadow: true },
      camera: { rect: { x: 1517, y: 677, w: 375, h: 375 }, radiusPx: 96, shadow: true },
      assets: {
        key: "0123456789abcdef",
        backdropFile: "render.fast/design/key.backdrop.png",
        screenMaskFile: "render.fast/design/key.screen-mask.png",
        cameraShadowFile: "render.fast/design/key.camera-shadow.png",
        cameraMaskFile: "render.fast/design/key.camera-mask.png",
      },
    },
  });
  const base = resolveFastBaseCapability({ props, composite: false });
  assert.equal(base.ok && base.mode, "design");
  const decision = decideFastPath({ props, cfg: cfgWith({ fastPath: true }), base });
  assert.equal(decision.activate, true);
  assert.deepEqual(decision.activate && decision.plan, fastPlan(props));
});

test("cleanupFastRenderTemps: success/failureどちらでもcacheを残し一時出力だけ消す", async () => {
  for (const outcome of ["success", "failure"]) {
    const dir = await mkdtemp(join(tmpdir(), `cutflow-fast-${outcome}-`));
    try {
      const fastDir = join(dir, "render.fast");
      const segDir = join(fastDir, "segments");
      const cacheFiles = [
        join(fastDir, "design", "key.backdrop.png"),
        join(fastDir, "captions", "caption.png"),
        join(fastDir, "overlays", "overlay.png"),
        join(fastDir, "annotations", "annotation.png"),
      ];
      const assembledVideo = join(fastDir, ".assembled-video.mp4");
      const audioM4a = join(fastDir, "audio.m4a");
      const tempFinal = join(dir, ".final.fast.tmp.mp4");
      for (const path of [...cacheFiles, join(segDir, "seg000.mp4"), assembledVideo, audioM4a, tempFinal]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, outcome);
      }

      cleanupFastRenderTemps({ segDir, assembledVideo, audioM4a, tempFinal });

      for (const path of cacheFiles) assert.equal(existsSync(path), true, path);
      for (const path of [segDir, assembledVideo, audioM4a, tempFinal]) {
        assert.equal(existsSync(path), false, path);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
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
