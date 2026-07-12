// stages/plan.ts の plan --cuts-only 応答パーサ(parseCutsResponse)。
// LLM 応答が壊れていても(コードフェンス混入・cuts 欠落等)壊れ方を
// 固定して検出できるようにする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCutsResponse,
  buildCutplan,
  fillSilenceGaps,
  DEFAULT_SILENCE_CUT_REASON,
  buildChapterEntries,
  buildChapterTelopEntries,
  plan,
} from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";
import { ID_RE } from "../src/lib/ids.ts";
import type { Config } from "../src/lib/config.ts";
import type { AssertOutcome } from "../src/stages/assert.ts";
import type { DescribeProjection } from "../src/stages/describe.ts";
import type { AiAdapter } from "../src/lib/ai/types.ts";

test("正常な cuts 応答をパースできる", () => {
  const raw = JSON.stringify({
    cuts: [{ id: 3, reason: "同じ説明の言い直し(前半)" }],
  });
  const parsed = parseCutsResponse(raw);
  assert.deepEqual(parsed.cuts, [{ id: 3, reason: "同じ説明の言い直し(前半)" }]);
});

test("コードフェンスや前後の説明文が混ざっていても拾う", () => {
  const raw =
    "以下がカット判断です:\n```json\n" +
    JSON.stringify({ cuts: [{ id: 1, reason: "脱線" }] }) +
    "\n```\nご確認ください。";
  const parsed = parseCutsResponse(raw);
  assert.deepEqual(parsed.cuts, [{ id: 1, reason: "脱線" }]);
});

test("cuts が空でもエラーにならない(カット不要)", () => {
  const parsed = parseCutsResponse(JSON.stringify({ cuts: [] }));
  assert.deepEqual(parsed.cuts, []);
});

test("cuts が欠落していても空配列にフォールバックする", () => {
  const parsed = parseCutsResponse(JSON.stringify({}));
  assert.deepEqual(parsed.cuts, []);
});

test("chapters/titles/description が混ざっていても cuts だけ拾う", () => {
  // --cuts-only 用プロンプトのはずが LLM が旧フォーマットで章等を含めて
  // 返してきても、cuts-only の呼び出し側はそれらを無視できることを確認
  const raw = JSON.stringify({
    cuts: [{ id: 2, reason: "繰り返し" }],
    chapters: [{ startId: 1, title: "導入" }],
    titles: ["タイトル案"],
    description: "概要欄",
  });
  const parsed = parseCutsResponse(raw);
  assert.deepEqual(parsed.cuts, [{ id: 2, reason: "繰り返し" }]);
});

test("JSON が見つからない応答はエラーを投げる", () => {
  assert.throws(() => parseCutsResponse("カットはありません。"));
});

test("壊れた JSON はエラーを投げる", () => {
  assert.throws(() => parseCutsResponse("{ cuts: [id: 1] "));
});

/* ---------------- 安定 id(§docs/plans/2026-07-07-stable-ids-design.md) ---------------- */

const numbered: NumberedSegment[] = [
  { id: 1, start: 0, end: 10, text: "導入" },
  { id: 2, start: 10, end: 20, text: "本編" },
  { id: 3, start: 20, end: 30, text: "余談" },
];

test("buildCutplan: idCtx 省略時は id に一切触れない(導入前とバイト等価)", () => {
  const cutplan = buildCutplan(numbered, [{ id: 3, reason: "余談カット" }]);
  for (const s of cutplan.segments) assert.equal("id" in s, false);
});

test("buildCutplan: idCtx ありで span 一致の旧 segment.id を運ぶ", () => {
  const existingSegments = [
    { id: "seg_aaaaaa", start: 0, end: 10, action: "keep" as const, reason: "旧" },
    { id: "seg_bbbbbb", start: 10, end: 20, action: "keep" as const, reason: "旧" },
  ];
  const used = new Set<string>(["seg_aaaaaa", "seg_bbbbbb"]);
  const cutplan = buildCutplan(numbered, [{ id: 3, reason: "余談カット" }], {
    existingSegments,
    used,
  });
  assert.equal(cutplan.segments[0].id, "seg_aaaaaa");
  assert.equal(cutplan.segments[1].id, "seg_bbbbbb");
  // span 20-30 は旧 segments に無いので新規採番
  assert.match(cutplan.segments[2].id as string, ID_RE);
  assert.notEqual(cutplan.segments[2].id, "seg_aaaaaa");
  assert.notEqual(cutplan.segments[2].id, "seg_bbbbbb");
});

test("buildCutplan: span が変わった segment は新 id になる", () => {
  const existingSegments = [
    { id: "seg_aaaaaa", start: 0, end: 5, action: "keep" as const, reason: "旧(span 違う)" },
  ];
  const used = new Set<string>(["seg_aaaaaa"]);
  const cutplan = buildCutplan(numbered, [], { existingSegments, used });
  assert.notEqual(cutplan.segments[0].id, "seg_aaaaaa");
  assert.match(cutplan.segments[0].id as string, ID_RE);
});

test("fillSilenceGaps: 中間の隙間・先頭・末尾の穴を cut で埋め全時間を連続被覆する", () => {
  const segs = [
    { start: 5, end: 10, action: "keep" as const, reason: "" },
    { start: 15, end: 20, action: "keep" as const, reason: "" },
  ];
  const filled = fillSilenceGaps(segs, 25, "無音");
  assert.deepEqual(
    filled.map((s) => [s.start, s.end, s.action, s.reason]),
    [
      [0, 5, "cut", "無音"], // 冒頭の無音
      [5, 10, "keep", ""],
      [10, 15, "cut", "無音"], // keep 間の無音(=これまで穴だった箇所)
      [15, 20, "keep", ""],
      [20, 25, "cut", "無音"], // 末尾の無音
    ],
  );
});

test("fillSilenceGaps: 連続被覆(隙間なし・0始まり・duration ちょうど)は何も足さない", () => {
  const segs = [
    { start: 0, end: 10, action: "keep" as const, reason: "" },
    { start: 10, end: 20, action: "cut" as const, reason: "脱線" },
  ];
  assert.deepEqual(fillSilenceGaps(segs, 20, "無音"), segs);
});

test("fillSilenceGaps: 0.01秒未満の隙間は round2 の端数とみなして埋めない", () => {
  const segs = [
    { start: 0, end: 10, action: "keep" as const, reason: "" },
    { start: 10.005, end: 20, action: "keep" as const, reason: "" },
  ];
  assert.equal(fillSilenceGaps(segs, 20, "無音").length, 2);
});

test("fillSilenceGaps: reason 省略時は DEFAULT_SILENCE_CUT_REASON", () => {
  const filled = fillSilenceGaps(
    [{ start: 5, end: 10, action: "keep" as const, reason: "" }],
    10,
  );
  assert.equal(filled[0]!.action, "cut");
  assert.equal(filled[0]!.reason, DEFAULT_SILENCE_CUT_REASON);
});

test("buildCutplan: fill 指定で末尾の穴を cut として記録する(numbered は 0-30)", () => {
  const cutplan = buildCutplan(numbered, [], undefined, { duration: 40 });
  const last = cutplan.segments[cutplan.segments.length - 1]!;
  assert.equal(last.action, "cut");
  assert.equal(last.reason, DEFAULT_SILENCE_CUT_REASON);
  assert.deepEqual([last.start, last.end], [30, 40]);
});

test("buildCutplan: fill + idCtx で穴埋め cut にも id が採番される", () => {
  const used = new Set<string>();
  const cutplan = buildCutplan(
    numbered,
    [],
    { existingSegments: [], used },
    { duration: 40, reason: "無音" },
  );
  for (const s of cutplan.segments) assert.match(s.id as string, ID_RE);
});

test("buildCutplan: fill 省略時は穴を埋めない(導入前とバイト等価)", () => {
  const cutplan = buildCutplan(numbered, [{ id: 3, reason: "余談カット" }]);
  assert.deepEqual(cutplan.segments.map((s) => s.action), ["keep", "keep", "cut"]);
});

test("buildChapterEntries: idCtx 省略時は id に一切触れない", () => {
  const entries = buildChapterEntries([{ startId: 1, title: "導入" }], numbered, []);
  assert.equal("id" in entries[0], false);
});

test("buildChapterEntries: idCtx ありで title 一致の旧 id を運ぶ", () => {
  const existingChapters = [{ id: "ch_aaaaaa", start: 0, title: "導入" }];
  const used = new Set<string>(["ch_aaaaaa"]);
  const entries = buildChapterEntries(
    [{ startId: 1, title: "導入" }, { startId: 2, title: "新しい章" }],
    numbered,
    existingChapters,
    { used },
  );
  assert.equal(entries[0].id, "ch_aaaaaa");
  assert.match(entries[1].id as string, ID_RE);
});

test("buildChapterTelopEntries: idCtx 省略時は id に一切触れない", () => {
  const telops = buildChapterTelopEntries(
    { chapters: [{ start: 0, title: "導入" }] },
    3,
    2,
    [],
  );
  assert.equal("id" in telops[0], false);
});

test("buildChapterTelopEntries: idCtx ありで title 一致の旧 id を運ぶ", () => {
  const existingTelops = [
    { id: "cap_aaaaaa", start: 0, end: 2, text: "導入", track: 3 },
  ];
  const used = new Set<string>(["cap_aaaaaa"]);
  const telops = buildChapterTelopEntries(
    { chapters: [{ start: 0, title: "導入" }, { start: 20, title: "新章" }] },
    3,
    2,
    existingTelops,
    { used },
  );
  assert.equal(telops[0].id, "cap_aaaaaa");
  assert.match(telops[1].id as string, ID_RE);
});

function withPlanDir(run: (dir: string) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-plan-"));
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({
      language: "ja",
      model: "test",
      segments: [
        { start: 0, end: 9, text: "導入" },
        { start: 10, end: 19, text: "本編" },
        { start: 20, end: 29, text: "脱線" },
      ],
    }),
  );
  writeFileSync(
    join(dir, "cuts.auto.json"),
    JSON.stringify({
      params: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15 },
      silences: [],
      keepSegments: [
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 20, end: 30 },
      ],
      keptDurationSec: 30,
      originalDurationSec: 30,
    }),
  );
  const done = Promise.resolve(run(dir));
  return done.finally(() => rmSync(dir, { recursive: true, force: true }));
}

function loopCfg(maxIterations: number): Config {
  return {
    plan: { loop: { maxIterations, targetOutDurationSec: 15, stopWhenAssertionsPass: true } },
  } as Config;
}

function fakeProjection(outDurationSec: number): DescribeProjection {
  return {
    summary: { outDurationSec, keepCount: 2 },
    cuts: [{}, {}],
  } as DescribeProjection;
}

test("plan --cuts-only: deps.complete を使い、ループ無効時は plan.loop.json を書かない", async () => {
  await withPlanDir(async (dir) => {
    const cfg = { plan: { loop: { maxIterations: 0 } } } as Config;
    const result = await plan(dir, cfg, { cutsOnly: true }, {
      complete: async () => JSON.stringify({ cuts: [{ id: 3, reason: "脱線" }] }),
    });
    assert.deepEqual(
      result.segments.map((s) => [s.start, s.end, s.action, s.reason]),
      [
        [0, 10, "keep", ""],
        [10, 20, "keep", ""],
        [20, 30, "cut", "脱線"],
      ],
    );
    assert.equal(existsSync(join(dir, "plan.loop.json")), false);
    assert.equal(readFileSync(join(dir, "plan.raw.txt"), "utf8"), JSON.stringify({ cuts: [{ id: 3, reason: "脱線" }] }));
  });
});

test("plan --cuts-only: plan.harness.agentic=false は harness 追加前と完全にバイト等価(§SD4design 1-1)", async () => {
  await withPlanDir(async (dir) => {
    const cfg = { plan: { loop: { maxIterations: 0 }, harness: { agentic: false } } } as Config;
    const result = await plan(dir, cfg, { cutsOnly: true }, {
      complete: async () => JSON.stringify({ cuts: [{ id: 3, reason: "脱線" }] }),
    });
    assert.deepEqual(
      result.segments.map((s) => [s.start, s.end, s.action, s.reason]),
      [
        [0, 10, "keep", ""],
        [10, 20, "keep", ""],
        [20, 30, "cut", "脱線"],
      ],
    );
    assert.equal(existsSync(join(dir, "plan.loop.json")), false);
  });
});

test("plan --cuts-only: harness.agentic=true でも structured route アダプタが completeAgentic 非対応(既定 claude-code)なら警告のうえ単発/pushループ経路へフォールバックする", async () => {
  await withPlanDir(async (dir) => {
    // loop も設定しないので、harness が有効(≒maxIterations>=2 に昇格)扱いに
    // ならなければ従来の generateCutsOnce(1ショット)のまま plan.loop.json は書かれない
    const cfg = { plan: { harness: { agentic: true } } } as Config;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      const result = await plan(dir, cfg, { cutsOnly: true }, {
        complete: async () => JSON.stringify({ cuts: [{ id: 3, reason: "脱線" }] }),
      });
      assert.equal(result.segments[2]!.action, "cut");
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(warnings.some((w) => /フォールバック/.test(w)), warnings.join("\n"));
  });
});

test("plan --cuts-only: harness.agentic=true(anthropic + fake completeAgentic)で agenticTrace 付き plan.loop.json を書く", async () => {
  await withPlanDir(async (dir) => {
    // describe_timeline/set_cuts tool は describeJson 経由で manifest.json を
    // 要求するので、この収録固有で用意する(withPlanDir の共通 fixture には無い)
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        dir,
        source: "source.mp4",
        durationSec: 30,
        video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
        audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
        createdAt: "2026-07-11T00:00:00.000Z",
      }),
    );
    const cfg = {
      ai: { provider: "anthropic", model: "claude-x" },
      plan: { harness: { agentic: true } },
    } as Config;
    const fakeAdapter: AiAdapter = {
      kind: "anthropic",
      async complete() {
        throw new Error("not used in this test");
      },
      async completeAgentic(_req, _profile, _context, handleTool) {
        const described = await handleTool("describe_timeline", {});
        assert.match(described.text ?? "", /出力尺/);
        const setResult = await handleTool("set_cuts", { cuts: [{ id: 3, reason: "脱線" }] });
        assert.equal(setResult.isError, undefined);
        return {
          text: JSON.stringify({ cuts: [{ id: 3, reason: "脱線" }] }),
          toolCalls: 2,
          profile: "p",
          adapter: "anthropic",
          model: "claude-x",
        };
      },
    };
    const result = await plan(dir, cfg, { cutsOnly: true }, {
      agenticAdapterOverride: fakeAdapter,
      observe: {
        async observe() {
          return {
            proj: fakeProjection(10),
            outcomes: [{ index: 0, type: "outDuration", status: "pass", message: "ok" }],
          };
        },
      },
    });
    assert.equal(result.segments[2]!.action, "cut");
    assert.equal(result.segments[2]!.reason, "脱線");

    const log = JSON.parse(readFileSync(join(dir, "plan.loop.json"), "utf8")) as {
      iterations: { agenticTrace?: { tool: string }[]; agenticDegraded?: string }[];
    };
    assert.equal(log.iterations.length, 1);
    assert.deepEqual(log.iterations[0]!.agenticTrace?.map((t) => t.tool), ["describe_timeline", "set_cuts"]);
    assert.equal(log.iterations[0]!.agenticDegraded, undefined);
  });
});

test("plan --cuts-only loop: assertions-pass で停止し最終 cutplan と plan.loop.json を書く", async () => {
  await withPlanDir(async (dir) => {
    const raws = [
      JSON.stringify({ cuts: [] }),
      JSON.stringify({ cuts: [{ id: 3, reason: "脱線" }] }),
    ];
    const outcomes: AssertOutcome[][] = [
      [{ index: 0, type: "outDuration", status: "fail", message: "too long" }],
      [{ index: 0, type: "outDuration", status: "pass", message: "ok" }],
    ];
    let calls = 0;
    const result = await plan(dir, loopCfg(3), { cutsOnly: true }, {
      complete: async () => raws[calls++]!,
      observe: {
        async observe() {
          const idx = Math.min(calls - 1, outcomes.length - 1);
          return { proj: fakeProjection(idx === 0 ? 30 : 10), outcomes: outcomes[idx]! };
        },
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.approved, false);
    assert.equal(result.segments[2].action, "cut");
    assert.equal(existsSync(join(dir, "approvals.json")), false);

    const log = JSON.parse(readFileSync(join(dir, "plan.loop.json"), "utf8")) as {
      iterations: { kind: string; stop: string | null; cuts: { id: number; reason: string }[] }[];
    };
    assert.equal(log.iterations.length, 2);
    assert.deepEqual(log.iterations.map((i) => i.kind), ["generate", "critique"]);
    assert.equal(log.iterations[0].stop, null);
    assert.equal(log.iterations[1].stop, "assertions-pass");
    assert.deepEqual(log.iterations[1].cuts, [{ id: 3, reason: "脱線" }]);
    assert.equal(readFileSync(join(dir, "plan.raw.txt"), "utf8"), raws[1]);
  });
});

test("plan --cuts-only loop: 同じ cut 集合を再出力したら fixpoint で停止", async () => {
  await withPlanDir(async (dir) => {
    const raw = JSON.stringify({ cuts: [{ id: 2, reason: "重複" }] });
    let calls = 0;
    await plan(dir, loopCfg(3), { cutsOnly: true }, {
      complete: async () => {
        calls++;
        return raw;
      },
      observe: {
        async observe() {
          return {
            proj: fakeProjection(25),
            outcomes: [{ index: 0, type: "outDuration", status: "fail", message: "too long" }],
          };
        },
      },
    });
    const log = JSON.parse(readFileSync(join(dir, "plan.loop.json"), "utf8")) as {
      iterations: { stop: string | null }[];
    };
    assert.equal(calls, 2);
    assert.equal(log.iterations.at(-1)?.stop, "fixpoint");
  });
});

test("plan --cuts-only loop: observe が secondary/warnings を返すと log に summary だけ残す", async () => {
  await withPlanDir(async (dir) => {
    await plan(dir, loopCfg(2), { cutsOnly: true }, {
      complete: async () => JSON.stringify({ cuts: [{ id: 2, reason: "重複" }] }),
      observe: {
        async observe() {
          return {
            proj: fakeProjection(25),
            outcomes: [{ index: 0, type: "outDuration", status: "fail", message: "too long" }],
            warnings: ["secondary warning"],
            secondary: {
              schemaVersion: 1,
              kind: "vlm",
              summary: ["summary"],
              items: [],
              uncertainties: [],
              confidence: "medium",
              provenance: {
                profile: "vision",
                adapter: "openai",
                model: "gpt-x",
                observedAt: "2026-07-09T00:00:00Z",
                imageCount: 1,
                inputDigest: "abc",
              },
            },
          };
        },
      },
    });
    const log = JSON.parse(readFileSync(join(dir, "plan.loop.json"), "utf8")) as {
      iterations: Array<{ secondaryObservation?: { inputDigest: string; profile: string; model: string }; secondaryWarnings?: string[]; observation: string }>;
    };
    assert.equal(log.iterations[0]?.secondaryObservation?.inputDigest, "abc");
    assert.deepEqual(log.iterations[0]?.secondaryWarnings, ["secondary warning"]);
    assert.match(log.iterations[0]?.observation ?? "", /画像モデルによる二次観測/);
  });
});
