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
  buildChapterEntries,
  buildChapterTelopEntries,
  plan,
} from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";
import { ID_RE } from "../src/lib/ids.ts";
import type { Config } from "../src/lib/config.ts";
import type { AssertOutcome } from "../src/stages/assert.ts";
import type { DescribeProjection } from "../src/stages/describe.ts";

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
