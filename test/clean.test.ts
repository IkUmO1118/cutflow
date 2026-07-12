import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planClean, executeClean } from "../src/stages/clean.ts";
import { fileRole } from "../src/lib/files.ts";

/** 一時収録フォルダに editable + approval + other + generated を1件ずつ置く */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-clean-"));
  const put = (rel: string, body = "x") => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  };
  // editable(5件・消えてはいけない)
  for (const f of ["cutplan.json", "chapters.json", "meta.json", "transcript.json", "overlays.json"]) put(f);
  // approval(消えてはいけない)
  put("approvals.json");
  // other(消えてはいけない): 成果物・素材・shorts/bgm/thumbnail JSON・rules・backups
  put("final.mp4"); put("thumbnail.png"); put("thumbnail.json"); put("bgm.json");
  put("shorts.json"); put("bgm.mp3"); put("rules.md");
  put("materials/broll.mp4"); put("backups/20260101-000000/cutplan.json");
  // generated 固定名(消えるべき)
  put("manifest.json"); put("cuts.auto.json"); put("whisper-out.json"); put("whisper-out.srt");
  put("proxy.mp4"); put("proxy.key.json"); put("cut.mp4"); put("cut.keeps.json");
  put("render.props.json"); put("render.key.json"); put("preview.mp4");
  put("effect-check.json"); put("style-check.json");
  // generated パターン(ショート名可変)
  put("cut.highlight-1.mp4"); put("cut.highlight-1.keeps.json");
  put("render.highlight-1.props.json"); put("render.highlight-1.key.json");
  // generated ディレクトリ(配下丸ごと消える)
  put("frames/out10s.png"); put("frames/props.json");
  put("render.chunks/v001.mp4"); put("render.chunks/chunks.key.json");
  put("shorts/highlight-1.mp4");
  put("materials.probe/index.json"); put("av.probe/motion.json"); put("review.probe/index.json");
  return dir;
}

test("planClean: 選ぶのは全て generated、editable/approval/other は1件も選ばない", () => {
  const dir = makeFixture();
  try {
    const plan = planClean(dir);
    // ★ 分類一致: 全ターゲットが generated
    for (const t of plan.targets) {
      assert.equal(fileRole(t.relPath), "generated", `${t.relPath} が generated ではない`);
    }
    const picked = new Set(plan.targets.map((t) => t.relPath));
    // 消えるべき代表が入っている
    for (const g of ["manifest.json", "cuts.auto.json", "proxy.mp4", "cut.mp4",
      "cut.highlight-1.mp4", "frames", "render.chunks", "shorts", "materials.probe",
      "av.probe", "review.probe", "whisper-out.json", "preview.mp4"]) {
      assert.ok(picked.has(g), `${g} が削除対象に無い`);
    }
    // 触ってはいけない代表が入っていない
    for (const keep of ["cutplan.json", "chapters.json", "meta.json", "transcript.json",
      "overlays.json", "approvals.json", "final.mp4", "thumbnail.png", "thumbnail.json",
      "bgm.json", "shorts.json", "bgm.mp3", "rules.md", "materials", "backups"]) {
      assert.ok(!picked.has(keep), `${keep} を削除対象に選んでいる`);
    }
    assert.ok(plan.bytes > 0);
    assert.equal(plan.bytes, plan.targets.reduce((s, t) => s + t.bytes, 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeClean: generated だけ消え、editable/approval/other/素材は残る", () => {
  const dir = makeFixture();
  try {
    executeClean(dir, planClean(dir));
    // 残るべき
    for (const keep of ["cutplan.json", "chapters.json", "meta.json", "transcript.json",
      "overlays.json", "approvals.json", "final.mp4", "thumbnail.png", "thumbnail.json",
      "bgm.json", "shorts.json", "bgm.mp3", "rules.md",
      "materials/broll.mp4", "backups/20260101-000000/cutplan.json"]) {
      assert.ok(existsSync(join(dir, keep)), `${keep} が消えた`);
    }
    // 消えるべき
    for (const gone of ["manifest.json", "proxy.mp4", "cut.mp4", "cut.highlight-1.mp4",
      "frames", "render.chunks", "shorts", "materials.probe", "av.probe", "review.probe",
      "whisper-out.json", "preview.mp4", "effect-check.json"]) {
      assert.ok(!existsSync(join(dir, gone)), `${gone} が残っている`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planClean --cache-only: 重いキャッシュだけ選び、軽い中間生成物は残す", () => {
  const dir = makeFixture();
  try {
    const picked = new Set(planClean(dir, { cacheOnly: true }).targets.map((t) => t.relPath));
    for (const cache of ["proxy.mp4", "proxy.key.json", "cut.mp4", "cut.keeps.json",
      "preview.mp4", "render.props.json", "render.key.json", "cut.highlight-1.mp4",
      "render.highlight-1.props.json", "frames", "render.chunks", "shorts",
      "materials.probe", "av.probe", "review.probe"]) {
      assert.ok(picked.has(cache), `${cache} が cache-only 対象に無い`);
    }
    for (const keepInCacheOnly of ["manifest.json", "cuts.auto.json", "whisper-out.json",
      "whisper-out.srt", "effect-check.json", "style-check.json"]) {
      assert.ok(!picked.has(keepInCacheOnly), `${keepInCacheOnly} を cache-only で消そうとした`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planClean/executeClean: 冪等(2回目は対象なし・throw しない)", () => {
  const dir = makeFixture();
  try {
    executeClean(dir, planClean(dir));
    const second = planClean(dir);
    assert.equal(second.targets.length, 0);
    assert.equal(second.bytes, 0);
    executeClean(dir, second); // no-op で throw しない
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planClean: 空/存在しないフォルダでも空計画を返す(安全)", () => {
  const empty = mkdtempSync(join(tmpdir(), "cutflow-clean-empty-"));
  try {
    assert.equal(planClean(empty).targets.length, 0);
    assert.equal(planClean(join(empty, "no-such")).targets.length, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
