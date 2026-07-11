// lib/ai/agenticCut.ts の有界 tool-use ループ(H1/H2)。実際の LLM は叩かず、
// スクリプト化した completeAgentic を持つ fake アダプタでループを駆動する。
// §docs/plans/2026-07-11-h1-h2-agentic-perception-loop-design.md §4
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agenticCutTurn } from "../src/lib/ai/agenticCut.ts";
import type { AgenticCtx } from "../src/lib/ai/agenticCut.ts";
import type {
  AiAdapter,
  AiAgenticRequest,
  AiAgenticResponse,
  AiAgenticToolHandler,
} from "../src/lib/ai/types.ts";
import type { Config } from "../src/lib/config.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";
import type { CutPlan, WordTiming } from "../src/types.ts";

/** 候補#2([10,20])に落ちる語8つ(word i: [10+i-1, 10+i-1+0.8]、gap 0.2)。
 * H6(candidateSplit)テストと同じ語配置で境界スナップの数値を揃える */
function wordsForCandidate2(): WordTiming[] {
  return Array.from({ length: 8 }, (_, i) => ({
    text: `語${i + 1}`,
    start: 10 + i,
    end: 10 + i + 0.8,
  }));
}

function withDir(run: (dir: string) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-agenticcut-"));
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
  const done = Promise.resolve(run(dir));
  return done.finally(() => rmSync(dir, { recursive: true, force: true }));
}

const numbered: NumberedSegment[] = [
  { id: 1, start: 0, end: 10, text: "導入" },
  { id: 2, start: 10, end: 20, text: "本編" },
  { id: 3, start: 20, end: 30, text: "脱線" },
];

function baseCfg(): Config {
  return {
    ai: { provider: "anthropic", model: "claude-x" },
  } as Config;
}

function makeCtx(dir: string, overrides: Partial<AgenticCtx> = {}): AgenticCtx {
  return {
    dir,
    cfg: baseCfg(),
    numbered,
    budget: { maxToolCalls: 16, used: 0 },
    warn: () => {},
    trace: [],
    toolsEnabled: { frames: false, av: false, materials: false, ocr: false },
    applySplit: false,
    maxSplits: 4,
    splits: [],
    splitTrace: [],
    words: [],
    ...overrides,
  };
}

/** 型が長い completeAgentic のシグネチャに合わせた fake アダプタを作る */
function fakeAdapter(
  script: (
    request: AiAgenticRequest,
    handleTool: AiAgenticToolHandler,
  ) => Promise<AiAgenticResponse>,
): AiAdapter {
  return {
    kind: "anthropic",
    async complete() {
      throw new Error("not used in these tests");
    },
    async completeAgentic(request, _profile, _context, handleTool) {
      return script(request, handleTool);
    },
  };
}

function readCutplan(dir: string): CutPlan {
  return JSON.parse(readFileSync(join(dir, "cutplan.json"), "utf8")) as CutPlan;
}

test("agenticCutTurn: describe_timeline -> set_cuts -> 最終 cuts の往復", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir);
    const adapter = fakeAdapter(async (_req, handleTool) => {
      const described = await handleTool("describe_timeline", {});
      assert.match(described.text ?? "", /出力尺:/);
      const setResult = await handleTool("set_cuts", { cuts: [{ id: 3, reason: "脱線" }] });
      assert.match(setResult.text ?? "", /出力尺:/);
      assert.equal(setResult.isError, undefined);
      return {
        text: JSON.stringify({ cuts: [{ id: 3, reason: "脱線" }] }),
        toolCalls: 2,
        profile: "p",
        adapter: "anthropic",
        model: "claude-x",
      };
    });

    const result = await agenticCutTurn({
      firstPrompt: "prompt",
      ctx,
      adapterOverride: adapter,
    });

    assert.deepEqual(result.cuts, [{ id: 3, reason: "脱線" }]);
    assert.equal(result.degraded, null);
    assert.deepEqual(result.trace.map((t) => t.tool), ["describe_timeline", "set_cuts"]);
    // trace は生の args/text を含まず、短いダイジェスト(hex)だけを持つ(§H1H2design §1-7)
    for (const entry of result.trace) {
      assert.match(entry.argsDigest, /^[0-9a-f]{12}$/);
      assert.match(entry.resultDigest, /^[0-9a-f]{12}$/);
    }
    const cutplan = readCutplan(dir);
    assert.equal(cutplan.segments[2]!.action, "cut");
    assert.equal(cutplan.segments[2]!.reason, "脱線");
  });
});

test("agenticCutTurn: set_cuts に存在しない候補 id を渡すと拒否され、cutplan.json は書き換わらない", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir);
    const adapter = fakeAdapter(async (_req, handleTool) => {
      const rejected = await handleTool("set_cuts", { cuts: [{ id: 99, reason: "存在しない" }] });
      assert.equal(rejected.isError, true);
      assert.match(rejected.text ?? "", /拒否/);
      return {
        text: JSON.stringify({ cuts: [] }),
        toolCalls: 1,
        profile: "p",
        adapter: "anthropic",
        model: "claude-x",
      };
    });

    await agenticCutTurn({ firstPrompt: "prompt", ctx, adapterOverride: adapter });

    // ensureInitialCutplan が作った全 keep のまま(set_cuts の不正 id は反映されない)
    const cutplan = readCutplan(dir);
    assert.deepEqual(cutplan.segments.map((s) => s.action), ["keep", "keep", "keep"]);
  });
});

test("agenticCutTurn: maxToolCalls を使い切ると以降の tool 呼び出しは拒否され trace も増えない", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir, { budget: { maxToolCalls: 2, used: 0 } });
    const adapter = fakeAdapter(async (_req, handleTool) => {
      const first = await handleTool("describe_timeline", {});
      assert.equal(first.isError, undefined);
      const second = await handleTool("set_cuts", { cuts: [{ id: 2, reason: "本編カット" }] });
      assert.equal(second.isError, undefined);
      // ここから先は budget 超過(3件目・4件目)
      const third = await handleTool("describe_timeline", {});
      assert.equal(third.isError, true);
      assert.match(third.text ?? "", /上限/);
      const fourth = await handleTool("set_cuts", { cuts: [{ id: 1, reason: "別案" }] });
      assert.equal(fourth.isError, true);
      // モデルは budget 超過後、直前に成功した set_cuts(#2)の結果で最終回答する
      return {
        text: JSON.stringify({ cuts: [{ id: 2, reason: "本編カット" }] }),
        toolCalls: 4,
        profile: "p",
        adapter: "anthropic",
        model: "claude-x",
      };
    });

    const result = await agenticCutTurn({ firstPrompt: "prompt", ctx, adapterOverride: adapter });

    assert.deepEqual(result.cuts, [{ id: 2, reason: "本編カット" }]);
    // budget 超過分は実行されない(trace に積まれない・実際に書込みも起きない)
    assert.deepEqual(result.trace.map((t) => t.tool), ["describe_timeline", "set_cuts"]);
    const cutplan = readCutplan(dir);
    assert.equal(cutplan.segments[1]!.action, "cut");
    assert.equal(cutplan.segments[0]!.action, "keep");
  });
});

test("agenticCutTurn: completeAgentic 非対応アダプタでは fallback を使い、degraded を立てる", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir);
    const nonAgenticAdapter: AiAdapter = {
      kind: "claude-code",
      async complete() {
        throw new Error("not used");
      },
    };
    const result = await agenticCutTurn({
      firstPrompt: "prompt",
      ctx,
      adapterOverride: nonAgenticAdapter,
      fallbackOverride: async () => JSON.stringify({ cuts: [{ id: 1, reason: "fallback" }] }),
    });
    assert.deepEqual(result.cuts, [{ id: 1, reason: "fallback" }]);
    assert.equal(result.degraded, "adapter-not-agentic");
    assert.deepEqual(result.trace, []);
  });
});

test("agenticCutTurn: agentic ループが例外を投げても fallback して cuts を返す(例外を投げない)", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir);
    const throwingAdapter: AiAdapter = {
      kind: "anthropic",
      async complete() {
        throw new Error("not used");
      },
      async completeAgentic() {
        throw new Error("simulated provider error");
      },
    };
    let warned = "";
    ctx.warn = (msg) => {
      warned = msg;
    };
    const result = await agenticCutTurn({
      firstPrompt: "prompt",
      ctx,
      adapterOverride: throwingAdapter,
      fallbackOverride: async () => JSON.stringify({ cuts: [] }),
    });
    assert.deepEqual(result.cuts, []);
    assert.match(result.degraded ?? "", /simulated provider error/);
    assert.match(warned, /フォールバック/);
  });
});

test("agenticCutTurn: toolsEnabled=false の tool(get_frames 等)は登録されず未知 tool として拒否される", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir); // frames/av/materials/ocr は全て false
    const adapter = fakeAdapter(async (req, handleTool) => {
      const names = req.tools.map((t) => t.name);
      assert.deepEqual(names, ["describe_timeline", "set_cuts", "run_assert"]);
      const res = await handleTool("get_frames", { times: [1] });
      assert.equal(res.isError, true);
      assert.match(res.text ?? "", /未知の tool/);
      return { text: JSON.stringify({ cuts: [] }), toolCalls: 1, profile: "p", adapter: "anthropic", model: "claude-x" };
    });
    const result = await agenticCutTurn({ firstPrompt: "prompt", ctx, adapterOverride: adapter });
    assert.deepEqual(result.cuts, []);
  });
});

// --- H6(applySplit): 候補内部を語境界で分割する list_words/split_candidate ---
// §docs/plans/2026-07-11-h6-apply-hybrid-r0-breakthrough-design.md §4

test("agenticCutTurn: applySplit off では list_words/split_candidate はレジストリに現れない(SD4とバイト等価)", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir, { applySplit: false });
    const adapter = fakeAdapter(async (req, handleTool) => {
      const names = req.tools.map((t) => t.name);
      assert.deepEqual(names, ["describe_timeline", "set_cuts", "run_assert"]);
      const res = await handleTool("split_candidate", { id: 2, cutWordRanges: [{ i: 1, j: 1, reason: "x" }] });
      assert.equal(res.isError, true);
      assert.match(res.text ?? "", /未知の tool/);
      return { text: JSON.stringify({ cuts: [] }), toolCalls: 1, profile: "p", adapter: "anthropic", model: "claude-x" };
    });
    const result = await agenticCutTurn({ firstPrompt: "prompt", ctx, adapterOverride: adapter });
    assert.deepEqual(result.splits, []);
    assert.deepEqual(result.splitTrace, []);
  });
});

test("agenticCutTurn: list_words は候補内の語を1始まりindex付きで返し、words無し候補は分割不可を返す", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir, { applySplit: true, words: wordsForCandidate2() });
    const adapter = fakeAdapter(async (_req, handleTool) => {
      const withWords = await handleTool("list_words", { id: 2 });
      assert.match(withWords.text ?? "", /#2 の語\(全8語\)/);
      assert.match(withWords.text ?? "", /1 "語1"/);
      const noWords = await handleTool("list_words", { id: 3 });
      assert.match(noWords.text ?? "", /分割できません/);
      const missing = await handleTool("list_words", { id: 99 });
      assert.equal(missing.isError, true);
      return { text: JSON.stringify({ cuts: [] }), toolCalls: 3, profile: "p", adapter: "anthropic", model: "claude-x" };
    });
    await agenticCutTurn({ firstPrompt: "prompt", ctx, adapterOverride: adapter });
  });
});

test("agenticCutTurn: split_candidate 往復で候補内部に語境界の cut sub-segment が現れる(R0 突破の実証)", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir, { applySplit: true, words: wordsForCandidate2() });
    const adapter = fakeAdapter(async (_req, handleTool) => {
      const result = await handleTool("split_candidate", {
        id: 2,
        cutWordRanges: [{ i: 3, j: 5, reason: "言い直し" }],
      });
      assert.equal(result.isError, undefined);
      assert.match(result.text ?? "", /分割OK/);
      return {
        text: JSON.stringify({ cuts: [] }),
        toolCalls: 1,
        profile: "p",
        adapter: "anthropic",
        model: "claude-x",
      };
    });
    const result = await agenticCutTurn({ firstPrompt: "prompt", ctx, adapterOverride: adapter });
    assert.equal(result.splits.length, 1);
    assert.deepEqual(result.splits[0], {
      candidateId: 2,
      segStart: 10,
      segEnd: 20,
      cutWordRanges: [{ i: 3, j: 5, reason: "言い直し" }],
    });
    assert.deepEqual(result.splitTrace, [{ candidateId: 2, wordRanges: "3-5", accepted: true }]);
    const cutplan = readCutplan(dir);
    // 候補#2([10,20])が候補格子に無い語境界(11.9/14.9)で3分割されている
    assert.deepEqual(
      cutplan.segments.map((s) => [s.start, s.end, s.action]),
      [
        [0, 10, "keep"],
        [10, 11.9, "keep"],
        [11.9, 14.9, "cut"],
        [14.9, 20, "keep"],
        [20, 30, "keep"],
      ],
    );
  });
});

test("agenticCutTurn: split_candidate は存在しない語 index を拒否し cutplan.json を書き換えない(語粒度の安全網)", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir, { applySplit: true, words: wordsForCandidate2() });
    const adapter = fakeAdapter(async (_req, handleTool) => {
      const result = await handleTool("split_candidate", {
        id: 2,
        cutWordRanges: [{ i: 99, j: 100, reason: "存在しない" }],
      });
      assert.equal(result.isError, true);
      assert.match(result.text ?? "", /分割は却下/);
      return { text: JSON.stringify({ cuts: [] }), toolCalls: 1, profile: "p", adapter: "anthropic", model: "claude-x" };
    });
    const result = await agenticCutTurn({ firstPrompt: "prompt", ctx, adapterOverride: adapter });
    assert.deepEqual(result.splits, []);
    assert.equal(result.splitTrace.length, 1);
    assert.equal(result.splitTrace[0]!.candidateId, 2);
    assert.equal(result.splitTrace[0]!.wordRanges, "99-100");
    assert.equal(result.splitTrace[0]!.accepted, false);
    assert.match(result.splitTrace[0]!.check ?? "", /語 index が不正/);
    const cutplan = readCutplan(dir);
    assert.deepEqual(cutplan.segments.map((s) => s.action), ["keep", "keep", "keep"]);
  });
});

test("agenticCutTurn: split_candidate は validate/assert のエラーでロールバックする(部分書込みが残らない)", async () => {
  await withDir(async (dir) => {
    // materialExists は id-stamp 未実行のプロジェクトでは常に status:"error"
    // になる(id 解決不能)。分割そのものの正当性とは無関係にロールバックを誘発できる
    writeFileSync(
      join(dir, "assertions.json"),
      JSON.stringify({ schemaVersion: 1, assertions: [{ type: "materialExists", ref: "@mat_zzzzzz" }] }),
    );
    const ctx = makeCtx(dir, { applySplit: true, words: wordsForCandidate2() });
    const adapter = fakeAdapter(async (_req, handleTool) => {
      const before = readCutplan(dir);
      const result = await handleTool("split_candidate", {
        id: 2,
        cutWordRanges: [{ i: 3, j: 5, reason: "言い直し" }],
      });
      assert.equal(result.isError, true);
      assert.match(result.text ?? "", /ロールバック/);
      const after = readCutplan(dir);
      assert.deepEqual(after, before);
      return { text: JSON.stringify({ cuts: [] }), toolCalls: 1, profile: "p", adapter: "anthropic", model: "claude-x" };
    });
    const result = await agenticCutTurn({ firstPrompt: "prompt", ctx, adapterOverride: adapter });
    assert.deepEqual(result.splits, []);
    assert.equal(result.splitTrace[0]!.accepted, false);
    const cutplan = readCutplan(dir);
    assert.deepEqual(cutplan.segments.map((s) => s.action), ["keep", "keep", "keep"]);
  });
});

test("agenticCutTurn: split_candidate は maxSplits で有界(上限超過は拒否され ctx.splits は増えない)", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir, { applySplit: true, maxSplits: 1, words: wordsForCandidate2() });
    const adapter = fakeAdapter(async (_req, handleTool) => {
      const first = await handleTool("split_candidate", { id: 2, cutWordRanges: [{ i: 3, j: 5, reason: "1" }] });
      assert.equal(first.isError, undefined);
      const second = await handleTool("split_candidate", { id: 2, cutWordRanges: [{ i: 6, j: 7, reason: "2" }] });
      assert.equal(second.isError, true);
      assert.match(second.text ?? "", /上限/);
      return { text: JSON.stringify({ cuts: [] }), toolCalls: 2, profile: "p", adapter: "anthropic", model: "claude-x" };
    });
    const result = await agenticCutTurn({ firstPrompt: "prompt", ctx, adapterOverride: adapter });
    assert.equal(result.splits.length, 1);
  });
});

test("agenticCutTurn: words 皆無なら split_candidate は全て分割不可を返し候補単位のcutplanが完走する", async () => {
  await withDir(async (dir) => {
    const ctx = makeCtx(dir, { applySplit: true, words: [] });
    const adapter = fakeAdapter(async (_req, handleTool) => {
      const listed = await handleTool("list_words", { id: 2 });
      assert.match(listed.text ?? "", /分割できません/);
      const split = await handleTool("split_candidate", { id: 2, cutWordRanges: [{ i: 1, j: 1, reason: "x" }] });
      assert.equal(split.isError, true);
      assert.match(split.text ?? "", /語タイムスタンプがありません/);
      const setResult = await handleTool("set_cuts", { cuts: [{ id: 3, reason: "脱線" }] });
      assert.equal(setResult.isError, undefined);
      return {
        text: JSON.stringify({ cuts: [{ id: 3, reason: "脱線" }] }),
        toolCalls: 3,
        profile: "p",
        adapter: "anthropic",
        model: "claude-x",
      };
    });
    const result = await agenticCutTurn({ firstPrompt: "prompt", ctx, adapterOverride: adapter });
    assert.deepEqual(result.splits, []);
    assert.deepEqual(result.cuts, [{ id: 3, reason: "脱線" }]);
    const cutplan = readCutplan(dir);
    assert.deepEqual(cutplan.segments.map((s) => s.action), ["keep", "keep", "cut"]);
  });
});
