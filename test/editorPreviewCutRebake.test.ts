import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREVIEW_CUT_DEBOUNCE_MS,
  PreviewCutRebakeController,
} from "../editor/client/previewCutRebake.ts";
import { previewCutKeepSignature } from "../src/lib/previewCutSignature.ts";
import type { PreviewCutResponse } from "../editor/client/apiTypes.ts";
import type { CutPlan } from "../src/types.ts";

class FakeScheduler {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; callback: () => void }>();

  schedule = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  cancel = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = target;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const plan = (end: number, reason = "keep", approved = false): CutPlan => ({
  approved,
  segments: [
    { start: 0, end, action: "keep", reason },
    { start: end, end: 30, action: "cut", reason: "cut" },
  ],
});

const response = (cutplan: CutPlan): PreviewCutResponse => ({
  ok: true,
  path: "preview-cut.mp4",
  keepSignature: previewCutKeepSignature(cutplan),
  reused: false,
});

const input = (cutplan: CutPlan, overrides: Partial<{
  ready: boolean;
  readySignature: string;
  enabled: boolean;
  sourceVersion: number;
}> = {}) => ({
  cutplan,
  keepSignature: previewCutKeepSignature(cutplan),
  ready: overrides.ready ?? false,
  readySignature: overrides.readySignature ?? "",
  enabled: overrides.enabled ?? true,
  sourceVersion: overrides.sourceVersion ?? 0,
});

test("rebake debounce: 1.5秒待ち、reason/approvedだけでは延長せず、keep変更は延長する", () => {
  const clock = new FakeScheduler();
  const requests: CutPlan[] = [];
  const first = deferred<PreviewCutResponse>();
  const controller = new PreviewCutRebakeController({
    request: (snapshot) => {
      requests.push(snapshot);
      return first.promise;
    },
    onState: () => {},
    onReady: () => {},
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  const a = plan(10);
  controller.update(input(a));
  clock.advance(1000);
  const metadataOnly = plan(10, "changed reason", true);
  controller.update(input(metadataOnly));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS - 1001);
  assert.equal(requests.length, 0);
  clock.advance(1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], metadataOnly, "送信時点の未保存snapshotは最新");

  const b = plan(12);
  const c = plan(14);
  controller.update(input(b));
  clock.advance(1000);
  controller.update(input(c));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS - 1);
  assert.equal(requests.length, 1, "境界ドラッグの最後から1.5秒まで発火しない");
  clock.advance(1);
  assert.equal(requests.length, 2);
  assert.equal(previewCutKeepSignature(requests[1]), previewCutKeepSignature(c));
  controller.dispose();
});

test("rebake race: A生成中にBへ編集するとA成功を捨て、B成功だけreadyへ採用する", async () => {
  const clock = new FakeScheduler();
  const pending = [deferred<PreviewCutResponse>(), deferred<PreviewCutResponse>()];
  const states: string[] = [];
  const adopted: string[] = [];
  let requestIndex = 0;
  const controller = new PreviewCutRebakeController({
    request: () => pending[requestIndex++].promise,
    onState: (state) => states.push(`${state.status}:${"keepSignature" in state ? state.keepSignature : ""}`),
    onReady: (result) => adopted.push(result.keepSignature),
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const a = plan(10);
  const b = plan(12);

  controller.update(input(a));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS);
  controller.update(input(b));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS);
  assert.equal(requestIndex, 2);

  pending[0].resolve(response(a));
  await flush();
  assert.deepEqual(adopted, []);
  assert.equal(states.at(-1), `building:${previewCutKeepSignature(b)}`);

  pending[1].resolve(response(b));
  await flush();
  assert.deepEqual(adopted, [previewCutKeepSignature(b)]);
  assert.equal(states.at(-1), "idle:");
  controller.dispose();
});

test("rebake race: 旧Aの失敗は最新Bのbusy/failure状態を変えない", async () => {
  const clock = new FakeScheduler();
  const pending = [deferred<PreviewCutResponse>(), deferred<PreviewCutResponse>()];
  const states: string[] = [];
  let requestIndex = 0;
  const controller = new PreviewCutRebakeController({
    request: () => pending[requestIndex++].promise,
    onState: (state) => states.push(state.status),
    onReady: () => {},
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const a = plan(10);
  const b = plan(12);
  controller.update(input(a));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS);
  controller.update(input(b));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS);

  pending[0].reject(new Error("old failure"));
  await flush();
  assert.equal(states.at(-1), "building");
  assert.equal(states.includes("failed"), false);

  pending[1].resolve(response(b));
  await flush();
  assert.equal(states.at(-1), "idle");
  controller.dispose();
});

test("rebake race: 最新Bの失敗表示を後着した旧A応答が上書きしない", async () => {
  const clock = new FakeScheduler();
  const pending = [deferred<PreviewCutResponse>(), deferred<PreviewCutResponse>()];
  const states: Array<{ status: string; error?: string }> = [];
  const adopted: string[] = [];
  let requestIndex = 0;
  const controller = new PreviewCutRebakeController({
    request: () => pending[requestIndex++].promise,
    onState: (state) => states.push(state),
    onReady: (result) => adopted.push(result.keepSignature),
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const a = plan(10);
  const b = plan(12);
  controller.update(input(a));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS);
  controller.update(input(b));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS);

  pending[1].reject(new Error("latest B failure"));
  await flush();
  assert.equal(states.at(-1)?.status, "failed");
  assert.equal(states.at(-1)?.error, "latest B failure");

  pending[0].resolve(response(a));
  await flush();
  assert.equal(states.at(-1)?.status, "failed");
  assert.equal(states.at(-1)?.error, "latest B failure");
  assert.deepEqual(adopted, []);
  controller.dispose();
});

test("rebake retry: 最新失敗だけを表示状態にし、明示再試行はdebounceなしで成功できる", async () => {
  const clock = new FakeScheduler();
  const failed = deferred<PreviewCutResponse>();
  const retried = deferred<PreviewCutResponse>();
  const states: Array<{ status: string; error?: string }> = [];
  const adopted: string[] = [];
  let requestIndex = 0;
  const controller = new PreviewCutRebakeController({
    request: () => [failed.promise, retried.promise][requestIndex++],
    onState: (state) => states.push(state),
    onReady: (result) => adopted.push(result.keepSignature),
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const a = plan(10);
  controller.update(input(a));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS);
  failed.reject(new Error("ffmpeg failed"));
  await flush();
  assert.deepEqual(states.at(-1), {
    status: "failed",
    keepSignature: previewCutKeepSignature(a),
    error: "ffmpeg failed",
  });

  controller.retry();
  assert.equal(requestIndex, 2, "再試行は明示操作なので即時発火");
  assert.equal(states.at(-1)?.status, "building");
  retried.resolve(response(a));
  await flush();
  assert.deepEqual(adopted, [previewCutKeepSignature(a)]);
  assert.equal(states.at(-1)?.status, "idle");
  controller.dispose();
});

test("rebake trigger: short/欠落proxyでは止まり、本編復帰・proxy再生成世代で同じkeepも生成する", () => {
  const clock = new FakeScheduler();
  const requests: CutPlan[] = [];
  const never = deferred<PreviewCutResponse>();
  const controller = new PreviewCutRebakeController({
    request: (snapshot) => {
      requests.push(snapshot);
      return never.promise;
    },
    onState: () => {},
    onReady: () => {},
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const a = plan(10);
  const signature = previewCutKeepSignature(a);

  controller.update(input(a, { enabled: false }));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS * 2);
  assert.equal(requests.length, 0, "short mode / proxy missing or stale");

  controller.update(input(a, { enabled: true }));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS);
  assert.equal(requests.length, 1, "本編へ戻りproxy usableなら生成");

  controller.update(input(a, {
    ready: true,
    readySignature: signature,
    enabled: true,
  }));
  controller.update(input(plan(10, "metadata changed", true), {
    ready: true,
    readySignature: signature,
    enabled: true,
  }));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS * 2);
  assert.equal(requests.length, 1, "ready cacheへのreason/approved変更は再生成しない");

  controller.update(input(a, {
    ready: false,
    readySignature: "",
    enabled: true,
    sourceVersion: 1,
  }));
  clock.advance(PREVIEW_CUT_DEBOUNCE_MS);
  assert.equal(requests.length, 2, "proxy再生成後は同じkeepでも新proxyから再ベイク");
  controller.dispose();
});
