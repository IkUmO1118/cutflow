// lib/approval.ts — 承認ハッシュ(cutplan/short の keep 集合に束縛)と
// レコード I/O(approvals.json)を固定する。ここが render の唯一のゲート
// (isCutplanApproved / isShortApproved)になるので、事故A(生の boolean
// approved:true が render を通す)・事故B(承認後の編集で古い内容が render
// される)を確実に潰せているかを主眼に検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCutplanApproval,
  clearShortApproval,
  cutplanApprovalHash,
  isCutplanApproved,
  isShortApproved,
  readApprovals,
  shortApprovalHash,
  writeCutplanApproval,
  writeShortApproval,
} from "../src/lib/approval.ts";
import type { CutPlan, Short } from "../src/types.ts";

function cutplanOf(segments: CutPlan["segments"]): CutPlan {
  return { approved: false, segments };
}

const BASE_SEGMENTS: CutPlan["segments"] = [
  { start: 0, end: 5, action: "cut", reason: "頭出し" },
  { start: 5, end: 10, action: "keep", reason: "" },
  { start: 10, end: 12, action: "cut", reason: "言い直し" },
  { start: 12, end: 20, action: "keep", reason: "" },
];

/* ---------------- 純ハッシュ関数 ---------------- */

test("cutplanApprovalHash: 同一 keep 集合 → 同一 hash", () => {
  const a = cutplanApprovalHash(cutplanOf(BASE_SEGMENTS));
  const b = cutplanApprovalHash(cutplanOf(BASE_SEGMENTS.map((s) => ({ ...s }))));
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test("cutplanApprovalHash: cut 境界を動かす(keep の範囲が変わる)と hash 変化", () => {
  const a = cutplanApprovalHash(cutplanOf(BASE_SEGMENTS));
  const moved = BASE_SEGMENTS.map((s) =>
    s.start === 5 && s.end === 10 ? { ...s, end: 10.5 } : s,
  );
  const b = cutplanApprovalHash(cutplanOf(moved));
  assert.notEqual(a, b);
});

test("cutplanApprovalHash: reason だけの変更は hash 不変", () => {
  const a = cutplanApprovalHash(cutplanOf(BASE_SEGMENTS));
  const changed = BASE_SEGMENTS.map((s) =>
    s.action === "keep" ? { ...s, reason: "書き換えた説明" } : { ...s, reason: "別の説明" },
  );
  const b = cutplanApprovalHash(cutplanOf(changed));
  assert.equal(a, b);
});

test("cutplanApprovalHash: cut セグメントの有無は hash に影響しない", () => {
  const withCuts = cutplanApprovalHash(cutplanOf(BASE_SEGMENTS));
  const keepsOnly = cutplanApprovalHash(
    cutplanOf(BASE_SEGMENTS.filter((s) => s.action === "keep")),
  );
  assert.equal(withCuts, keepsOnly);
});

test("cutplanApprovalHash: 同じ境界のまま分割(GUI の分割編集)しても hash 不変", () => {
  const a = cutplanApprovalHash(cutplanOf(BASE_SEGMENTS));
  const split = BASE_SEGMENTS.flatMap((s) =>
    s.start === 12 && s.end === 20
      ? [
          { start: 12, end: 16, action: "keep" as const, reason: "前半" },
          { start: 16, end: 20, action: "keep" as const, reason: "後半" },
        ]
      : [s],
  );
  const b = cutplanApprovalHash(cutplanOf(split));
  assert.equal(a, b);
});

test("cutplanApprovalHash: ms 未満の浮動小数ジッタは吸収される", () => {
  const a = cutplanApprovalHash(cutplanOf(BASE_SEGMENTS));
  const jittered = BASE_SEGMENTS.map((s) => ({
    ...s,
    start: s.start + 1e-9,
    end: s.end - 1e-9,
  }));
  const b = cutplanApprovalHash(cutplanOf(jittered));
  assert.equal(a, b);
});

test("cutplanApprovalHash: speed 1 だけなら旧 hash と互換", () => {
  const a = cutplanApprovalHash(cutplanOf(BASE_SEGMENTS));
  const b = cutplanApprovalHash(cutplanOf(
    BASE_SEGMENTS.map((s) => (s.action === "keep" ? { ...s, speed: 1 } : s)),
  ));
  assert.equal(a, b);
});

test("cutplanApprovalHash: speed が変わると hash も変わる", () => {
  const a = cutplanApprovalHash(cutplanOf(BASE_SEGMENTS));
  const b = cutplanApprovalHash(cutplanOf(
    BASE_SEGMENTS.map((s) =>
      s.action === "keep" && s.start === 12 ? { ...s, speed: 2 } : s,
    ),
  ));
  assert.notEqual(a, b);
});

function shortOf(overrides: Partial<Short> = {}): Short {
  return {
    name: "clip-1",
    approved: false,
    ranges: [{ start: 100, end: 110 }],
    ...overrides,
  };
}

test("shortApprovalHash: 同一 ranges/profile → 同一 hash", () => {
  const a = shortApprovalHash(shortOf());
  const b = shortApprovalHash(shortOf());
  assert.equal(a, b);
});

test("shortApprovalHash: profile を変えると hash 変化", () => {
  const a = shortApprovalHash(shortOf({ profile: "vertical" }));
  const b = shortApprovalHash(shortOf({ profile: "vertical-cover" }));
  assert.notEqual(a, b);
});

test("shortApprovalHash: name(rename)は hash に影響しない", () => {
  const a = shortApprovalHash(shortOf({ name: "clip-1" }));
  const b = shortApprovalHash(shortOf({ name: "clip-renamed" }));
  assert.equal(a, b);
});

test("shortApprovalHash: ranges が変わると hash 変化", () => {
  const a = shortApprovalHash(shortOf());
  const b = shortApprovalHash(shortOf({ ranges: [{ start: 100, end: 111 }] }));
  assert.notEqual(a, b);
});

/* ---------------- fs I/O + ゲート判定 ---------------- */

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-approval-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("isCutplanApproved: レコード無しは未承認(事故A: 生の approved:true だけでは通らない)", () => {
  withTmpDir((dir) => {
    const cutplan = cutplanOf(BASE_SEGMENTS);
    const gate = isCutplanApproved(dir, cutplan);
    assert.equal(gate.ok, false);
    assert.match(gate.reason ?? "", /レコードがありません|未承認/);
  });
});

test("writeCutplanApproval → isCutplanApproved: hash 一致で承認される", () => {
  withTmpDir((dir) => {
    const cutplan = cutplanOf(BASE_SEGMENTS);
    writeCutplanApproval(dir, cutplan, "cli");
    const gate = isCutplanApproved(dir, cutplan);
    assert.equal(gate.ok, true);
    const approvals = readApprovals(dir);
    assert.equal(approvals.cutplan?.hash, cutplanApprovalHash(cutplan));
    assert.equal(approvals.cutplan?.by, "cli");
  });
});

test("承認後に keep を編集すると hash 不一致で自動失効(事故B)", () => {
  withTmpDir((dir) => {
    const cutplan = cutplanOf(BASE_SEGMENTS);
    writeCutplanApproval(dir, cutplan, "cli");
    const edited = cutplanOf(
      BASE_SEGMENTS.map((s) => (s.action === "keep" && s.start === 5 ? { ...s, end: 9 } : s)),
    );
    const gate = isCutplanApproved(dir, edited);
    assert.equal(gate.ok, false);
    assert.match(gate.reason ?? "", /失効/);
  });
});

test("clearCutplanApproval: レコードを消すと再び未承認になる", () => {
  withTmpDir((dir) => {
    const cutplan = cutplanOf(BASE_SEGMENTS);
    writeCutplanApproval(dir, cutplan, "cli");
    clearCutplanApproval(dir);
    assert.equal(isCutplanApproved(dir, cutplan).ok, false);
    assert.equal(readApprovals(dir).cutplan, undefined);
  });
});

test("isShortApproved: name 別にレコードを持つ(他のショートに影響しない)", () => {
  withTmpDir((dir) => {
    const a = shortOf({ name: "a" });
    const b = shortOf({ name: "b", ranges: [{ start: 200, end: 210 }] });
    writeShortApproval(dir, a, "gui");
    assert.equal(isShortApproved(dir, a).ok, true);
    assert.equal(isShortApproved(dir, b).ok, false);
  });
});

test("clearShortApproval: 該当 name だけ消え、他のショートは残る", () => {
  withTmpDir((dir) => {
    const a = shortOf({ name: "a" });
    const b = shortOf({ name: "b", ranges: [{ start: 200, end: 210 }] });
    writeShortApproval(dir, a, "gui");
    writeShortApproval(dir, b, "gui");
    clearShortApproval(dir, "a");
    assert.equal(isShortApproved(dir, a).ok, false);
    assert.equal(isShortApproved(dir, b).ok, true);
  });
});

test("readApprovals: ファイルが無ければ version:1 のみの空レコード", () => {
  withTmpDir((dir) => {
    const approvals = readApprovals(dir);
    assert.deepEqual(approvals, { version: 1 });
  });
});
