import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBrowserDisplayable, isHighBitDepth } from "../src/lib/mediaCodec.ts";

test("h264 8bit is displayable, no reason", () => {
  const v = classifyBrowserDisplayable({ codecName: "h264", pixFmt: "yuv420p" });
  assert.equal(v.browserDisplayable, true);
  assert.equal(v.reason, undefined);
});

test("avc1 alias is displayable", () => {
  const v = classifyBrowserDisplayable({ codecName: "avc1", pixFmt: "yuv420p" });
  assert.equal(v.browserDisplayable, true);
});

test("prores is not displayable, reason mentions ProRes", () => {
  const v = classifyBrowserDisplayable({ codecName: "prores", pixFmt: "yuv422p10le", profile: "HQ" });
  assert.equal(v.browserDisplayable, false);
  assert.match(v.reason ?? "", /ProRes/);
});

test("hevc is not displayable, reason mentions HEVC", () => {
  const v = classifyBrowserDisplayable({ codecName: "hevc", pixFmt: "yuv420p10le" });
  assert.equal(v.browserDisplayable, false);
  assert.match(v.reason ?? "", /HEVC/);
});

test("vp9 is displayable", () => {
  const v = classifyBrowserDisplayable({ codecName: "vp9", pixFmt: "yuv420p" });
  assert.equal(v.browserDisplayable, true);
});

test("vp8 is displayable", () => {
  const v = classifyBrowserDisplayable({ codecName: "vp8" });
  assert.equal(v.browserDisplayable, true);
});

test("av1 is displayable (documented optimistic allow)", () => {
  const v = classifyBrowserDisplayable({ codecName: "av1" });
  assert.equal(v.browserDisplayable, true);
});

test("h264 10bit (High 10) is not displayable", () => {
  const v = classifyBrowserDisplayable({ codecName: "h264", pixFmt: "yuv420p10le" });
  assert.equal(v.browserDisplayable, false);
  assert.match(v.reason ?? "", /10bit/);
});

test("missing facts degrade to displayable", () => {
  const v = classifyBrowserDisplayable({});
  assert.equal(v.browserDisplayable, true);
  assert.equal(v.codec, "unknown");
});

test("empty codec name degrades to displayable", () => {
  const v = classifyBrowserDisplayable({ codecName: "" });
  assert.equal(v.browserDisplayable, true);
  assert.equal(v.codec, "unknown");
});

// mjpeg is listed in design §1's allowlist/denylist TABLE as a NOT-displayable
// "professional/intermediate" codec (with mpeg2video/dnxhd/ffv1/rawvideo/vc1),
// so it is a POSITIVE denylist match here, not an "unknown, degrade" case.
test("mjpeg is not displayable (positive denylist match per design §1 table)", () => {
  const v = classifyBrowserDisplayable({ codecName: "mjpeg" });
  assert.equal(v.browserDisplayable, false);
  assert.match(v.reason ?? "", /MJPEG/);
});

test("isHighBitDepth detects 10/12bit pix_fmt suffixes", () => {
  assert.equal(isHighBitDepth("yuv420p10le"), true);
  assert.equal(isHighBitDepth("p010le"), true);
  assert.equal(isHighBitDepth("yuv420p"), false);
  assert.equal(isHighBitDepth(undefined), false);
});
