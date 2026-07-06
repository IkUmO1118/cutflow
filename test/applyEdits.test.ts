// src/lib/applyEdits.ts — 検査付きアトミック適用のコア。
// T1: compileOps(op 列 → 全置換パッチのコンパイラ)を固定する。
// T3: planApply(相1: 読むだけ・検査だけ)/ applyEdits(相2: backup→tmp/rename
// で全書き込み or ゼロ書き込み)を tmpdir で固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits, compileOps, planApply } from "../src/lib/applyEdits.ts";
import { ID_RE } from "../src/lib/ids.ts";
import type { LoadedDocs } from "../src/stages/validate.ts";
import type { ApplyPatch, EditOp } from "../src/types.ts";

const emptyDocs: LoadedDocs = {
  manifest: null,
  cutplan: null,
  transcript: null,
  overlays: null,
  bgm: null,
  chapters: null,
  meta: null,
  shorts: null,
  thumbnail: null,
};

function baseDocs(): LoadedDocs {
  return {
    ...emptyDocs,
    cutplan: {
      approved: false,
      segments: [
        { id: "seg_a1a1a1", start: 0, end: 10, action: "keep", reason: "本編" },
        { id: "seg_b2b2b2", start: 10, end: 20, action: "cut", reason: "言い直し" },
      ],
    },
    transcript: {
      segments: [
        { id: "cap_c3c3c3", start: 0, end: 1, text: "hi", style: { fontSizePx: 40 } },
      ],
    },
    overlays: {
      overlays: [{ id: "mat_d4d4d4", start: 0, end: 1, file: "a.png" }],
    },
    shorts: {
      shorts: [
        {
          name: "intro",
          approved: false,
          ranges: [{ id: "rg_e5e5e5", start: 0, end: 1 }],
        },
      ],
    },
  };
}

test("compileOps: set が @id 解決先の1フィールドだけ変える(他は不変)", () => {
  const docs = baseDocs();
  const ops: EditOp[] = [{ op: "set", target: "@seg_a1a1a1", field: "reason", value: "更新後" }];
  const { body, errors } = compileOps(docs, ops);
  assert.deepEqual(errors, []);
  assert.equal(body.cutplan!.segments[0].reason, "更新後");
  // 他フィールドは不変
  assert.equal(body.cutplan!.segments[0].start, 0);
  assert.equal(body.cutplan!.segments[0].action, "keep");
  assert.equal(body.cutplan!.segments[1].reason, "言い直し");
  // ドット区切りパス(ネスト末端の置換)
  const ops2: EditOp[] = [{ op: "set", target: "@cap_c3c3c3", field: "style.fontSizePx", value: 60 }];
  const { body: body2, errors: errors2 } = compileOps(docs, ops2);
  assert.deepEqual(errors2, []);
  assert.equal((body2.transcript!.segments[0].style as { fontSizePx: number }).fontSizePx, 60);
});

test("compileOps: remove が所属配列から抜く", () => {
  const docs = baseDocs();
  const ops: EditOp[] = [{ op: "remove", target: "@seg_b2b2b2" }];
  const { body, errors } = compileOps(docs, ops);
  assert.deepEqual(errors, []);
  assert.equal(body.cutplan!.segments.length, 1);
  assert.equal(body.cutplan!.segments[0].id, "seg_a1a1a1");
});

test("compileOps: add が allow-list 選択子へ append する(id 未採番のまま)", () => {
  const docs = baseDocs();
  const ops: EditOp[] = [
    { op: "add", target: "cutplan.segments", value: { start: 20, end: 30, action: "keep", reason: "新規" } },
  ];
  const { body, errors } = compileOps(docs, ops);
  assert.deepEqual(errors, []);
  assert.equal(body.cutplan!.segments.length, 3);
  const added = body.cutplan!.segments[2];
  assert.equal(added.start, 20);
  assert.equal((added as { id?: string }).id, undefined);
});

test("compileOps: add は at で挿入位置を指定できる(省略時は末尾)", () => {
  const docs = baseDocs();
  const ops: EditOp[] = [
    { op: "add", target: "cutplan.segments", value: { start: -1, end: 0, action: "cut", reason: "先頭" }, at: 0 },
  ];
  const { body, errors } = compileOps(docs, ops);
  assert.deepEqual(errors, []);
  assert.equal(body.cutplan!.segments[0].start, -1);
  assert.equal(body.cutplan!.segments.length, 3);
});

test("compileOps: 未解決の @id は (patch) file・ops[i].target where のエラーになる", () => {
  const docs = baseDocs();
  const ops: EditOp[] = [{ op: "set", target: "@cap_nope00", field: "text", value: "x" }];
  const { body, errors } = compileOps(docs, ops);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, "(patch)");
  assert.equal(errors[0].where, "ops[0].target");
  assert.ok(errors[0].message.includes("@cap_nope00"));
  assert.deepEqual(body, {});
});

test("compileOps: 未知の op はエラー", () => {
  const docs = baseDocs();
  const ops = [{ op: "cut", target: "@seg_a1a1a1" }] as unknown as EditOp[];
  const { errors } = compileOps(docs, ops);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].where, "ops[0].op");
});

test("compileOps: add の allow-list 外の選択子はエラー", () => {
  const docs = baseDocs();
  const ops: EditOp[] = [{ op: "add", target: "shorts.shorts", value: { name: "x", approved: false, ranges: [] } }];
  const { errors } = compileOps(docs, ops);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].where, "ops[0].target");
});

test("compileOps: set の field パスの中間が存在しなければエラー(勝手に作らない)", () => {
  const docs = baseDocs();
  // segments[0] には karaoke オブジェクトが無い
  const ops: EditOp[] = [{ op: "set", target: "@seg_a1a1a1", field: "sub.deep", value: 1 }];
  const { errors } = compileOps(docs, ops);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.includes("中間パスがありません"));
});

test("compileOps: 配列添字パス(words[0])はエラー", () => {
  const docs = baseDocs();
  const ops: EditOp[] = [{ op: "set", target: "@cap_c3c3c3", field: "words[0].text", value: "x" }];
  const { errors } = compileOps(docs, ops);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].where, "ops[0].field");
});

test("compileOps: set で approved を指すとエラー(cutplan・short どちらも)", () => {
  const docs = baseDocs();
  // short 自体(@intro)の approved を触ろうとする
  const ops: EditOp[] = [{ op: "set", target: "@intro", field: "approved", value: true }];
  const { errors, body } = compileOps(docs, ops);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.includes("approved"));
  assert.deepEqual(body, {});
});

test("compileOps: add の value に approved を含めるとエラー", () => {
  const docs = baseDocs();
  const ops: EditOp[] = [
    { op: "add", target: "cutplan.segments", value: { start: 20, end: 30, action: "keep", reason: "x", approved: true } },
  ];
  const { errors } = compileOps(docs, ops);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.includes("approved"));
});

test("compileOps: shorts 配下(ranges)への set/remove は対象外(replace に委ねる)", () => {
  const docs = baseDocs();
  const ops: EditOp[] = [{ op: "set", target: "@rg_e5e5e5", field: "start", value: 5 }];
  const { errors } = compileOps(docs, ops);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.includes("replace"));
});

test("compileOps: 未触の docs は元 docs を変更しない(呼び出し側の docs は不変)", () => {
  const docs = baseDocs();
  const before = JSON.stringify(docs);
  compileOps(docs, [{ op: "set", target: "@seg_a1a1a1", field: "reason", value: "変更" }]);
  assert.equal(JSON.stringify(docs), before);
});

test("compileOps: 触っていないファイルは body に含まれない", () => {
  const docs = baseDocs();
  const { body } = compileOps(docs, [{ op: "set", target: "@seg_a1a1a1", field: "reason", value: "x" }]);
  assert.ok("cutplan" in body);
  assert.ok(!("transcript" in body));
  assert.ok(!("overlays" in body));
  assert.ok(!("shorts" in body));
});

test("compileOps: ops が空なら body も空(no-op)", () => {
  const docs = baseDocs();
  const { body, errors, diff } = compileOps(docs, []);
  assert.deepEqual(body, {});
  assert.deepEqual(errors, []);
  assert.deepEqual(diff, []);
});

/* ---------------- T3: planApply / applyEdits ---------------- */

function withTmpProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-applyedits-test-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
    write("manifest.json", { durationSec: 100 });
    write("cutplan.json", {
      approved: false,
      segments: [
        { id: "seg_a1a1a1", start: 0, end: 10, action: "keep", reason: "本編" },
        { id: "seg_b2b2b2", start: 10, end: 20, action: "cut", reason: "言い直し" },
      ],
    });
    write("transcript.json", { segments: [{ id: "cap_c3c3c3", start: 1, end: 3, text: "こんにちは" }] });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readRaw(dir: string, file: string): string {
  return readFileSync(join(dir, file), "utf8");
}

function backupsDirExists(dir: string): boolean {
  try {
    return readdirSync(join(dir, "backups")).length > 0;
  } catch {
    return false;
  }
}

test("planApply: 相1は fs へ read しか行わない(errors があっても書かない)", () => {
  withTmpProject((dir) => {
    const beforeCutplan = readRaw(dir, "cutplan.json");
    const beforeMtime = statSync(join(dir, "cutplan.json")).mtimeMs;
    const patch: ApplyPatch = { ops: [{ op: "set", target: "@seg_nope00", field: "reason", value: "x" }] };
    const plan = planApply(dir, patch);
    assert.ok(plan.errors.length > 0);
    assert.equal(readRaw(dir, "cutplan.json"), beforeCutplan);
    assert.equal(statSync(join(dir, "cutplan.json")).mtimeMs, beforeMtime);
    assert.ok(!backupsDirExists(dir));
  });
});

test("applyEdits: エラーを含むパッチは written が空・ディスクの全ファイルが1バイトも変わらない", () => {
  withTmpProject((dir) => {
    const beforeCutplan = readRaw(dir, "cutplan.json");
    const beforeTranscript = readRaw(dir, "transcript.json");
    const patch: ApplyPatch = { ops: [{ op: "set", target: "@seg_nope00", field: "reason", value: "x" }] };
    const result = applyEdits(dir, patch);
    assert.deepEqual(result.written, []);
    assert.equal(result.backupDir, null);
    assert.equal(readRaw(dir, "cutplan.json"), beforeCutplan);
    assert.equal(readRaw(dir, "transcript.json"), beforeTranscript);
    assert.ok(!backupsDirExists(dir));
  });
});

test("applyEdits: no-op パッチ(空)は backup も書き込みも起こさない", () => {
  withTmpProject((dir) => {
    const result = applyEdits(dir, {});
    assert.deepEqual(result.written, []);
    assert.equal(result.backupDir, null);
    assert.ok(!backupsDirExists(dir));
  });
});

test("applyEdits: 成功時は changedFiles(変更のあるファイル)だけが書かれ、他は不変", () => {
  withTmpProject((dir) => {
    const beforeTranscript = readRaw(dir, "transcript.json");
    const patch: ApplyPatch = { ops: [{ op: "set", target: "@seg_a1a1a1", field: "reason", value: "更新後" }] };
    const result = applyEdits(dir, patch);
    assert.deepEqual(result.written, ["cutplan.json"]);
    assert.ok(result.backupDir !== null);
    assert.ok(backupsDirExists(dir));
    const cutplan = JSON.parse(readRaw(dir, "cutplan.json"));
    assert.equal(cutplan.segments[0].reason, "更新後");
    // transcript.json は触っていないので不変
    assert.equal(readRaw(dir, "transcript.json"), beforeTranscript);
  });
});

test("applyEdits: replace.cutplan.approved をディスクと変えても approved は反転できない(エラーで拒否・未書き込み)", () => {
  withTmpProject((dir) => {
    const beforeCutplan = readRaw(dir, "cutplan.json");
    const patch: ApplyPatch = {
      replace: {
        cutplan: {
          approved: true,
          segments: [
            { id: "seg_a1a1a1", start: 0, end: 10, action: "keep", reason: "本編" },
            { id: "seg_b2b2b2", start: 10, end: 20, action: "cut", reason: "言い直し" },
          ],
        },
      },
    };
    const plan = planApply(dir, patch);
    assert.ok(plan.errors.some((e) => e.file === "cutplan.json" && e.where === "approved"));
    const result = applyEdits(dir, patch);
    assert.deepEqual(result.written, []);
    assert.equal(readRaw(dir, "cutplan.json"), beforeCutplan);
  });
});

test("applyEdits: ops で cutplan の他フィールドを編集しても approved は disk 値のまま書かれる", () => {
  withTmpProject((dir) => {
    const patch: ApplyPatch = { ops: [{ op: "set", target: "@seg_a1a1a1", field: "reason", value: "更新後" }] };
    const result = applyEdits(dir, patch);
    assert.deepEqual(result.written, ["cutplan.json"]);
    const cutplan = JSON.parse(readRaw(dir, "cutplan.json"));
    assert.equal(cutplan.approved, false); // disk の元値のまま
  });
});

test("applyEdits: set で approved を狙っても書けない(cutplan/short 両方)", () => {
  withTmpProject((dir) => {
    writeFileSync(
      join(dir, "shorts.json"),
      JSON.stringify({ shorts: [{ name: "s1", approved: false, ranges: [{ id: "rg_z9z9z9", start: 0, end: 1 }] }] }),
    );
    const patch: ApplyPatch = { ops: [{ op: "set", target: "@intro", field: "approved", value: true }] };
    // @intro は存在しない(name は s1)ので、まず未解決 target のエラーになる
    const plan = planApply(dir, patch);
    assert.ok(plan.errors.length > 0);
  });
});

test("applyEdits: applyEdits は approvals.json を作らない・変えない", () => {
  withTmpProject((dir) => {
    const patch: ApplyPatch = { ops: [{ op: "set", target: "@seg_a1a1a1", field: "reason", value: "x" }] };
    applyEdits(dir, patch);
    assert.throws(() => statSync(join(dir, "approvals.json")));
  });
});

test("applyEdits: bgm を replace で null にすると bgm.json を削除する", () => {
  withTmpProject((dir) => {
    writeFileSync(join(dir, "bgm.json"), JSON.stringify({ tracks: [{ start: 0, end: 1, file: "bgm.mp3" }] }));
    const result = applyEdits(dir, { replace: { bgm: null } });
    assert.deepEqual(result.written, ["bgm.json"]);
    assert.throws(() => statSync(join(dir, "bgm.json")));
  });
});

test("applyEdits: id 有効プロジェクトでは add した新規要素に id を採番する", () => {
  withTmpProject((dir) => {
    // cutplan に既存 id がある = id 有効プロジェクト
    const patch: ApplyPatch = {
      ops: [{ op: "add", target: "cutplan.segments", value: { start: 20, end: 30, action: "keep", reason: "新規" } }],
    };
    const result = applyEdits(dir, patch);
    assert.deepEqual(result.written, ["cutplan.json"]);
    const cutplan = JSON.parse(readRaw(dir, "cutplan.json"));
    assert.match(cutplan.segments[2].id, ID_RE);
    // 既存 id は不変
    assert.equal(cutplan.segments[0].id, "seg_a1a1a1");
  });
});

test("applyEdits: id が1つも無いプロジェクトでは add した新規要素に id を振らない(opt-in)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-applyedits-noid-test-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
    write("manifest.json", { durationSec: 100 });
    write("cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 10, action: "keep", reason: "本編" }],
    });
    write("transcript.json", { segments: [{ start: 1, end: 3, text: "こんにちは" }] });
    const patch: ApplyPatch = {
      ops: [{ op: "add", target: "cutplan.segments", value: { start: 20, end: 30, action: "keep", reason: "新規" } }],
    };
    const result = applyEdits(dir, patch);
    assert.deepEqual(result.written, ["cutplan.json"]);
    const cutplan = JSON.parse(readRaw(dir, "cutplan.json"));
    assert.equal(cutplan.segments[1].id, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planApply --dry-run 相当: 不変条件違反(keep 重なり)は書き込み前に検出される", () => {
  withTmpProject((dir) => {
    const patch: ApplyPatch = {
      ops: [{ op: "set", target: "@seg_b2b2b2", field: "action", value: "keep" }],
    };
    // seg_b2b2b2 を keep にすると seg_a1a1a1(0-10)と重なりなし(10-20 は隣接、重ならない)
    const plan = planApply(dir, patch);
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.changedFiles.length, 1);
  });
});

test("planApply: diff に @id 単位の変更(set/remove/add)が積まれる", () => {
  withTmpProject((dir) => {
    const patch: ApplyPatch = {
      ops: [{ op: "set", target: "@seg_a1a1a1", field: "reason", value: "更新後" }],
    };
    const plan = planApply(dir, patch);
    assert.equal(plan.diff.length, 1);
    assert.equal(plan.diff[0].ref, "@seg_a1a1a1");
    assert.equal(plan.diff[0].before, "本編");
    assert.equal(plan.diff[0].after, "更新後");
  });
});
