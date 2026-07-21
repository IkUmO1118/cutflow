import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HttpError,
  PreviewCutRequestQueue,
  executePreviewCutRequest,
  loadPreviewCutState,
  previewCutRequestKey,
  validatePreviewCutRequest,
} from "../editor/server.ts";
import {
  buildPreviewCutCacheKey,
  previewCutKeepSignature,
  type PreviewCutCacheKey,
} from "../src/lib/previewCutCache.ts";
import type { Config } from "../src/lib/config.ts";
import type { CutPlan } from "../src/types.ts";

const CFG = {
  preview: { width: 1280, videoEncoder: "libx264" },
} as Config;
const DISK_PLAN: CutPlan = {
  approved: false,
  segments: [{ start: 0, end: 10, action: "keep", reason: "disk" }],
};
const UNSAVED_PLAN: CutPlan = {
  approved: false,
  segments: [
    { start: 0, end: 3, action: "keep", reason: "unsaved" },
    { start: 3, end: 5, action: "cut", reason: "unsaved cut" },
    { start: 5, end: 10, action: "keep", reason: "unsaved fast", speed: 2 },
  ],
};

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-editor-preview-cut-"));
  const write = (name: string, value: unknown) =>
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
  write("manifest.json", {
    dir,
    source: "raw.mp4",
    durationSec: 10,
    layout: "plain",
    video: {
      width: 1280,
      height: 720,
      fps: 30,
      screenRegion: { x: 0, y: 0, w: 1280, h: 720 },
    },
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-22T00:00:00Z",
  });
  write("transcript.json", {
    language: "ja",
    model: "test",
    segments: [{ start: 0, end: 1, text: "hello" }],
  });
  write("cutplan.json", DISK_PLAN);
  write("overlays.json", {});
  writeFileSync(join(dir, "proxy.mp4"), "proxy");
  return dir;
}

function cacheKey(dir: string, cutplan: CutPlan): PreviewCutCacheKey {
  const proxy = statSync(join(dir, "proxy.mp4"));
  return buildPreviewCutCacheKey({
    cfg: CFG,
    cutplan,
    proxyMtimeMs: proxy.mtimeMs,
    proxySize: proxy.size,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, ng) => {
    resolve = ok;
    reject = ng;
  });
  return { promise, resolve, reject };
}

async function rejectedHttp(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError);
    return error;
  }
  assert.fail("HttpError が必要です");
}

test("validatePreviewCutRequest: envelope は厳密な {cutplan} のみを受理し、cutplan errorsを400候補にする", () => {
  const dir = fixture();
  try {
    assert.deepEqual(validatePreviewCutRequest(dir, { cutplan: UNSAVED_PLAN }), []);
    assert.match(validatePreviewCutRequest(dir, null).join(" / "), /\{cutplan\}/);
    assert.match(validatePreviewCutRequest(dir, {}).join(" / "), /cutplan だけ/);
    assert.match(validatePreviewCutRequest(dir, {
      cutplan: UNSAVED_PLAN,
      overlays: {},
    }).join(" / "), /cutplan だけ/);
    const invalid = structuredClone(UNSAVED_PLAN);
    invalid.segments[0].end = -1;
    assert.match(validatePreviewCutRequest(dir, { cutplan: invalid }).join(" / "), /end/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PreviewCutRequestQueue: 同一keyは実行中promiseを共有して1回だけ実行する", async () => {
  const queue = new PreviewCutRequestQueue();
  const gate = deferred<Awaited<ReturnType<PreviewCutRequestQueue["enqueue"]>>>();
  let calls = 0;
  const task = () => {
    calls++;
    return gate.promise;
  };
  const a = queue.enqueue("same", task);
  const b = queue.enqueue("same", task);
  assert.equal(a, b);
  await Promise.resolve();
  assert.equal(calls, 1);
  const result = { path: "preview-cut.mp4", reused: false, key: {} as PreviewCutCacheKey };
  gate.resolve(result);
  assert.equal(await a, result);
  assert.equal(await b, result);
});

test("PreviewCutRequestQueue: 異keyはFIFOで直列化する", async () => {
  const queue = new PreviewCutRequestQueue();
  const first = deferred<{ path: string; reused: boolean; key: PreviewCutCacheKey }>();
  const order: string[] = [];
  const a = queue.enqueue("a", async () => {
    order.push("a:start");
    const result = await first.promise;
    order.push("a:end");
    return result;
  });
  const b = queue.enqueue("b", async () => {
    order.push("b:start");
    return { path: "b", reused: false, key: {} as PreviewCutCacheKey };
  });
  await Promise.resolve();
  assert.deepEqual(order, ["a:start"]);
  first.resolve({ path: "a", reused: false, key: {} as PreviewCutCacheKey });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start"]);
});

test("PreviewCutRequestQueue: 先行taskが失敗しても後続keyを実行する", async () => {
  const queue = new PreviewCutRequestQueue();
  const order: string[] = [];
  const failed = queue.enqueue("bad", async () => {
    order.push("bad");
    throw new Error("synthetic failure");
  });
  const next = queue.enqueue("good", async () => {
    order.push("good");
    return { path: "good", reused: false, key: {} as PreviewCutCacheKey };
  });
  await assert.rejects(failed, /synthetic failure/);
  assert.equal((await next).path, "good");
  assert.deepEqual(order, ["bad", "good"]);
});

test("executePreviewCutRequest: 未保存cutplan snapshotをbuildへ渡し、disk/approvalを一切書かない", async () => {
  const dir = fixture();
  try {
    const diskBefore = readFileSync(join(dir, "cutplan.json"));
    let received: CutPlan | null = null;
    const response = await executePreviewCutRequest(dir, CFG, { cutplan: UNSAVED_PLAN }, {
      queue: new PreviewCutRequestQueue(),
      build: async (_dir, _cfg, cutplan) => {
        received = cutplan;
        return { path: join(dir, "preview-cut.mp4"), reused: false, key: cacheKey(dir, cutplan) };
      },
    });
    assert.deepEqual(received, UNSAVED_PLAN);
    assert.deepEqual(response, {
      ok: true,
      path: join(dir, "preview-cut.mp4"),
      keepSignature: previewCutKeepSignature(UNSAVED_PLAN),
      reused: false,
    });
    assert.deepEqual(readFileSync(join(dir, "cutplan.json")), diskBefore);
    assert.equal(readFileSync(join(dir, "cutplan.json"), "utf8").includes("unsaved"), false);
    assert.equal(readFileSync(join(dir, "cutplan.json"), "utf8").includes("approvedAt"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executePreviewCutRequest: 同じcache keyだけdedupし、reason/approved差はkeyへ入れない", async () => {
  const dir = fixture();
  try {
    const metadataOnly = structuredClone(UNSAVED_PLAN);
    metadataOnly.approved = true;
    metadataOnly.segments[0].reason = "metadata changed";
    assert.equal(
      previewCutRequestKey({ dir, cfg: CFG, cutplan: UNSAVED_PLAN }),
      previewCutRequestKey({ dir, cfg: CFG, cutplan: metadataOnly }),
    );
    const differentKeep = structuredClone(UNSAVED_PLAN);
    differentKeep.segments[2].speed = 1.5;
    assert.notEqual(
      previewCutRequestKey({ dir, cfg: CFG, cutplan: UNSAVED_PLAN }),
      previewCutRequestKey({ dir, cfg: CFG, cutplan: differentKeep }),
    );
    const queue = new PreviewCutRequestQueue();
    const gate = deferred<{ path: string; reused: boolean; key: PreviewCutCacheKey }>();
    let calls = 0;
    const build = async () => {
      calls++;
      return await gate.promise;
    };
    const a = executePreviewCutRequest(dir, CFG, { cutplan: UNSAVED_PLAN }, { queue, build });
    const b = executePreviewCutRequest(dir, CFG, { cutplan: metadataOnly }, { queue, build });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 1);
    gate.resolve({ path: "preview-cut.mp4", reused: false, key: cacheKey(dir, UNSAVED_PLAN) });
    await Promise.all([a, b]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executePreviewCutRequest: proxy生成中は完了を待ち、欠落/staleは409", async () => {
  const dir = fixture();
  try {
    const wait = deferred<void>();
    let built = false;
    const pending = executePreviewCutRequest(dir, CFG, { cutplan: UNSAVED_PLAN }, {
      queue: new PreviewCutRequestQueue(),
      waitForProxy: () => wait.promise,
      build: async (_dir, _cfg, cutplan) => {
        built = true;
        return { path: "preview-cut.mp4", reused: false, key: cacheKey(dir, cutplan) };
      },
    });
    await Promise.resolve();
    assert.equal(built, false);
    wait.resolve();
    await pending;
    assert.equal(built, true);

    const missing = await rejectedHttp(executePreviewCutRequest(
      dir, CFG, { cutplan: UNSAVED_PLAN }, { proxyExists: () => false },
    ));
    assert.equal(missing.status, 409);
    const stale = await rejectedHttp(executePreviewCutRequest(
      dir, CFG, { cutplan: UNSAVED_PLAN }, { proxyStale: () => true },
    ));
    assert.equal(stale.status, 409);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executePreviewCutRequest: malformed request はbuild前に400", async () => {
  const dir = fixture();
  try {
    let built = false;
    const error = await rejectedHttp(executePreviewCutRequest(
      dir,
      CFG,
      { cutplan: { approved: false, segments: [] }, extra: true },
      { build: async () => {
        built = true;
        throw new Error("unreachable");
      } },
    ));
    assert.equal(error.status, 400);
    assert.equal(built, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPreviewCutState: disk cutplan/key/output stat一致だけready=true、欠落/malformed/stat不一致はfalse", () => {
  const dir = fixture();
  try {
    const signature = previewCutKeepSignature(DISK_PLAN);
    assert.deepEqual(loadPreviewCutState(dir, CFG, DISK_PLAN, { exists: true, stale: false }), {
      ready: false,
      keepSignature: signature,
    });
    writeFileSync(join(dir, "preview-cut.mp4"), "baked");
    const output = statSync(join(dir, "preview-cut.mp4"));
    writeFileSync(join(dir, "preview-cut.key.json"), JSON.stringify({
      key: cacheKey(dir, DISK_PLAN),
      output: { mtimeMs: output.mtimeMs, size: output.size },
    }));
    assert.deepEqual(loadPreviewCutState(dir, CFG, DISK_PLAN, { exists: true, stale: false }), {
      ready: true,
      keepSignature: signature,
    });

    writeFileSync(join(dir, "preview-cut.key.json"), "{not json");
    assert.equal(loadPreviewCutState(dir, CFG, DISK_PLAN, { exists: true, stale: false }).ready, false);
    writeFileSync(join(dir, "preview-cut.key.json"), JSON.stringify({
      key: cacheKey(dir, DISK_PLAN),
      output: { mtimeMs: output.mtimeMs, size: output.size },
    }));
    writeFileSync(join(dir, "preview-cut.mp4"), "changed-size");
    assert.equal(loadPreviewCutState(dir, CFG, DISK_PLAN, { exists: true, stale: false }).ready, false);
    assert.equal(loadPreviewCutState(dir, CFG, DISK_PLAN, { exists: false, stale: false }).ready, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
