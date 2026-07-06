// editor/client/toastReducer.ts — トースト・キューの純関数リデューサを固定する。
// 追加 / ttl 期限切れ(注入した now)/ in-place 更新 / 削除 / 最大5件超過の
// 最古落とし。タイマー本体は useToasts が持つので、ここは時刻を注入して検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toastReducer,
  MAX_TOASTS,
  type Toast,
  type ToastEvent,
} from "../editor/client/toastReducer.ts";

function run(state: Toast[], events: ToastEvent[]): Toast[] {
  return events.reduce(toastReducer, state);
}

function mk(id: string, extra: Partial<Toast> = {}): Toast {
  return { id, kind: "info", message: id, ...extra };
}

test("add: expiresAt は now + ttlMs、ttlMs 無しは undefined", () => {
  const s = run([], [
    { type: "add", toast: mk("a", { ttlMs: 4000 }), now: 1000 },
    { type: "add", toast: mk("b"), now: 1000 }, // error/progress 相当(sticky)
  ]);
  assert.equal(s.length, 2);
  assert.equal(s[0].expiresAt, 5000);
  assert.equal(s[1].expiresAt, undefined);
});

test("add: 新しいものは末尾(隅側)に積む", () => {
  const s = run([], [
    { type: "add", toast: mk("a"), now: 0 },
    { type: "add", toast: mk("b"), now: 0 },
  ]);
  assert.deepEqual(s.map((t) => t.id), ["a", "b"]);
});

test("expire: expiresAt <= now のトーストだけ落とす(sticky は残る)", () => {
  const s0 = run([], [
    { type: "add", toast: mk("a", { ttlMs: 4000 }), now: 1000 }, // expiresAt 5000
    { type: "add", toast: mk("b"), now: 1000 }, // sticky
    { type: "add", toast: mk("c", { ttlMs: 6000 }), now: 1000 }, // expiresAt 7000
  ]);
  // ちょうど期限の a は落ち、まだ先の c と sticky の b は残る
  const s = toastReducer(s0, { type: "expire", now: 5000 });
  assert.deepEqual(s.map((t) => t.id), ["b", "c"]);
});

test("update: 該当 id をその場で書き換える(積み位置は不変)", () => {
  const s0 = run([], [
    { type: "add", toast: mk("a"), now: 0 },
    { type: "add", toast: mk("b"), now: 0 },
  ]);
  const s = toastReducer(s0, {
    type: "update",
    id: "a",
    patch: { kind: "success", message: "done" },
    now: 100,
  });
  assert.deepEqual(s.map((t) => t.id), ["a", "b"]); // 順序不変
  assert.equal(s[0].kind, "success");
  assert.equal(s[0].message, "done");
});

test("update: progress→success は ttlMs を渡すと expiresAt が引き直される", () => {
  const s0 = run([], [
    { type: "add", toast: mk("j", { kind: "progress" }), now: 1000 }, // sticky
  ]);
  assert.equal(s0[0].expiresAt, undefined);
  const s = toastReducer(s0, {
    type: "update",
    id: "j",
    patch: { kind: "success", ttlMs: 6000 },
    now: 2000,
  });
  assert.equal(s[0].kind, "success");
  assert.equal(s[0].expiresAt, 8000); // now(2000) + ttlMs(6000)
});

test("update: ttlMs に触れない patch は expiresAt を保つ", () => {
  const s0 = run([], [
    { type: "add", toast: mk("a", { ttlMs: 4000 }), now: 1000 }, // expiresAt 5000
  ]);
  const s = toastReducer(s0, {
    type: "update",
    id: "a",
    patch: { message: "x" },
    now: 9999,
  });
  assert.equal(s[0].expiresAt, 5000); // 引き直さない
});

test("dismiss: 該当 id を消す(他は残る)", () => {
  const s0 = run([], [
    { type: "add", toast: mk("a"), now: 0 },
    { type: "add", toast: mk("b"), now: 0 },
  ]);
  const s = toastReducer(s0, { type: "dismiss", id: "a" });
  assert.deepEqual(s.map((t) => t.id), ["b"]);
});

test(`add: ${MAX_TOASTS} 件超過は最古(先頭)を落とす`, () => {
  const events: ToastEvent[] = [];
  for (let i = 0; i < MAX_TOASTS + 2; i++) {
    events.push({ type: "add", toast: mk(`t${i}`), now: 0 });
  }
  const s = run([], events);
  assert.equal(s.length, MAX_TOASTS);
  // 最古2件(t0,t1)が落ち、末尾は最新
  assert.equal(s[0].id, "t2");
  assert.equal(s[s.length - 1].id, `t${MAX_TOASTS + 1}`);
});
