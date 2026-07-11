// lib/files.ts — 収録フォルダ内のファイル分類(単一の真実)を固定する。
// EDITABLE_FILES(手編集対象)/ GENERATED_FILES(中間生成物)/ APPROVAL_FILE
// (承認レコード)が重複・交差しないこと、fileRole がこの3分類+その他を
// 正しく判定することを検証する。GENERATED_FILES は CLAUDE.md の
// 「中間生成物は編集しない」一覧(固定ファイル名の部分)と一致させる。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_FILE,
  EDITABLE_FILES,
  GENERATED_FILES,
  fileRole,
} from "../src/lib/files.ts";

/** CLAUDE.md の中間生成物一覧のうち、収録フォルダ直下で名前が固定のもの
 * (ショート名で可変になる cut.<name>.mp4 等・frames/ / render.chunks/ /
 * shorts/ ディレクトリ配下は別途 fileRole のパターン判定で検証する) */
const EXPECTED_GENERATED_FILES = [
  "manifest.json",
  "cuts.auto.json",
  "plan.raw.txt",
  "plan.loop.json",
  "plan-shorts.raw.txt",
  "plan-materials.raw.txt",
  "plan-effects.raw.txt",
  "render.props.json",
  "whisper-out.json",
  "whisper-out.srt",
  "transcript.system.json",
  "whisper-system-out.json",
  "cut.mp4",
  "cut.keeps.json",
  "render.key.json",
  "preview.mp4",
  "proxy.mp4",
  "proxy.key.json",
  "material-fit.suggested.json",
  "effect-check.json",
  "effect-fix.suggested.json",
];

test("GENERATED_FILES: CLAUDE.md の中間生成物一覧(固定名部分)と一致する", () => {
  assert.deepEqual([...GENERATED_FILES].sort(), [...EXPECTED_GENERATED_FILES].sort());
});

test("EDITABLE_FILES: 現行の手編集対象一覧と一致する(backupEditableFiles の既定値)", () => {
  assert.deepEqual(
    [...EDITABLE_FILES],
    ["cutplan.json", "chapters.json", "meta.json", "transcript.json", "overlays.json"],
  );
});

test("EDITABLE_FILES と GENERATED_FILES は交差しない", () => {
  const gen = new Set(GENERATED_FILES as readonly string[]);
  for (const f of EDITABLE_FILES) assert.ok(!gen.has(f), `${f} が両方に分類されている`);
});

test("EDITABLE_FILES / GENERATED_FILES 内に重複がない", () => {
  assert.equal(new Set(EDITABLE_FILES).size, EDITABLE_FILES.length);
  assert.equal(new Set(GENERATED_FILES).size, GENERATED_FILES.length);
});

test("APPROVAL_FILE は editable にも generated にも属さない", () => {
  assert.ok(!(EDITABLE_FILES as readonly string[]).includes(APPROVAL_FILE));
  assert.ok(!(GENERATED_FILES as readonly string[]).includes(APPROVAL_FILE));
  assert.equal(APPROVAL_FILE, "approvals.json");
});

test("fileRole: editable / generated / approval / other を正しく判定する", () => {
  assert.equal(fileRole("cutplan.json"), "editable");
  assert.equal(fileRole("overlays.json"), "editable");
  assert.equal(fileRole("manifest.json"), "generated");
  assert.equal(fileRole("cut.mp4"), "generated");
  assert.equal(fileRole("material-fit.suggested.json"), "generated");
  assert.equal(fileRole("approvals.json"), "approval");
  assert.equal(fileRole("final.mp4"), "other");
  assert.equal(fileRole("thumbnail.png"), "other");
  assert.equal(fileRole("thumbnail.json"), "other");
  assert.equal(fileRole("bgm.mp3"), "other");
  assert.equal(fileRole("rules.md"), "other");
  assert.equal(fileRole("rules.suggested.md"), "other");
  assert.equal(fileRole("backups/20260707-120000/cutplan.json"), "other");
  assert.equal(fileRole(".editor-draft.json"), "other");
});

test("fileRole: ショート名で可変な中間生成物のパターンを判定する", () => {
  assert.equal(fileRole("cut.highlight-1.mp4"), "generated");
  assert.equal(fileRole("cut.highlight-1.keeps.json"), "generated");
  assert.equal(fileRole("render.highlight-1.props.json"), "generated");
  assert.equal(fileRole("render.highlight-1.key.json"), "generated");
});

test("fileRole: 中間生成物ディレクトリ配下は丸ごと generated", () => {
  assert.equal(fileRole("frames/out10.5s.png"), "generated");
  assert.equal(fileRole("frames/props.json"), "generated");
  assert.equal(fileRole("frames/out10.5s.ocr.json"), "generated");
  assert.equal(fileRole("render.chunks/v001.mp4"), "generated");
  assert.equal(fileRole("render.chunks/chunks.key.json"), "generated");
  assert.equal(fileRole("shorts/highlight-1.mp4"), "generated");
});

test("fileRole: materials/ 配下(人間の素材)は other", () => {
  assert.equal(fileRole("materials/broll.mp4"), "other");
});

test("fileRole: materials.probe/ 配下(素材知覚の集約+キャッシュ)は generated", () => {
  assert.equal(fileRole("materials.probe/index.json"), "generated");
  assert.equal(fileRole("materials.probe/materials__opening.mp4.png"), "generated");
  assert.equal(fileRole("materials.probe/materials__opening.mp4.ocr.json"), "generated");
});

test("fileRole: av.probe/ 配下(A/V 知覚の集約+キャッシュ)は generated", () => {
  assert.equal(fileRole("av.probe/motion.json"), "generated");
  assert.equal(fileRole("av.probe/sound.json"), "generated");
  assert.equal(fileRole("av.probe/motion.strip.png"), "generated");
});

test("fileRole: review.probe/ 配下(review bundle)は generated", () => {
  assert.equal(fileRole("review.probe/index.json"), "generated");
  assert.equal(fileRole("review.probe/before/out12.30s.png"), "generated");
  assert.equal(fileRole("review.probe/after/clip.mp4"), "generated");
  assert.equal(fileRole("review.probe/ocr/after-out12.30s.json"), "generated");
});
