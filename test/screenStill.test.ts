// lib/screenStill.ts — フル解像度 screenRegion クロップの ffmpeg 引数組み立て
// (純関数)を固定する。ffmpeg 実行そのものは bench の実測検証で確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cropFilterArg,
  plainStillArgs,
  screenStillArgs,
  seekArg,
} from "../src/lib/screenStill.ts";

test("cropFilterArg: screenRegion から crop=w:h:x:y を組み立てる", () => {
  assert.equal(
    cropFilterArg({ x: 0, y: 0, w: 1920, h: 1080 }),
    "crop=1920:1080:0:0",
  );
  assert.equal(
    cropFilterArg({ x: 1920, y: 0, w: 1920, h: 1080 }),
    "crop=1920:1080:1920:0",
  );
});

test("seekArg: 元秒を小数第3位までの文字列にする", () => {
  assert.equal(seekArg(25), "25.000");
  assert.equal(seekArg(132.4), "132.400");
  assert.equal(seekArg(0), "0.000");
});

test("screenStillArgs: -ss / -i / -vf crop / -frames:v 1 / 出力先の順で組み立てる", () => {
  const args = screenStillArgs(
    "/rec/2026-07-02.mkv",
    { x: 0, y: 0, w: 1920, h: 1080 },
    132.4,
    "/tmp/out.png",
  );
  assert.deepEqual(args, [
    "-y", "-v", "error",
    "-ss", "132.400",
    "-i", "/rec/2026-07-02.mkv",
    "-vf", "crop=1920:1080:0:0",
    "-frames:v", "1",
    "/tmp/out.png",
  ]);
});

test("plainStillArgs: クロップ無し(-ss / -i / -frames:v 1 / 出力先の順)。素材知覚 --frames が使う", () => {
  const args = plainStillArgs("materials/opening.mp4", 2.01, "materials.probe/materials__opening.mp4.png");
  assert.deepEqual(args, [
    "-y", "-v", "error",
    "-ss", "2.010",
    "-i", "materials/opening.mp4",
    "-frames:v", "1",
    "materials.probe/materials__opening.mp4.png",
  ]);
});
