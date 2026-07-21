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
  GENERATED_CACHE_FILES,
  GENERATED_LOG_FILES,
  isGeneratedCache,
  isGeneratedLog,
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
  "plan-bgm.raw.txt",
  "render.props.json",
  "whisper-out.json",
  "whisper-out.srt",
  "transcript.system.json",
  "whisper-system-out.json",
  "cut.mp4",
  "cut.keeps.json",
  "render.key.json",
  "render.report.json",
  "preview.mp4",
  "proxy.mp4",
  "proxy.key.json",
  "material-fit.suggested.json",
  "effect-check.json",
  "effect-fix.suggested.json",
  "bgm-fit.json",
  "bgm-fit.suggested.json",
  "style-check.json",
  "hyperframe-place.suggested.json",
  "plan.first.json",
  "plan-effects.first.json",
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
  assert.equal(fileRole("render.report.json"), "generated");
  assert.equal(fileRole("material-fit.suggested.json"), "generated");
  assert.equal(fileRole("plan.first.json"), "generated");
  assert.equal(fileRole("plan-effects.first.json"), "generated");
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
  assert.equal(fileRole("render.design/dusk.jpg"), "generated");
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

test("fileRole: style.probe/ 配下(style-profile が書くスタイルプロファイル集約)は generated", () => {
  assert.equal(fileRole("style.probe/default.json"), "generated");
});

test("fileRole: hyperframe.probe/ 配下(hyperframe-check が書く動的監査レポート+still)は generated", () => {
  assert.equal(fileRole("hyperframe.probe/intro/index.json"), "generated");
  assert.equal(fileRole("hyperframe.probe/intro/head.png"), "generated");
});

test("fileRole: hyperframe-freeze.suggested/ 配下(hyperframe-freeze の使い捨て DRAFT)は generated", () => {
  assert.equal(fileRole("hyperframe-freeze.suggested/intro.html"), "generated");
  assert.equal(fileRole("hyperframe-freeze.suggested/intro.md"), "generated");
  assert.equal(isGeneratedLog("hyperframe-freeze.suggested/intro.html"), true);
  assert.equal(isGeneratedCache("hyperframe-freeze.suggested/intro.html"), false);
});

test("fileRole: render.fast/ 配下(高速パスのテロップPNG・キー)は generated", () => {
  assert.equal(fileRole("render.fast/captions/ab12cd34.png"), "generated");
  assert.equal(fileRole("render.fast/segments/v000.mp4"), "generated");
  assert.equal(fileRole("render.fast/overlays/ab12cd34.png"), "generated");
});

test("isGeneratedCache: 重いキャッシュだけ true、軽い中間生成物は false", () => {
  // cache = true
  for (const c of ["proxy.mp4", "proxy.key.json", "cut.mp4", "cut.keeps.json",
    "preview.mp4", "render.props.json", "render.key.json",
    "cut.highlight-1.mp4", "render.highlight-1.key.json",
    "frames/out10s.png", "render.chunks/v001.mp4", "shorts/a.mp4",
    "render.design/dusk.jpg",
    "materials.probe/index.json", "av.probe/motion.json", "review.probe/index.json",
    "hyperframe.probe/intro/index.json",
    "render.fast/captions/ab12cd34.png"]) {
    assert.equal(isGeneratedCache(c), true, `${c} は cache のはず`);
  }
  // generated だが cache ではない(軽い/再生成が高価)
  for (const g of ["manifest.json", "cuts.auto.json", "plan.raw.txt", "whisper-out.json",
    "whisper-out.srt", "effect-check.json", "style-check.json", "material-fit.suggested.json",
    "plan.first.json", "plan-effects.first.json"]) {
    assert.equal(isGeneratedCache(g), false, `${g} は cache ではないはず`);
  }
  // generated 以外は常に false(belt)
  for (const o of ["cutplan.json", "approvals.json", "final.mp4", "materials/broll.mp4"]) {
    assert.equal(isGeneratedCache(o), false, `${o} は generated ではないので false`);
  }
});

test("GENERATED_CACHE_FILES は GENERATED_FILES の部分集合", () => {
  const gen = new Set(GENERATED_FILES as readonly string[]);
  for (const f of GENERATED_CACHE_FILES) assert.ok(gen.has(f), `${f} が GENERATED_FILES に無い`);
});

test("isGeneratedLog: ログ・下書き・検品結果だけ true、最適化/proxy/高価キャッシュは false", () => {
  // log = true(固定名 + frames/ 配下)
  for (const l of ["cuts.auto.json", "plan.raw.txt", "plan.loop.json",
    "plan-shorts.raw.txt", "material-fit.suggested.json", "effect-fix.suggested.json",
    "bgm-fit.suggested.json", "effect-check.json", "bgm-fit.json", "style-check.json",
    "render.report.json", "preview.mp4", "frames/out10s.png", "frames/props.json"]) {
    assert.equal(isGeneratedLog(l), true, `${l} は log のはず`);
  }
  // generated だが log ではない(リレンダー最適化・proxy・高価な再生成物・成果物・必須入力)
  for (const g of ["cut.mp4", "cut.keeps.json", "render.props.json", "render.key.json",
    "proxy.mp4", "proxy.key.json", "manifest.json", "whisper-out.json", "whisper-out.srt",
    "transcript.system.json", "whisper-system-out.json", "cut.highlight-1.mp4",
    "render.highlight-1.key.json", "render.chunks/v001.mp4", "render.fast/captions/ab.png",
    "shorts/a.mp4", "materials.probe/index.json", "av.probe/motion.json", "render.design/dusk.jpg",
    "hyperframe.probe/intro/index.json", "plan.first.json", "plan-effects.first.json"]) {
    assert.equal(isGeneratedLog(g), false, `${g} は log ではないはず`);
  }
  // generated 以外は常に false(belt)
  for (const o of ["cutplan.json", "approvals.json", "final.mp4", "materials/broll.mp4"]) {
    assert.equal(isGeneratedLog(o), false, `${o} は generated ではないので false`);
  }
});

test("plan.first.json: generated だが cache でも log でもない(フル clean でのみ消える。再生成不可能なため)", () => {
  assert.equal(fileRole("plan.first.json"), "generated");
  assert.equal(isGeneratedCache("plan.first.json"), false);
  assert.equal(isGeneratedLog("plan.first.json"), false);
  assert.ok(!(GENERATED_CACHE_FILES as readonly string[]).includes("plan.first.json"));
  assert.ok(!(GENERATED_LOG_FILES as readonly string[]).includes("plan.first.json"));
});

test("plan-effects.first.json: generated だがcache/logではなくフルcleanだけが消す", () => {
  assert.equal(fileRole("plan-effects.first.json"), "generated");
  assert.equal(isGeneratedCache("plan-effects.first.json"), false);
  assert.equal(isGeneratedLog("plan-effects.first.json"), false);
  assert.ok(!(GENERATED_CACHE_FILES as readonly string[]).includes("plan-effects.first.json"));
  assert.ok(!(GENERATED_LOG_FILES as readonly string[]).includes("plan-effects.first.json"));
});

test("GENERATED_LOG_FILES は GENERATED_FILES の部分集合(リレンダー最適化・proxy は含まない)", () => {
  const gen = new Set(GENERATED_FILES as readonly string[]);
  for (const f of GENERATED_LOG_FILES) assert.ok(gen.has(f), `${f} が GENERATED_FILES に無い`);
  // preview.mp4 は cache と log の両方に属してよい(重い かつ 使い捨て)が、
  // リレンダー最適化・proxy の本体は log に混ざってはならない
  const log = new Set(GENERATED_LOG_FILES as readonly string[]);
  for (const opt of ["cut.mp4", "cut.keeps.json", "render.props.json", "render.key.json",
    "proxy.mp4", "proxy.key.json"]) {
    assert.ok(!log.has(opt), `${opt}(リレンダー最適化/proxy)が log に混入`);
  }
});
