import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDraft } from "../src/stages/runDraft.ts";
import type { RunDraftDeps } from "../src/stages/runDraft.ts";
import type { Config } from "../src/lib/config.ts";

const cfg = {} as Config;

function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "framewright-run-draft-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function deps(calls: string[]): Partial<RunDraftDeps> {
  return {
    findSource: (() => "/recording/raw.mp4") as RunDraftDeps["findSource"],
    ingest: (async () => { calls.push("ingest"); return {}; }) as RunDraftDeps["ingest"],
    transcribe: (async () => { calls.push("transcribe"); return { segments: [] }; }) as RunDraftDeps["transcribe"],
    detect: (async () => {
      calls.push("detect");
      return { originalDurationSec: 10, keptDurationSec: 9, silences: [] };
    }) as RunDraftDeps["detect"],
    plan: (async () => {
      calls.push("plan");
      return { approved: false, segments: [{ start: 0, end: 10, action: "keep", reason: "AI" }] };
    }) as RunDraftDeps["plan"],
    idStamp: (() => { calls.push("id-stamp"); return { changed: [], validate: { errors: [], warnings: [] } }; }) as RunDraftDeps["idStamp"],
    autoZoomIfFresh: (() => { calls.push("autozoom"); return null; }) as RunDraftDeps["autoZoomIfFresh"],
    stage: (async (name, task) => { calls.push(`stage:${name}`); return await task(); }) as RunDraftDeps["stage"],
  };
}

test("runDraft: manifest 有りなら ingest を呼ばず transcribe→detect→plan から始める", async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "manifest.json"), "{}");
    const calls: string[] = [];
    await runDraft(dir, cfg, {}, deps(calls));
    assert.deepEqual(calls, [
      "stage:transcribe", "transcribe", "stage:detect", "detect", "stage:plan", "plan", "id-stamp", "autozoom",
    ]);
  });
});

test("runDraft: manifest 無しなら ingest→transcribe→detect→plan の後方互換", async () => {
  await withDir(async (dir) => {
    const calls: string[] = [];
    await runDraft(dir, cfg, { layout: "plain", canvas: "portrait" }, deps(calls));
    assert.deepEqual(calls, [
      "stage:ingest", "ingest", "stage:transcribe", "transcribe", "stage:detect", "detect", "stage:plan", "plan", "id-stamp", "autozoom",
    ]);
  });
});
