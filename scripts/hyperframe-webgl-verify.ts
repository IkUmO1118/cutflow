// F2 raw-WebGL render verification. Kept outside test/ because it launches
// Chrome, renders multiple stills and an MP4, and invokes ffmpeg/ffprobe.
// Usage: node scripts/hyperframe-webgl-verify.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { PERCEPTUAL_YMAX_THRESHOLD } from "../src/stages/hyperframe.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const FIXTURE_DIR = join(REPO_ROOT, "test", "fixtures", "hyperframe-backends");

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ymaxBetween(a: string, b: string): number {
  const output = execFileSync("ffmpeg", [
    "-v", "error", "-i", a, "-i", b,
    "-lavfi", "blend=all_mode=difference,signalstats,metadata=print:file=-",
    "-f", "null", "-",
  ]).toString("utf8");
  const values = [...output.matchAll(/lavfi\.signalstats\.YMAX=([0-9.]+)/g)]
    .map((match) => Number(match[1]));
  if (values.length === 0) throw new Error(`ffmpeg returned no YMAX for ${a} vs ${b}`);
  return Math.max(...values);
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "hf-webgl-verify-"));
  const html = readFileSync(join(FIXTURE_DIR, "raw-webgl.html"), "utf8");
  const contextNullHtml = readFileSync(join(FIXTURE_DIR, "raw-webgl-context-null.html"), "utf8");
  const inputProps = {
    html,
    variables: {},
    width: 640,
    height: 360,
    fps: 30,
    durationSec: 4,
    profile: "gpu-angle" as const,
  };

  await ensureBrowser();
  const serveUrl = await bundle({
    entryPoint: join(REPO_ROOT, "remotion", "index.ts"),
    publicDir: scratch,
    symlinkPublicDir: true,
  });
  const browser = await openBrowser("chrome", { chromiumOptions: { gl: "angle" } });

  try {
    const composition = await selectComposition({
      serveUrl,
      id: "HyperFrame",
      inputProps,
      puppeteerInstance: browser,
      logLevel: "warn",
    });

    let sequence = 0;
    async function still(frame: number): Promise<string> {
      const output = join(scratch, `frame-${frame}-${sequence++}.png`);
      await renderStill({
        composition,
        serveUrl,
        frame,
        output,
        inputProps,
        puppeteerInstance: browser,
        logLevel: "warn",
      });
      return output;
    }

    const baseline = new Map<number, string>();
    for (const frame of [0, 60, 119]) baseline.set(frame, await still(frame));
    for (const frame of [119, 0, 60]) {
      const candidate = await still(frame);
      const ymax = ymaxBetween(baseline.get(frame)!, candidate);
      check(
        `ANGLE shuffled frame ${frame} perceptual YMAX <= ${PERCEPTUAL_YMAX_THRESHOLD}`,
        ymax <= PERCEPTUAL_YMAX_THRESHOLD,
        `YMAX=${ymax}`,
      );
    }

    const sameA = await still(60);
    const sameB = await still(60);
    const sameYmax = ymaxBetween(sameA, sameB);
    check(
      `ANGLE same-time frame 60 YMAX <= ${PERCEPTUAL_YMAX_THRESHOLD}`,
      sameYmax <= PERCEPTUAL_YMAX_THRESHOLD,
      `YMAX=${sameYmax}; sha256Equal=${sha256(sameA) === sha256(sameB)}`,
    );

    const mp4 = join(scratch, "raw-webgl.mp4");
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: mp4,
      inputProps,
      puppeteerInstance: browser,
      overwrite: true,
      logLevel: "warn",
    });
    check("ANGLE raw-WebGL MP4 exists", existsSync(mp4));
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,pix_fmt,width,height,avg_frame_rate,nb_read_frames",
      "-count_frames", "-of", "json", mp4,
    ]).toString("utf8"));
    const stream = probe.streams?.[0] ?? {};
    check("MP4 codec h264", stream.codec_name === "h264", `got ${stream.codec_name}`);
    check("MP4 pixel format 4:2:0", ["yuvj420p", "yuv420p"].includes(stream.pix_fmt), `got ${stream.pix_fmt}`);
    check("MP4 dimensions 640x360", stream.width === 640 && stream.height === 360);
    check("MP4 fps 30", stream.avg_frame_rate === "30/1", `got ${stream.avg_frame_rate}`);
    check("MP4 frames 120", Number(stream.nb_read_frames) === 120, `got ${stream.nb_read_frames}`);

    const nullProps = { ...inputProps, html: contextNullHtml, durationSec: 1 };
    let nullError = "";
    try {
      const nullComposition = await selectComposition({
        serveUrl,
        id: "HyperFrame",
        inputProps: nullProps,
        puppeteerInstance: browser,
        logLevel: "warn",
      });
      await renderStill({
        composition: nullComposition,
        serveUrl,
        frame: 0,
        output: join(scratch, "context-null.png"),
        inputProps: nullProps,
        puppeteerInstance: browser,
        logLevel: "warn",
      });
    } catch (error) {
      nullError = error instanceof Error ? error.message : String(error);
    }
    check(
      "2D-then-WebGL context-null fails explicitly",
      /WebGL context creation failed/.test(nullError),
      nullError || "render unexpectedly succeeded",
    );
  } finally {
    await browser.close({ silent: true });
  }

  console.log(`Artifacts: ${scratch}`);
  if (failures > 0) throw new Error(`${failures} HyperFrame WebGL verification(s) failed`);
  console.log("ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
