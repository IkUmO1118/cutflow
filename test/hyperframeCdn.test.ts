// test/hyperframeCdn.test.ts — src/lib/hyperframeCdn.ts(B2 CDN ピン表+
// matchCdnPin)の固定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CDN_SCRIPT_HOSTS, CDN_SCRIPT_URLS, matchCdnPin } from "../src/lib/hyperframeCdn.ts";

const GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";
const GSAP_INTEGRITY = "sha384-sG0Hv1tP1lZCk9KQmrIbY/XNwi+OY84GQqhMscbnsoBFqAz8KNCil1kvfL3Hbbk2";

const LOTTIE_URL = "https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js";
const LOTTIE_INTEGRITY = "sha384-J8C0MvgX4WP58J4N2W99vCKd2J6z99ynOJ5bEfE6jeP7kVTW1drYtv/jzrxM5jbm";

const ANIME_URL = "https://cdn.jsdelivr.net/npm/animejs@3.2.2/lib/anime.min.js";
const ANIME_INTEGRITY = "sha384-oLmuahJgYYR1aWgZwdMQQ2AClE6A2eEwV2x1Z7cbIHehfkkmommQLH3wX1NDEszb";

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

test("matchCdnPin: exact lottie-web url+integrity is a match (B4)", () => {
  const r = matchCdnPin(LOTTIE_URL, LOTTIE_INTEGRITY);
  assert.equal(r.status, "match");
});

test("matchCdnPin: lottie-web wrong version is not-in-table (B4)", () => {
  const r = matchCdnPin(
    "https://cdn.jsdelivr.net/npm/lottie-web@5.12.1/build/player/lottie.min.js",
    LOTTIE_INTEGRITY,
  );
  assert.equal(r.status, "not-in-table");
});

test("matchCdnPin: exact animejs 3.2.2 url+measured integrity is a match (X2)", () => {
  assert.equal(matchCdnPin(ANIME_URL, ANIME_INTEGRITY).status, "match");
  assert.equal(
    matchCdnPin("https://cdn.jsdelivr.net/npm/animejs@3.2.1/lib/anime.min.js", ANIME_INTEGRITY).status,
    "not-in-table",
  );
});

test("CDN_SCRIPT_HOSTS still deep-equals [https://cdn.jsdelivr.net] after adding lottie (regression)", () => {
  assert.deepEqual(CDN_SCRIPT_HOSTS, ["https://cdn.jsdelivr.net"]);
});

test("CDN_SCRIPT_URLS contains only the exact pinned URLs used by CSP", () => {
  assert.deepEqual(CDN_SCRIPT_URLS, [GSAP_URL, LOTTIE_URL, ANIME_URL]);
});
