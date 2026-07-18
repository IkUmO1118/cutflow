// lib/hyperframeCdn.ts — B2: pinned CDN script table for HyperFrames
// composition cards. Browser-safe (imported from remotion/HyperFrame.tsx's
// bundle indirectly via hyperframe.ts) — NO `node:` imports here.
//
// Invariant: every pixel-affecting input to a composition is either inlined
// in the HTML body (author CSS/JS/data:) or SRI-fixed via this table (a
// pinned <script src> whose bytes are locked by `integrity`, so a CDN swap
// cannot silently change render output). Adding a pin is a **human-only**
// act: append a literal entry below with a `sha384-...` value obtained by
// curling the file and hashing it yourself (e.g. `openssl dgst -sha384
// -binary file | openssl base64 -A`) — never hand-write or guess a sha384
// value, and never let an LLM compute one.

export interface CdnPin {
  url: string;
  integrity: string;
  lib: string;
}

export const CDN_PINS: readonly CdnPin[] = [
  {
    url: "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
    integrity: "sha384-sG0Hv1tP1lZCk9KQmrIbY/XNwi+OY84GQqhMscbnsoBFqAz8KNCil1kvfL3Hbbk2",
    lib: "gsap",
  },
  {
    url: "https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js",
    integrity: "sha384-J8C0MvgX4WP58J4N2W99vCKd2J6z99ynOJ5bEfE6jeP7kVTW1drYtv/jzrxM5jbm",
    lib: "lottie",
  },
];

export const CDN_SCRIPT_HOSTS: readonly string[] = [...new Set(CDN_PINS.map((p) => new URL(p.url).origin))];

/** CSP の script-src に入れる完全 URL。origin だけを許可すると、card の
 * inline script が動的に生成した未ピン留めの jsdelivr script まで取得でき、
 * URL+SRI 完全一致という CDN_PINS の不変条件を迂回できる。 */
export const CDN_SCRIPT_URLS: readonly string[] = CDN_PINS.map((p) => p.url);

export type PinMatch =
  | { status: "match"; pin: CdnPin }
  | { status: "not-in-table" }
  | { status: "missing-integrity"; pin: CdnPin }
  | { status: "integrity-mismatch"; pin: CdnPin };

/** Matches a `<script src>` (and its `integrity` attribute, if any) against
 * CDN_PINS. Comparison is exact (trim only) — no normalization of the URL
 * (no query-string stripping, no case-folding). */
export function matchCdnPin(src: string | undefined, integrity: string | undefined): PinMatch {
  const url = (src || "").trim();
  const pin = CDN_PINS.find((p) => p.url === url);
  if (!pin) return { status: "not-in-table" };
  const trimmedIntegrity = integrity !== undefined ? integrity.trim() : "";
  if (trimmedIntegrity === "") return { status: "missing-integrity", pin };
  if (trimmedIntegrity !== pin.integrity) return { status: "integrity-mismatch", pin };
  return { status: "match", pin };
}
