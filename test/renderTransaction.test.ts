// lib/renderTransaction.ts — §8.4 render 完成物の transaction 公開。
// 純関数(tempPathFor/inputsDrifted)とオーケストレータ(publishAsTransaction)を
// fake の statFn/renameFn/rmFn で検証する(実 ffmpeg/fs I/O 不要)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureSnapshot,
  inputsDrifted,
  publishAsTransaction,
  tempPathFor,
} from "../src/lib/renderTransaction.ts";
import type { InputSnapshot, VerifyOutcome } from "../src/lib/renderTransaction.ts";

test("tempPathFor: dirname(finalPath) 直下・ドット始まり・pid を含む・.mp4 末尾", () => {
  const p = tempPathFor("/rec/dir/final.mp4", 12345);
  assert.equal(p, "/rec/dir/.final.mp4.publish-12345.tmp.mp4");
  assert.ok(p.startsWith("/rec/dir/"), "dirname 直下");
  assert.ok(p.split("/").pop()!.startsWith("."), "basename がドット始まり(隠しファイル)");
  assert.ok(p.includes("12345"), "pid を含む");
  assert.ok(p.endsWith(".mp4"), ".mp4 末尾");
});

test("tempPathFor: 異なる finalPath で異なる temp path", () => {
  const a = tempPathFor("/rec/dir/final.mp4", 1);
  const b = tempPathFor("/rec/dir/shorts/x.mp4", 1);
  assert.notEqual(a, b);
});

test("tempPathFor: 異なる pid で異なる temp path(同じ finalPath)", () => {
  const a = tempPathFor("/rec/dir/final.mp4", 1);
  const b = tempPathFor("/rec/dir/final.mp4", 2);
  assert.notEqual(a, b);
});

test("inputsDrifted: 全一致なら drift なし", () => {
  const snaps: InputSnapshot[] = [
    { path: "/a", mtimeMs: 100, size: 10 },
    { path: "/b", mtimeMs: 200, size: 20 },
  ];
  const stat = (p: string) =>
    p === "/a" ? { mtimeMs: 100, size: 10 } : { mtimeMs: 200, size: 20 };
  assert.deepEqual(inputsDrifted(snaps, stat), { drifted: false });
});

test("inputsDrifted: 空配列は drift なし", () => {
  assert.deepEqual(inputsDrifted([], () => null), { drifted: false });
});

test("inputsDrifted: size 変化で drift(path 込み)", () => {
  const snaps: InputSnapshot[] = [{ path: "/a", mtimeMs: 100, size: 10 }];
  const stat = () => ({ mtimeMs: 100, size: 999 });
  const result = inputsDrifted(snaps, stat);
  assert.equal(result.drifted, true);
  assert.ok(result.drifted && result.path === "/a");
});

test("inputsDrifted: mtimeMs 変化で drift", () => {
  const snaps: InputSnapshot[] = [{ path: "/a", mtimeMs: 100, size: 10 }];
  const stat = () => ({ mtimeMs: 999, size: 10 });
  const result = inputsDrifted(snaps, stat);
  assert.equal(result.drifted, true);
  assert.ok(result.drifted && result.path === "/a");
});

test("inputsDrifted: statFn が null(欠落)で drift", () => {
  const snaps: InputSnapshot[] = [{ path: "/a", mtimeMs: 100, size: 10 }];
  const result = inputsDrifted(snaps, () => null);
  assert.equal(result.drifted, true);
  assert.ok(result.drifted && result.path === "/a");
});

test("captureSnapshot: statFn の結果を path 付きで返す", () => {
  const snap = captureSnapshot("/a", () => ({ mtimeMs: 1, size: 2 }));
  assert.deepEqual(snap, { path: "/a", mtimeMs: 1, size: 2 });
});

test("captureSnapshot: 欠落パスは例外", () => {
  assert.throws(() => captureSnapshot("/missing", () => null));
});

/** publishAsTransaction の呼び出し順・分岐を fake で検証するヘルパ */
function makeFakes(overrides: {
  verifyResult?: VerifyOutcome;
  produceThrows?: boolean;
  renameThrows?: boolean;
  driftedStat?: boolean;
} = {}) {
  const calls: string[] = [];
  const produce = async (tmp: string) => {
    calls.push(`produce:${tmp}`);
    if (overrides.produceThrows) throw new Error("produce failed");
  };
  const verify = async (tmp: string): Promise<VerifyOutcome> => {
    calls.push(`verify:${tmp}`);
    return overrides.verifyResult ?? { ok: true };
  };
  const statFn = (path: string) => {
    calls.push(`stat:${path}`);
    return overrides.driftedStat
      ? { mtimeMs: 999, size: 999 }
      : { mtimeMs: 1, size: 1 };
  };
  const renameFn = (from: string, to: string) => {
    calls.push(`rename:${from}->${to}`);
    if (overrides.renameThrows) throw new Error("rename failed");
  };
  const rmFn = (path: string) => {
    calls.push(`rm:${path}`);
  };
  const commit = () => {
    calls.push("commit");
  };
  return { calls, produce, verify, statFn, renameFn, rmFn, commit };
}

test("publishAsTransaction: happy path は produce→verify→rename→commit の順、rm は1回", async () => {
  const fakes = makeFakes();
  await publishAsTransaction({
    finalPath: "/dir/final.mp4",
    inputs: [{ path: "/dir/cut.mp4", mtimeMs: 1, size: 1 }],
    produce: fakes.produce,
    verify: fakes.verify,
    commit: fakes.commit,
    statFn: fakes.statFn,
    renameFn: fakes.renameFn,
    rmFn: fakes.rmFn,
    pid: 42,
  });
  const temp = tempPathFor("/dir/final.mp4", 42);
  assert.deepEqual(fakes.calls, [
    `produce:${temp}`,
    `verify:${temp}`,
    "stat:/dir/cut.mp4",
    `rename:${temp}->/dir/final.mp4`,
    "commit",
    `rm:${temp}`,
  ]);
  const rmCount = fakes.calls.filter((c) => c.startsWith("rm:")).length;
  assert.equal(rmCount, 1, "rm は temp 1回だけ");
});

test("publishAsTransaction: verify 失敗で throw、rename/commit は呼ばれず rm は呼ばれる", async () => {
  const fakes = makeFakes({ verifyResult: { ok: false, reason: "壊れている" } });
  await assert.rejects(
    publishAsTransaction({
      finalPath: "/dir/final.mp4",
      inputs: [],
      produce: fakes.produce,
      verify: fakes.verify,
      commit: fakes.commit,
      statFn: fakes.statFn,
      renameFn: fakes.renameFn,
      rmFn: fakes.rmFn,
      pid: 1,
    }),
    /検証に失敗/,
  );
  assert.ok(!fakes.calls.some((c) => c.startsWith("rename:")), "rename は呼ばれない");
  assert.ok(!fakes.calls.includes("commit"), "commit は呼ばれない");
  assert.ok(fakes.calls.some((c) => c.startsWith("rm:")), "rm は呼ばれる");
});

test("publishAsTransaction: produce が throw したら rename/commit は呼ばれず rm は呼ばれる", async () => {
  const fakes = makeFakes({ produceThrows: true });
  await assert.rejects(
    publishAsTransaction({
      finalPath: "/dir/final.mp4",
      inputs: [],
      produce: fakes.produce,
      verify: fakes.verify,
      commit: fakes.commit,
      statFn: fakes.statFn,
      renameFn: fakes.renameFn,
      rmFn: fakes.rmFn,
      pid: 1,
    }),
    /produce failed/,
  );
  assert.ok(!fakes.calls.some((c) => c.startsWith("verify:")), "verify は呼ばれない");
  assert.ok(!fakes.calls.some((c) => c.startsWith("rename:")), "rename は呼ばれない");
  assert.ok(!fakes.calls.includes("commit"), "commit は呼ばれない");
  assert.ok(fakes.calls.some((c) => c.startsWith("rm:")), "rm は呼ばれる");
});

test("publishAsTransaction: 入力 drift を検出したら throw、rename/commit は呼ばれず rm は呼ばれる", async () => {
  const fakes = makeFakes({ driftedStat: true });
  await assert.rejects(
    publishAsTransaction({
      finalPath: "/dir/final.mp4",
      inputs: [{ path: "/dir/cut.mp4", mtimeMs: 1, size: 1 }],
      produce: fakes.produce,
      verify: fakes.verify,
      commit: fakes.commit,
      statFn: fakes.statFn,
      renameFn: fakes.renameFn,
      rmFn: fakes.rmFn,
      pid: 1,
    }),
    /入力ファイルが変化しました/,
  );
  assert.ok(!fakes.calls.some((c) => c.startsWith("rename:")), "rename は呼ばれない");
  assert.ok(!fakes.calls.includes("commit"), "commit は呼ばれない");
  assert.ok(fakes.calls.some((c) => c.startsWith("rm:")), "rm は呼ばれる");
});

test("publishAsTransaction: rename が throw したら commit は実行されず rm は呼ばれる", async () => {
  const fakes = makeFakes({ renameThrows: true });
  await assert.rejects(
    publishAsTransaction({
      finalPath: "/dir/final.mp4",
      inputs: [],
      produce: fakes.produce,
      verify: fakes.verify,
      commit: fakes.commit,
      statFn: fakes.statFn,
      renameFn: fakes.renameFn,
      rmFn: fakes.rmFn,
      pid: 1,
    }),
    /rename failed/,
  );
  assert.ok(fakes.calls.some((c) => c.startsWith("rename:")), "rename は呼ばれた");
  assert.ok(!fakes.calls.includes("commit"), "commit は呼ばれない");
  assert.ok(fakes.calls.some((c) => c.startsWith("rm:")), "rm は呼ばれる(finally)");
});

test("publishAsTransaction: finally の cleanup は全分岐で走る(rm 常に呼ばれる)", async () => {
  for (const overrides of [
    {},
    { verifyResult: { ok: false, reason: "x" } as VerifyOutcome },
    { produceThrows: true },
    { driftedStat: true },
    { renameThrows: true },
  ]) {
    const fakes = makeFakes(overrides);
    await publishAsTransaction({
      finalPath: "/dir/final.mp4",
      inputs: overrides.driftedStat ? [{ path: "/dir/cut.mp4", mtimeMs: 1, size: 1 }] : [],
      produce: fakes.produce,
      verify: fakes.verify,
      commit: fakes.commit,
      statFn: fakes.statFn,
      renameFn: fakes.renameFn,
      rmFn: fakes.rmFn,
      pid: 1,
    }).catch(() => {});
    assert.ok(fakes.calls.some((c) => c.startsWith("rm:")), `rm が呼ばれる: ${JSON.stringify(overrides)}`);
  }
});

test("publishAsTransaction: commit を省略しても成功する", async () => {
  const fakes = makeFakes();
  await publishAsTransaction({
    finalPath: "/dir/final.mp4",
    inputs: [],
    produce: fakes.produce,
    verify: fakes.verify,
    statFn: fakes.statFn,
    renameFn: fakes.renameFn,
    rmFn: fakes.rmFn,
    pid: 1,
  });
  assert.ok(fakes.calls.some((c) => c.startsWith("rename:")), "rename は呼ばれる");
  assert.ok(!fakes.calls.includes("commit"), "commit fake 自体は使っていない");
});
