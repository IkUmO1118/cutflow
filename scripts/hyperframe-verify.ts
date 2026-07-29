// scripts/hyperframe-verify.ts — HyperFrames CDP driver の実描画による
// 重い検証。node --test には乗せない(npm test は bare
// `node --test` で scripts/ を自動収集しないため、この規約に従って
// test/ ではなくここに置く)。regression-snapshot.ts と同じく既存の関数を
// 直呼びし、CLI を spawn しない。
//
// 検証内容:
//   1. 決定論+順序非依存: フレーム [0,30,60,90,119] を順番通り/バラバラの
//      順で render し、同じフレーム番号は同じ sha256 になること
//   2. 再レンダー byte 一致: 同じフレームを2回 render して同じ sha256
//   3. 変数注入: variables を変えると絵が変わる(sha256 が変わる)こと
//   4. mp4 出力: h264 / yuvj420p(fastSegment.ts BASE_COLOR_FILTER と同じ
//      full-range 8bit 4:2:0 慣行。yuv420p も許容) / 1920x1080 / 30fps /
//      120 フレームで決定される renderMedia の結果を ffprobe で確認
//
// 使い方: node scripts/hyperframe-verify.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeVariables, parseComposition, SAMPLE_HTML } from "../src/lib/hyperframe.ts";
import { createHyperframeSession } from "../src/lib/hyperframeSession.ts";
import { startFramePipe } from "../src/lib/framePipe.ts";
import { compositionDurationInFrames } from "../src/lib/renderFrameMath.ts";

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "hf-verify-"));

  const parsed = parseComposition(SAMPLE_HTML);
  const defaultVariables = mergeVariables(parsed.variables);
  const inputProps = {
    html: SAMPLE_HTML,
    variables: defaultVariables,
    width: 1920,
    height: 1080,
    fps: 30,
    durationSec: 4,
    profile: "default" as const,
  };

  let seq = 0;
  async function hashStill(frame: number, props: typeof inputProps): Promise<string> {
    const session = await createHyperframeSession(props);
    try {
      seq += 1;
      const out = join(scratch, `f${frame}-${seq}.png`);
      const png = await session.seekAndCapture(frame / props.fps);
      writeFileSync(out, Buffer.from(png, "base64"));
      return hashFile(out);
    } finally {
      await session.close();
    }
  }

  // 1. 決定論+順序非依存
  const inOrderFrames = [0, 30, 60, 90, 119];
  const inOrderHashes: Record<number, string> = {};
  for (const f of inOrderFrames) {
    inOrderHashes[f] = await hashStill(f, inputProps);
  }

  const shuffled = [90, 60, 0, 119, 30];
  let orderOk = true;
  for (const f of shuffled) {
    const h = await hashStill(f, inputProps);
    if (h !== inOrderHashes[f]) {
      orderOk = false;
      console.log(`  frame ${f}: in-order=${inOrderHashes[f]} shuffled=${h}`);
    }
  }
  check("determinism+order-independence (frames 0,30,60,90,119)", orderOk);

  // 2. 再レンダー byte 一致
  const rerenderA = await hashStill(60, inputProps);
  const rerenderB = await hashStill(60, inputProps);
  check("re-render byte-identity (frame 60 x2)", rerenderA === rerenderB);

  // 3. 変数注入で絵が変わる
  const variedProps = {
    ...inputProps,
    variables: mergeVariables(parsed.variables, undefined, { title: "Pro", accent: "#ff4d4f" }),
  };
  const variedHash = await hashStill(60, variedProps);
  check("variable injection changes output (frame 60)", variedHash !== inOrderHashes[60]);

  // 4. mp4 出力
  const mp4 = join(scratch, "hf.mp4");
  const session = await createHyperframeSession(inputProps);
  const pipe = startFramePipe({ fps: inputProps.fps, outPath: mp4 });
  try {
    const frames = compositionDurationInFrames(inputProps.durationSec, inputProps.fps);
    for (let frame = 0; frame < frames; frame++) {
      const png = await session.seekAndCapture(frame / inputProps.fps);
      await pipe.write(Buffer.from(png, "base64"));
    }
    await pipe.finish();
  } finally {
    await session.close();
  }
  check("mp4 file exists", existsSync(mp4));

  if (existsSync(mp4)) {
    const probeRaw = execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,pix_fmt,width,height,avg_frame_rate,nb_read_frames",
      "-count_frames",
      "-of", "json",
      mp4,
    ]).toString("utf8");
    const probe = JSON.parse(probeRaw);
    const stream = probe.streams?.[0] ?? {};
    check("mp4 codec_name=h264", stream.codec_name === "h264", `got ${stream.codec_name}`);
    const pixFmtOk = stream.pix_fmt === "yuvj420p" || stream.pix_fmt === "yuv420p";
    check(
      pixFmtOk
        ? "mp4 pix_fmt is 8bit 4:2:0 h264"
        : "mp4 pix_fmt is 8bit 4:2:0 h264 (yuvj420p/yuv420p)",
      pixFmtOk,
      `got ${stream.pix_fmt}`,
    );
    check("mp4 width=1920", Number(stream.width) === 1920, `got ${stream.width}`);
    check("mp4 height=1080", Number(stream.height) === 1080, `got ${stream.height}`);
    check("mp4 avg_frame_rate=30/1", stream.avg_frame_rate === "30/1", `got ${stream.avg_frame_rate}`);
    check("mp4 nb_read_frames=120", Number(stream.nb_read_frames) === 120, `got ${stream.nb_read_frames}`);
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
