// src/lib/applyEdits.ts — 検査付きアトミック適用のコア。
// T1: compileOps(op 列 → 全置換パッチのコンパイラ)を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileOps } from "../src/lib/applyEdits.ts";
import type { LoadedDocs } from "../src/stages/validate.ts";
import type { EditOp } from "../src/types.ts";

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
