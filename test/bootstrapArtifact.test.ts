import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBootstrapArtifact } from "../src/lib/bootstrapArtifact.ts";
import { guardRerun, rerunConflicts } from "../src/lib/rerunGuard.ts";
import { emptyTranscript, initialCutplan } from "../src/stages/bootstrap.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "framewright-bootstrap-marker-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const write = (dir: string, file: string, value: unknown) =>
  writeFileSync(join(dir, file), JSON.stringify(value, null, 2));

test("bootstrap marker: transcript/cutplan はマーカーと初期内容の二重一致だけを許す", () => {
  withDir((dir) => {
    write(dir, "manifest.json", { durationSec: 12 });
    write(dir, "transcript.json", emptyTranscript());
    write(dir, "cutplan.json", initialCutplan(12));
    assert.equal(isBootstrapArtifact(join(dir, "transcript.json")), true);
    assert.equal(isBootstrapArtifact(join(dir, "cutplan.json")), true);

    write(dir, "transcript.json", { ...emptyTranscript(), segments: [{ start: 0, end: 1, text: "手編集" }] });
    write(dir, "cutplan.json", {
      ...initialCutplan(12),
      segments: [{ start: 0, end: 12, action: "keep", reason: "手編集" }],
    });
    assert.equal(isBootstrapArtifact(join(dir, "transcript.json")), false);
    assert.equal(isBootstrapArtifact(join(dir, "cutplan.json")), false);
  });
});

test("guardRerun: bootstrap 初期値だけなら force 不要", () => {
  withDir((dir) => {
    write(dir, "manifest.json", { durationSec: 12 });
    write(dir, "transcript.json", emptyTranscript());
    write(dir, "cutplan.json", initialCutplan(12));
    assert.deepEqual(rerunConflicts(dir, ["transcript.json", "cutplan.json"]), []);
    assert.doesNotThrow(() => guardRerun(dir, ["transcript.json", "cutplan.json"], false, "run"));
  });
});

test("guardRerun: マーカーの無い既存収録は従来どおり force を要求", () => {
  withDir((dir) => {
    write(dir, "manifest.json", { durationSec: 12 });
    const legacy = initialCutplan(12);
    delete legacy.generatedBy;
    write(dir, "cutplan.json", legacy);
    assert.deepEqual(rerunConflicts(dir, ["cutplan.json"]), ["cutplan.json"]);
    assert.throws(() => guardRerun(dir, ["cutplan.json"], false, "run"), /--force/);
  });
});

test("bootstrap marker: 壊れた JSON と対象外ファイルは安全側へ倒す", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "cutplan.json"), "{");
    write(dir, "chapters.json", { generatedBy: "bootstrap", chapters: [] });
    assert.equal(isBootstrapArtifact(join(dir, "cutplan.json")), false);
    assert.equal(isBootstrapArtifact(join(dir, "chapters.json")), false);
  });
});

test("bootstrap marker: cutplan の境界・approved・追加キー変更は人間編集として保護", () => {
  withDir((dir) => {
    write(dir, "manifest.json", { durationSec: 12 });
    const path = join(dir, "cutplan.json");
    const initial = initialCutplan(12);

    write(dir, "cutplan.json", { ...initial, segments: [{ ...initial.segments[0], end: 11 }] });
    assert.equal(isBootstrapArtifact(path), false, "end 変更");
    write(dir, "cutplan.json", { ...initial, approved: true });
    assert.equal(isBootstrapArtifact(path), false, "approved 変更");
    write(dir, "cutplan.json", { ...initial, note: "人間の追記" });
    assert.equal(isBootstrapArtifact(path), false, "top-level 追加キー");
    write(dir, "cutplan.json", { ...initial, segments: [{ ...initial.segments[0], speed: 2 }] });
    assert.equal(isBootstrapArtifact(path), false, "segment 追加編集キー");
  });
});

test("bootstrap marker: transcript の追加top-levelキーは人間編集として保護", () => {
  withDir((dir) => {
    write(dir, "manifest.json", { durationSec: 12 });
    const path = join(dir, "transcript.json");
    write(dir, "transcript.json", { ...emptyTranscript(), language: "ja" });
    assert.equal(isBootstrapArtifact(path), false);
  });
});

test("bootstrap marker: manifest 欠落・破損・duration不一致は安全側へ倒す", () => {
  withDir((dir) => {
    const path = join(dir, "cutplan.json");
    const transcriptPath = join(dir, "transcript.json");
    write(dir, "cutplan.json", initialCutplan(12));
    write(dir, "transcript.json", emptyTranscript());
    assert.equal(isBootstrapArtifact(path), false, "manifest 欠落");
    assert.equal(isBootstrapArtifact(transcriptPath), false, "transcript も manifest 欠落時は保護");
    writeFileSync(join(dir, "manifest.json"), "{");
    assert.equal(isBootstrapArtifact(path), false, "manifest 破損");
    write(dir, "manifest.json", { durationSec: 10 });
    assert.equal(isBootstrapArtifact(path), false, "duration 不一致");
  });
});
