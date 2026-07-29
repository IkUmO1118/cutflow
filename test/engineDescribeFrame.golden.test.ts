// src/engine/describeFrame.ts の snapshot golden(M2 Phase3)。
// test/fixtures/engine/*.props.json(bench 由来の値を織り込んだ固定 fixture)を
// 代表時刻(keep内/カット境界直後/zoom中/wipe中/カラオケ中/annotation表示中/
// blur表示中/PiPオーバーレイ/挿入クリップ中/ショート)で descriptor 化し、
// test/fixtures/engine/golden.json と byte 一致で固定する(決定性2層契約の
// 上層)。descriptor の翻訳ロジックを変えて絵が変わったときだけ、このゴールデンを
// 意図的に更新する(母艦 §4: 既存 golden の書き換えは設計違反=止まって報告)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeFrame } from "../src/engine/describeFrame.ts";
import type { RenderProps } from "../remotion/props.ts";

const fixturesDir = join(import.meta.dirname, "fixtures", "engine");
const mainProps: RenderProps = JSON.parse(readFileSync(join(fixturesDir, "main.props.json"), "utf8"));
const shortProps: RenderProps = JSON.parse(readFileSync(join(fixturesDir, "short.props.json"), "utf8"));

/** 代表時刻の一覧(名前→[fixture, tOut])。§design doc Phase3 が要求する
 * 種別(keep内/カット境界直後/zoom中/wipe中/カラオケ中/annotation表示中/
 * ショート)を全てカバーし、blur・PiPオーバーレイ・挿入クリップも加える */
const SCENARIOS: { name: string; props: RenderProps; tOut: number }[] = [
  { name: "keep_normal", props: mainProps, tOut: 10 },
  { name: "insert_mid", props: mainProps, tOut: 0.5 },
  { name: "karaoke_mid", props: mainProps, tOut: 64.5 },
  { name: "zoom_mid", props: mainProps, tOut: 101.5 },
  { name: "wipe_mid", props: mainProps, tOut: 120.2 },
  { name: "caption_anim_mid", props: mainProps, tOut: 150.5 },
  { name: "blur_visible", props: mainProps, tOut: 132 },
  { name: "annotation_visible", props: mainProps, tOut: 142 },
  { name: "blur_and_annotation", props: mainProps, tOut: 137 },
  { name: "overlay_pip", props: mainProps, tOut: 155.5 },
  { name: "cut_boundary", props: mainProps, tOut: 190 },
  { name: "short_default_pos", props: shortProps, tOut: 10 },
  { name: "short_explicit_pos", props: shortProps, tOut: 30 },
];

test("describeFrame: 代表時刻の descriptor が golden.json と byte 一致する", () => {
  const combined: Record<string, unknown> = {};
  for (const s of SCENARIOS) {
    combined[s.name] = describeFrame(s.props, s.tOut);
  }
  const actual = JSON.stringify(combined, null, 2) + "\n";
  const golden = readFileSync(join(fixturesDir, "golden.json"), "utf8");
  assert.equal(actual, golden);
});
