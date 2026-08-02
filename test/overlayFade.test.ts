import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_EXT_RE, isImageFile } from "../src/lib/overlayFade.ts";
import { classifyKind } from "../src/lib/materials.ts";

test("isImageFile / classifyKind: tiff・heic・heif を同じ画像判定にする", () => {
  for (const file of ["materials/a.tif", "materials/a.tiff", "materials/a.heic", "materials/a.heif"]) {
    assert.equal(isImageFile(file), true);
    assert.equal(IMAGE_EXT_RE.test(file), true);
    assert.equal(classifyKind(file), "image");
  }
});

test("isImageFile: 動画拡張子は画像にならない", () => {
  for (const file of ["a.mp4", "a.mov", "a.mkv", "a.webm"]) {
    assert.equal(isImageFile(file), false);
  }
});
