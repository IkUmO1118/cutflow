// listPresentMaterialFiles(stages/materials.ts)の再帰スキャンを固定する。
// C5(hyperframe-place)が materials/hyperframes/<name>.mp4 を認識するために
// 非再帰から再帰へ変えた変更の回帰テスト。実 fs のみ(mkdtemp)、ネットワーク/
// ffprobe には依存しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPresentMaterialFiles } from "../src/stages/materials.ts";

test("listPresentMaterialFiles: ネストしたディレクトリを再帰的に辿り、ドット始まりを除外する", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-materials-scan-"));
  try {
    mkdirSync(join(dir, "materials", "hyperframes"), { recursive: true });
    writeFileSync(join(dir, "materials", "a.png"), "");
    writeFileSync(join(dir, "materials", "hyperframes", "x.mp4"), "");
    writeFileSync(join(dir, "materials", ".DS_Store"), "");

    const files = listPresentMaterialFiles(dir).sort();
    assert.deepEqual(files, ["materials/a.png", "materials/hyperframes/x.mp4"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listPresentMaterialFiles: materials/ が無ければ空配列", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-materials-scan-empty-"));
  try {
    assert.deepEqual(listPresentMaterialFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listPresentMaterialFiles: ドット始まりのディレクトリはスキップする", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-materials-scan-dotdir-"));
  try {
    mkdirSync(join(dir, "materials", ".trash"), { recursive: true });
    writeFileSync(join(dir, "materials", ".trash", "old.mp4"), "");
    writeFileSync(join(dir, "materials", "keep.png"), "");

    const files = listPresentMaterialFiles(dir).sort();
    assert.deepEqual(files, ["materials/keep.png"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
