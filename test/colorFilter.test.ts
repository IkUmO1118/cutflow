// lib/colorFilter.ts — 簡易カラー調整(overlays.json の colorFilter)を CSS
// filter 文字列に変換する純関数。未指定・全既定(1.0)は無補正(undefined)を
// 固定する(remotion/Main.tsx が使う)。P5-3: ffmpegColorFilterOf(CSS →
// ffmpeg の lutrgb/colorchannelmixer 写像。design-T3.md §1・§2・§6)を追記。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cssFilterOf, ffmpegColorFilterOf } from "../src/lib/colorFilter.ts";
import type { ColorFilter } from "../src/types.ts";

test("cssFilterOf: 未指定はフィルタなし(undefined)", () => {
  assert.equal(cssFilterOf(undefined), undefined);
});

test("cssFilterOf: 空オブジェクト(全既定 1.0)もフィルタなし", () => {
  assert.equal(cssFilterOf({}), undefined);
});

test("cssFilterOf: 一部指定(残りは既定 1 を補う)", () => {
  assert.equal(cssFilterOf({ brightness: 1.2 }), "brightness(1.2) contrast(1) saturate(1)");
});

test("cssFilterOf: 全指定", () => {
  assert.equal(
    cssFilterOf({ brightness: 1.05, contrast: 1.1, saturate: 0.9 }),
    "brightness(1.05) contrast(1.1) saturate(0.9)",
  );
});

// ---- ffmpegColorFilterOf (P5-3) ----

test("ffmpegColorFilterOf: 未指定/空/全1.0 は none", () => {
  assert.deepEqual(ffmpegColorFilterOf(undefined), { kind: "none" });
  assert.deepEqual(ffmpegColorFilterOf({}), { kind: "none" });
  assert.deepEqual(ffmpegColorFilterOf({ brightness: 1, contrast: 1, saturate: 1 }), { kind: "none" });
});

// 不変条件(最重要): cssFilterOf(cf) === undefined ⟺ ffmpegColorFilterOf(cf).kind === "none"
// (= Remotion と FAST の「無補正の定義」が未来永劫ずれない)
const invariantCases: (ColorFilter | undefined)[] = [
  undefined,
  {},
  { brightness: 1 },
  { contrast: 1 },
  { saturate: 1 },
  { brightness: 1, contrast: 1 },
  { brightness: 1, saturate: 1 },
  { contrast: 1, saturate: 1 },
  { brightness: 0.1 },
  { contrast: 0.1 },
  { saturate: 0.1 },
  { brightness: 2 },
  { contrast: 2 },
  { saturate: 2 },
  { saturate: 2.0776 },
  { saturate: 3 },
  { brightness: 1.05, contrast: 1.1, saturate: 0.9 },
  { brightness: 1.4, contrast: 0.7, saturate: 1.6 },
  { brightness: 1.1, contrast: 1, saturate: 1 },
  { brightness: 1, contrast: 1.1, saturate: 1 },
  { brightness: 1, contrast: 1, saturate: 1.1 },
  { brightness: 0.99999 },
];

for (const cf of invariantCases) {
  test(`不変条件: cssFilterOf/ffmpegColorFilterOf の無補正判定が一致(${JSON.stringify(cf)})`, () => {
    const cssNone = cssFilterOf(cf) === undefined;
    const ffmpegNone = ffmpegColorFilterOf(cf).kind === "none";
    assert.equal(cssNone, ffmpegNone);
  });
}

test("ffmpegColorFilterOf: 通し例のスナップショット(brightness1.1 contrast1.2 saturate0.9)", () => {
  const plan = ffmpegColorFilterOf({ brightness: 1.1, contrast: 1.2, saturate: 0.9 });
  assert.equal(plan.kind, "chain");
  if (plan.kind !== "chain") return;
  assert.deepEqual(plan.filters, [
    "lutrgb=r='clip((val/255*1.1-0.5)*1.2+0.5,0,1)*255':g='clip((val/255*1.1-0.5)*1.2+0.5,0,1)*255':b='clip((val/255*1.1-0.5)*1.2+0.5,0,1)*255'",
    "colorchannelmixer=rr=0.9213:rg=0.0715:rb=0.0072:gr=0.0213:gg=0.9715:gb=0.0072:br=0.0213:bg=0.0715:bb=0.9072",
  ]);
});

test("ffmpegColorFilterOf: 恒等成分をスキップ(contrast のみ → lutrgb 1本)", () => {
  const plan = ffmpegColorFilterOf({ contrast: 1.2 });
  assert.equal(plan.kind, "chain");
  if (plan.kind !== "chain") return;
  assert.equal(plan.filters.length, 1);
  assert.ok(plan.filters[0].startsWith("lutrgb="));
});

test("ffmpegColorFilterOf: 恒等成分をスキップ(saturate のみ → colorchannelmixer 1本)", () => {
  const plan = ffmpegColorFilterOf({ saturate: 0.9 });
  assert.equal(plan.kind, "chain");
  if (plan.kind !== "chain") return;
  assert.equal(plan.filters.length, 1);
  assert.ok(plan.filters[0].startsWith("colorchannelmixer="));
});

test("ffmpegColorFilterOf: saturate=0 はグレースケール行列", () => {
  const plan = ffmpegColorFilterOf({ saturate: 0 });
  assert.equal(plan.kind, "chain");
  if (plan.kind !== "chain") return;
  assert.equal(
    plan.filters[0],
    "colorchannelmixer=rr=0.213:rg=0.715:rb=0.072:gr=0.213:gg=0.715:gb=0.072:br=0.213:bg=0.715:bb=0.072",
  );
});

test("ffmpegColorFilterOf: saturate=2.5 は表現不能(colorchannelmixer レンジ超過)", () => {
  const plan = ffmpegColorFilterOf({ saturate: 2.5 });
  assert.equal(plan.kind, "unsupported");
  if (plan.kind !== "unsupported") return;
  assert.ok(plan.reason.includes("saturate"));
  assert.ok(plan.reason.includes("colorchannelmixer"));
});

test("ffmpegColorFilterOf: saturate=2.0 は表現可能(境界内)", () => {
  const plan = ffmpegColorFilterOf({ saturate: 2.0 });
  assert.equal(plan.kind, "chain");
  if (plan.kind !== "chain") return;
  assert.ok(plan.filters[0].includes("bb=1.928"));
});

test("ffmpegColorFilterOf: saturate=2.08 は表現不能(境界外)", () => {
  const plan = ffmpegColorFilterOf({ saturate: 2.08 });
  assert.equal(plan.kind, "unsupported");
});

test("ffmpegColorFilterOf: 数値整形は指数表記・浮動小数のゴミを出さない", () => {
  const plan = ffmpegColorFilterOf({ brightness: 1.1, contrast: 1.2, saturate: 0.9 });
  assert.equal(plan.kind, "chain");
  if (plan.kind !== "chain") return;
  for (const f of plan.filters) {
    assert.ok(!/e[+-]/.test(f), `指数表記を含む: ${f}`);
    const nums = f.match(/-?\d+\.\d+/g) ?? [];
    for (const n of nums) {
      const decimals = n.split(".")[1];
      assert.ok(decimals.length <= 6, `小数が6桁を超える: ${n} in ${f}`);
    }
  }
});
