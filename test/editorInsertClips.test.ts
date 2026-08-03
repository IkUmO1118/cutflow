import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sameAtInsertNeighbor, snapToKeep } from "../editor/client/model.ts";
import { buildTimeline } from "../src/lib/timeline.ts";

test("snapToKeep: keep 内の秒はそのまま返す", () => {
  assert.equal(snapToKeep(2.5, [{ start: 1, end: 4 }, { start: 7, end: 9 }]), 2.5);
});

test("snapToKeep: cut 内の秒は直後の keep の先頭へ寄せる", () => {
  assert.equal(snapToKeep(5.5, [{ start: 1, end: 4 }, { start: 7, end: 9 }]), 7);
});

test("snapToKeep: 最後の keep より後ろは最後の keep の末尾へ寄せる", () => {
  assert.equal(snapToKeep(12, [{ start: 1, end: 4 }, { start: 7, end: 9 }]), 9);
});

test("snapToKeep: keep が空なら入力をそのまま返す", () => {
  assert.equal(snapToKeep(12.34, []), 12.34);
});

test("insert 無しの timeline は既定引数と空配列で等価", () => {
  const keeps = [{ start: 1, end: 4 }, { start: 7, end: 9 }];
  assert.deepEqual(buildTimeline(keeps, []), buildTimeline(keeps));
});

test("sameAtInsertNeighbor: 別時刻を跨いで同一 at の前後だけを選ぶ", () => {
  const inserts = [{ at: 3 }, { at: 8 }, { at: 3 }, { at: 5 }, { at: 3 }];
  assert.equal(sameAtInsertNeighbor(inserts, 2, "before"), 0);
  assert.equal(sameAtInsertNeighbor(inserts, 2, "after"), 4);
  assert.equal(sameAtInsertNeighbor(inserts, 0, "before"), null);
  assert.equal(sameAtInsertNeighbor(inserts, 4, "after"), null);
});

test("insert Inspector は同一 at のときだけ順序操作を出し選択 index を追随する", () => {
  const root = process.cwd();
  const inspector = readFileSync(join(root, "editor/client/Inspector.tsx"), "utf8");
  const app = readFileSync(join(root, "editor/client/App.tsx"), "utf8");
  assert.match(inspector, /sameAtIndices\.length > 1/);
  assert.match(inspector, />\s*前へ\s*<\/button>/);
  assert.match(inspector, />\s*後ろへ\s*<\/button>/);
  assert.match(app, /setSelection\(\{ kind: "insert", index: swap \}\)/);
});

test("cut トラックの insert は basename と動画・静止画クラスを持つ", () => {
  const root = process.cwd();
  const app = readFileSync(join(root, "editor/client/App.tsx"), "utf8");
  const timeline = readFileSync(join(root, "editor/client/Timeline.tsx"), "utf8");
  const css = readFileSync(join(root, "editor/client/styles.css"), "utf8");
  assert.match(app, /const fileName = ins\.file\.split/);
  assert.match(app, /mediaKind: isImageFile\(ins\.file\) \? "image" : "video"/);
  assert.match(timeline, /tlInsertKind/);
  assert.match(css, /\.tlClip\.insert\.image/);
  assert.match(css, /\.tlClip\.insert\.video/);
});
