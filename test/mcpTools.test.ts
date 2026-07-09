// src/mcp/tools.ts — makeTools(dir, cfg) が組み立てる tool レジストリの配線を
// 固定する。T3(docs/plans/2026-07-07-mcp-server-design.md §9)。
//
// 内部関数(describeJson/validate/applyEdits/planApply/idStamp/materials/
// assert)は既に単体テスト済みなので、ここでは「正しい関数を呼ぶ・結果を
// 正しく ToolResult 化する」配線の正しさと、承認境界(§design doc 論点6)の
// 凍結だけを検査する。frames は実 Remotion レンダーが重いため、引数検査
// (排他規則)だけを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/lib/config.ts";
import { makeTools } from "../src/mcp/tools.ts";
import { JsonRpcError } from "../src/mcp/types.ts";
import type { ToolResult } from "../src/mcp/types.ts";

const cfg = loadConfig();

/** 最小の妥当な収録フォルダ(manifest+cutplan+transcript のみ)。
 * overlays/bgm/materials を持たないので cutflow_materials は空 index を
 * 返す(実 ffprobe を一切呼ばない=軽量・決定論的) */
function makeGoodProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-mcp-tools-good-"));
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
  write("manifest.json", {
    dir,
    source: "raw.mkv",
    durationSec: 100,
    layout: "plain",
    video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-07T00:00:00Z",
  });
  write("cutplan.json", {
    approved: false,
    segments: [
      { start: 0, end: 40, action: "keep", reason: "本編" },
      { start: 40, end: 50, action: "cut", reason: "言い直し" },
      { start: 50, end: 100, action: "keep", reason: "まとめ" },
    ],
  });
  write("transcript.json", {
    segments: [{ start: 1, end: 3, text: "こんにちは" }],
  });
  return dir;
}

/** cutplan の keep 区間が重なる壊れたプロジェクト(validate エラーを
 * 確実に起こすため) */
function makeBrokenProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-mcp-tools-broken-"));
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
  write("manifest.json", {
    dir,
    source: "raw.mkv",
    durationSec: 100,
    layout: "plain",
    video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-07T00:00:00Z",
  });
  write("cutplan.json", {
    approved: false,
    segments: [
      { start: 0, end: 40, action: "keep", reason: "本編" },
      { start: 30, end: 60, action: "keep", reason: "重なっている" },
    ],
  });
  write("transcript.json", { segments: [] });
  return dir;
}

function rm(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function jsonOf(result: ToolResult): unknown {
  return JSON.parse(result.content[1].text);
}

/* ---------------- レジストリの一覧・承認境界の凍結 ---------------- */

test("makeTools: 安全なread/review/edit/search toolだけを露出する", () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "cutflow_apply",
      "cutflow_assert",
      "cutflow_av",
      "cutflow_describe",
      "cutflow_edit",
      "cutflow_frames",
      "cutflow_id_stamp",
      "cutflow_materials",
      "cutflow_review",
      "cutflow_search",
      "cutflow_validate",
    ]);
  } finally {
    rm(dir);
  }
});

test("cutflow_av: tool 一覧にあり、json payload を返す", async () => {
  const dir = makeGoodProject();
  try {
    execFileSync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=1:size=320x240:rate=10",
      join(dir, "proxy.mp4"),
    ]);
    const tools = makeTools(dir, cfg);
    const avTool = tools.find((t) => t.name === "cutflow_av")!;
    const result = await avTool.handler({ motionOnly: true });
    assert.equal(result.isError, undefined);
    const payload = jsonOf(result) as { motion?: unknown; sound?: unknown };
    assert.ok(payload.motion);
    assert.equal(payload.sound, undefined);
  } finally {
    rm(dir);
  }
});

test("makeTools: approve/unapprove/render/plan/remeta/plan-shorts/run/ingest/transcribe/detect/preview/thumbnail/editor/frames-serve/learn はレジストリに物理的に存在しない", () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const names = new Set(tools.map((t) => t.name));
    const forbiddenSubstrings = [
      "approve",
      "unapprove",
      "render",
      "plan",
      "remeta",
      "run",
      "ingest",
      "transcribe",
      "detect",
      "preview",
      "thumbnail",
      "editor",
      "frames-serve",
      "frames_serve",
      "learn",
    ];
    for (const name of names) {
      for (const bad of forbiddenSubstrings) {
        assert.equal(
          name.includes(bad),
          false,
          `tool 名 "${name}" が禁止語 "${bad}" を含んでいます(承認/破壊系の混入)`,
        );
      }
    }
    // 名指しでも確認(将来 forbiddenSubstrings の書き換えに頼らない冗長な固定)
    for (const bad of [
      "cutflow_approve",
      "cutflow_unapprove",
      "cutflow_render",
      "cutflow_plan",
      "cutflow_remeta",
      "cutflow_plan_shorts",
      "cutflow_run",
      "cutflow_ingest",
      "cutflow_transcribe",
      "cutflow_detect",
      "cutflow_preview",
      "cutflow_thumbnail",
      "cutflow_editor",
      "cutflow_frames_serve",
      "cutflow_learn",
    ]) {
      assert.equal(names.has(bad), false, `${bad} がレジストリに存在してはいけません`);
    }
  } finally {
    rm(dir);
  }
});

test("makeTools: 未登録の tool 名は tools/call の name 引きでも見つからない(Map に無い)", () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.equal(byName.get("cutflow_render"), undefined);
    assert.equal(byName.get("cutflow_approve"), undefined);
  } finally {
    rm(dir);
  }
});

/* ---------------- cutflow_describe ---------------- */

test("cutflow_describe: DescribeProjection の JSON を content に返す(isError なし)", async () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const describe = tools.find((t) => t.name === "cutflow_describe")!;
    const result = await describe.handler(undefined);
    assert.equal(result.isError, undefined);
    const proj = jsonOf(result) as { keeps: unknown[]; summary: unknown };
    assert.ok(Array.isArray(proj.keeps));
    assert.ok(proj.summary);
  } finally {
    rm(dir);
  }
});

/* ---------------- cutflow_validate ---------------- */

test("cutflow_validate: 妥当なプロジェクトは isError なし", async () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const validateTool = tools.find((t) => t.name === "cutflow_validate")!;
    const result = await validateTool.handler(undefined);
    assert.equal(result.isError, undefined);
    const r = jsonOf(result) as { errors: unknown[] };
    assert.deepEqual(r.errors, []);
  } finally {
    rm(dir);
  }
});

test("cutflow_validate: 検査エラーのあるプロジェクトは isError:true + Problem[] を返す", async () => {
  const dir = makeBrokenProject();
  try {
    const tools = makeTools(dir, cfg);
    const validateTool = tools.find((t) => t.name === "cutflow_validate")!;
    const result = await validateTool.handler(undefined);
    assert.equal(result.isError, true);
    const r = jsonOf(result) as { errors: { file: string; where: string; message: string }[] };
    assert.ok(r.errors.length > 0);
    assert.match(r.errors[0]!.message, /重なっています/);
  } finally {
    rm(dir);
  }
});

/* ---------------- cutflow_apply ---------------- */

test("cutflow_apply: dryRun は書かずに diff を返す", async () => {
  const dir = makeGoodProject();
  try {
    const before = readFileSync(join(dir, "cutplan.json"), "utf8");
    const tools = makeTools(dir, cfg);
    const applyTool = tools.find((t) => t.name === "cutflow_apply")!;
    const result = await applyTool.handler({
      patch: { replace: { chapters: { chapters: [{ start: 0, title: "導入" }] } } },
      dryRun: true,
    });
    assert.equal(result.isError, undefined);
    const plan = jsonOf(result) as { changedFiles: string[] };
    assert.deepEqual(plan.changedFiles, ["chapters.json"]);
    // 書いていない
    assert.equal(readFileSync(join(dir, "cutplan.json"), "utf8"), before);
    assert.equal(existsSync(join(dir, "chapters.json")), false);
  } finally {
    rm(dir);
  }
});

test("cutflow_apply: 実行(dryRun 無し)は成功時に書き込み、written を返す", async () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const applyTool = tools.find((t) => t.name === "cutflow_apply")!;
    const result = await applyTool.handler({
      patch: { replace: { chapters: { chapters: [{ start: 0, title: "導入" }] } } },
    });
    assert.equal(result.isError, undefined);
    const r = jsonOf(result) as { written: string[] };
    assert.deepEqual(r.written, ["chapters.json"]);
    const written = JSON.parse(readFileSync(join(dir, "chapters.json"), "utf8")) as {
      chapters: { title: string }[];
    };
    assert.equal(written.chapters[0]!.title, "導入");
  } finally {
    rm(dir);
  }
});

test("cutflow_apply: 不正パッチ(未解決の @id)は isError:true・ディスク不変", async () => {
  const dir = makeGoodProject();
  try {
    const beforeCutplan = readFileSync(join(dir, "cutplan.json"), "utf8");
    const tools = makeTools(dir, cfg);
    const applyTool = tools.find((t) => t.name === "cutflow_apply")!;
    const result = await applyTool.handler({
      patch: { ops: [{ op: "set", target: "@seg_nope00", field: "reason", value: "x" }] },
    });
    assert.equal(result.isError, true);
    const r = jsonOf(result) as { written: string[] };
    assert.deepEqual(r.written, []);
    assert.equal(readFileSync(join(dir, "cutplan.json"), "utf8"), beforeCutplan);
  } finally {
    rm(dir);
  }
});

test("cutflow_apply: patch 引数が無い/オブジェクトでない場合は JsonRpcError(-32602)", async () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const applyTool = tools.find((t) => t.name === "cutflow_apply")!;
    await assert.rejects(
      async () => applyTool.handler({}),
      (e: unknown) => e instanceof JsonRpcError && e.code === -32602,
    );
    await assert.rejects(
      async () => applyTool.handler({ patch: "not-an-object" }),
      (e: unknown) => e instanceof JsonRpcError && e.code === -32602,
    );
  } finally {
    rm(dir);
  }
});

/* ---------------- cutflow_id_stamp ---------------- */

test("cutflow_id_stamp: 初回は changed が非空、2回目は冪等(空)", async () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const idStampTool = tools.find((t) => t.name === "cutflow_id_stamp")!;
    const first = await idStampTool.handler(undefined);
    assert.equal(first.isError, undefined);
    const r1 = jsonOf(first) as { changed: string[] };
    assert.ok(r1.changed.length > 0);

    const second = await idStampTool.handler(undefined);
    const r2 = jsonOf(second) as { changed: string[] };
    assert.deepEqual(r2.changed, []);
  } finally {
    rm(dir);
  }
});

/* ---------------- cutflow_materials ---------------- */

test("cutflow_materials: 素材参照が無いプロジェクトは空 index を返す(isError なし)", async () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const materialsTool = tools.find((t) => t.name === "cutflow_materials")!;
    const result = await materialsTool.handler(undefined);
    assert.equal(result.isError, undefined);
    const index = jsonOf(result) as { materials: unknown[] };
    assert.deepEqual(index.materials, []);
  } finally {
    rm(dir);
  }
});

/* ---------------- cutflow_assert ---------------- */

test("cutflow_assert: assertions.json が無ければ空レポート(isError なし)", async () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const assertTool = tools.find((t) => t.name === "cutflow_assert")!;
    const result = await assertTool.handler(undefined);
    assert.equal(result.isError, undefined);
    const report = jsonOf(result) as { outcomes: unknown[] };
    assert.deepEqual(report.outcomes, []);
  } finally {
    rm(dir);
  }
});

/* ---------------- cutflow_frames(引数検査のみ。実レンダーは重いため対象外) ---------------- */

test("cutflow_frames: t/captions/every のどれも無ければ JsonRpcError(-32602)", async () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const framesTool = tools.find((t) => t.name === "cutflow_frames")!;
    await assert.rejects(
      () => Promise.resolve(framesTool.handler({})),
      (e: unknown) => e instanceof JsonRpcError && e.code === -32602,
    );
    await assert.rejects(
      () => Promise.resolve(framesTool.handler({ t: "10", captions: true })),
      (e: unknown) => e instanceof JsonRpcError && e.code === -32602,
    );
  } finally {
    rm(dir);
  }
});

test("cutflow_frames: out は t とだけ併用できる", async () => {
  const dir = makeGoodProject();
  try {
    const tools = makeTools(dir, cfg);
    const framesTool = tools.find((t) => t.name === "cutflow_frames")!;
    await assert.rejects(
      () => Promise.resolve(framesTool.handler({ every: 10, out: true })),
      (e: unknown) => e instanceof JsonRpcError && e.code === -32602,
    );
  } finally {
    rm(dir);
  }
});
