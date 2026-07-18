// test/hyperframeCdn.test.ts — src/lib/hyperframeCdn.ts(B2 CDN ピン表+
// matchCdnPin)の固定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CDN_SCRIPT_HOSTS, matchCdnPin } from "../src/lib/hyperframeCdn.ts";

const GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";
const GSAP_INTEGRITY = "sha384-sG0Hv1tP1lZCk9KQmrIbY/XNwi+OY84GQqhMscbnsoBFqAz8KNCil1kvfL3Hbbk2";

test("matchCdnPin: exact gsap url+integrity is a match", () => {
  const r = matchCdnPin(GSAP_URL, GSAP_INTEGRITY);
  assert.equal(r.status, "match");
});

test("matchCdnPin: wrong version is not-in-table", () => {
  const r = matchCdnPin("https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js", GSAP_INTEGRITY);
  assert.equal(r.status, "not-in-table");
});

test("matchCdnPin: correct url with undefined integrity is missing-integrity", () => {
  const r = matchCdnPin(GSAP_URL, undefined);
  assert.equal(r.status, "missing-integrity");
});

test("matchCdnPin: correct url, valid-format but wrong sha is integrity-mismatch", () => {
  const r = matchCdnPin(GSAP_URL, "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(r.status, "integrity-mismatch");
});

test("CDN_SCRIPT_HOSTS deep-equals [https://cdn.jsdelivr.net]", () => {
  assert.deepEqual(CDN_SCRIPT_HOSTS, ["https://cdn.jsdelivr.net"]);
});
