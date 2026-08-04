import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileOps } from "../src/lib/applyEdits.ts";
import { stampDocs } from "../src/lib/ids.ts";
import { collectIdOccurrences } from "../src/lib/mention.ts";
import { buildRenderProps, normalizeLayerOrder } from "../src/lib/renderProps.ts";
import { defaultProps } from "../src/lib/renderPropsTypes.ts";
import type { RenderProps } from "../src/lib/renderPropsTypes.ts";
import { describeFrame } from "../src/engine/describeFrame.ts";
import { captionLines } from "../src/engine/refPainter.ts";
import { validateDocs } from "../src/stages/validate.ts";
import type { Config } from "../src/lib/config.ts";
import type { EditableDocs } from "../src/lib/ids.ts";
import type { LoadedDocs } from "../src/stages/validate.ts";
import type { ApplyBody, EditOp, LayerId, Manifest, Overlays, Transcript } from "../src/types.ts";

const DIR = "/tmp/framewright-text-overlays-test";

function docs(overlays: Overlays): LoadedDocs {
  return {
    manifest: { durationSec: 20 },
    cutplan: {
      approved: false,
      segments: [
        { start: 0, end: 5, action: "keep", reason: "本編" },
        { start: 5, end: 10, action: "cut", reason: "不要" },
        { start: 10, end: 20, action: "keep", reason: "本編" },
      ],
    },
    transcript: { segments: [] },
    overlays,
    bgm: null,
    chapters: null,
    meta: null,
    thumbnail: null,
  };
}

const manifest: Manifest = {
  dir: DIR,
  source: "raw.mkv",
  durationSec: 20,
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  },
  audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
  createdAt: "2026-08-04T00:00:00Z",
};

const renderCfg: Config["render"] = {
  wipeWidthPx: 480,
  wipeMarginPx: 32,
  captionFontSizePx: 52,
  chapterCardSec: 3,
  targetLufs: -14,
  bgm: { volumeDb: -22, fadeOutSec: 2 },
};

function renderProps(overlays: Overlays, transcript: Transcript = { segments: [] }) {
  return buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 5 }, { start: 10, end: 20 }],
    transcript,
    overlays,
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
}

test("validate: 正常な texts はエラーなし", () => {
  const r = validateDocs(DIR, docs({
    texts: [{ start: 1, end: 3, text: "タイトル", pos: { x: 960, y: 540 } }],
  }));
  assert.deepEqual(r.errors, []);
});

test("validate: pos 欠落 / text 空 / start>=end は err", () => {
  const r = validateDocs(DIR, docs({
    texts: [
      { start: 1, end: 3, text: "x" } as never,
      { start: 1, end: 3, text: "", pos: { x: 1, y: 1 } },
      { start: 4, end: 4, text: "x", pos: { x: 1, y: 1 } },
    ],
  }));
  assert.ok(r.errors.some((e) => e.where === "texts[0]" && e.message.includes("pos")));
  assert.ok(r.errors.some((e) => e.where === "texts[1]" && e.message.includes("text")));
  assert.ok(r.errors.some((e) => e.where === "texts[2]" && e.message.includes("start")));
});

test("validate: style.karaoke は warn で err ではない", () => {
  const r = validateDocs(DIR, docs({
    texts: [{
      start: 1,
      end: 3,
      text: "タイトル",
      pos: { x: 960, y: 540 },
      style: { karaoke: { mode: "word" } },
    }],
  }));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.where === "texts[0]" && w.message.includes("カラオケ")));
});

test("validate: texts の reasonId は系不整合を警告しない", () => {
  const r = validateDocs(DIR, docs({
    texts: [{
      start: 1,
      end: 3,
      text: "タイトル",
      pos: { x: 960, y: 540 },
      reasonId: "concept-talk",
    }],
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.filter((w) => w.where === "texts[0].reasonId"), []);
});

test("validate: texts の reasonId でも未知 id は警告・非文字列はエラー", () => {
  const unknown = validateDocs(DIR, docs({
    texts: [{ start: 1, end: 3, text: "タイトル", pos: { x: 960, y: 540 }, reasonId: "unknown-id" }],
  }));
  assert.deepEqual(unknown.errors, []);
  assert.ok(unknown.warnings.some((w) => w.where === "texts[0].reasonId" && w.message.includes("未知")));

  const nonString = validateDocs(DIR, docs({
    texts: [{ start: 1, end: 3, text: "タイトル", pos: { x: 960, y: 540 }, reasonId: 1 } as never],
  }));
  assert.ok(nonString.errors.some((e) => e.where === "texts[0].reasonId" && e.message.includes("文字列")));
});

test("validate: overlays.max.json の texts は警告ゼロで通る", () => {
  const overlays = JSON.parse(readFileSync("schemas/examples/overlays.max.json", "utf8")) as Overlays;
  const r = validateDocs(DIR, {
    manifest: { durationSec: 200 },
    cutplan: { approved: false, segments: [{ start: 0, end: 200, action: "keep", reason: "all" }] },
    transcript: { segments: [] },
    overlays,
    bgm: null,
    chapters: null,
    meta: null,
    thumbnail: null,
  });
  assert.deepEqual(r.errors.filter((e) => e.where.startsWith("texts[")), []);
  assert.deepEqual(r.warnings.filter((w) => w.where.startsWith("texts[")), []);
});

test("normalizeLayerOrder: texts 1本では layerOrder に text を足さない", () => {
  assert.deepEqual(normalizeLayerOrder(undefined, 1, 1, 1), ["ov1", "wipe", "caption"]);
});

test("buildRenderProps: texts はカット後秒へ写像され、未指定ならキー自体が載らない", () => {
  const without = renderProps({});
  assert.equal(Object.hasOwn(without, "texts"), false);

  const props = renderProps({
    texts: [{ start: 11, end: 13, text: "後半", pos: { x: 100, y: 120 }, anchor: "topLeft" }],
  });
  assert.deepEqual(props.texts, [{
    start: 6,
    end: 8,
    text: "後半",
    pos: { x: 100, y: 120 },
    anchor: "topLeft",
  }]);
});

test("buildRenderProps: 挿入をまたぐ text は複数断片に割れる", () => {
  const props = renderProps({
    inserts: [{ at: 4, file: "insert.mp4", durationSec: 2 }],
    texts: [{ start: 3, end: 12, text: "またぐ", pos: { x: 960, y: 540 } }],
  });
  assert.deepEqual(props.texts?.map((t) => [t.start, t.end]), [[3, 4], [6, 9]]);
});

test("describeFrame: 表示区間内だけ rendered item が出て layerOrder text でも二重描画しない", () => {
  const props = {
    ...defaultProps,
    videoFile: "cut.mp4",
    width: 1920,
    height: 1080,
    canvas: { w: 1920, h: 1080 },
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    texts: [{ start: 1, end: 3, text: "A", pos: { x: 960, y: 540 } }],
  };
  const inside = describeFrame(props, 2).items.filter((i) => i.kind === "rendered" && i.content.kind === "caption");
  assert.equal(inside.length, 1);
  const outside = describeFrame(props, 4).items.filter((i) => i.kind === "rendered" && i.content.kind === "caption");
  assert.equal(outside.length, 0);

  const explicit = describeFrame({ ...props, layerOrder: ["ov1", "wipe", "caption", "text"] }, 2)
    .items.filter((i) => i.kind === "rendered" && i.content.kind === "caption");
  assert.equal(explicit.length, 1);
});

test("describeFrame: texts 未指定なら items は不変 / 改行は captionLines で複数行", () => {
  const base = { ...defaultProps, videoFile: "cut.mp4" };
  assert.deepEqual(describeFrame(base, 1).items, describeFrame({ ...base, texts: undefined }, 1).items);

  const withText = describeFrame({
    ...base,
    texts: [{ start: 0, end: 2, text: "上\n下", pos: { x: 960, y: 540 } }],
  }, 1);
  const item = withText.items.find((i) => i.kind === "rendered" && i.content.kind === "caption");
  assert.ok(item && item.kind === "rendered" && item.content.kind === "caption");
  assert.equal(captionLines(item.content).length, 2);
});

test("mention / applyEdits / idStamp: texts を @id 対象として扱える", () => {
  const loaded = docs({
    texts: [{ id: "txt_aaaaaa", start: 1, end: 3, text: "旧", pos: { x: 1, y: 2 } }],
  });
  const occ = collectIdOccurrences(loaded).find(([id]) => id === "txt_aaaaaa");
  assert.equal(occ?.[1].file, "overlays.json");
  assert.equal(occ?.[1].kind, "text");
  assert.equal(occ?.[1].path, "texts[0]");

  const setOps: EditOp[] = [{ op: "set", target: "@txt_aaaaaa", field: "text", value: "新" }];
  const setResult = compileOps(loaded, setOps);
  assert.deepEqual(setResult.errors, []);
  assert.equal((setResult.body.overlays as ApplyBody["overlays"])?.texts?.[0].text, "新");

  const addOps: EditOp[] = [{
    op: "add",
    target: "overlays.texts",
    value: { start: 11, end: 12, text: "追加", pos: { x: 3, y: 4 } },
  }];
  const addResult = compileOps(loaded, addOps);
  assert.deepEqual(addResult.errors, []);
  assert.equal(addResult.body.overlays?.texts?.length, 2);

  const removeResult = compileOps(loaded, [{ op: "remove", target: "@txt_aaaaaa" }]);
  assert.deepEqual(removeResult.errors, []);
  assert.equal(removeResult.body.overlays?.texts?.length, 0);

  const stamped = stampDocs({
    cutplan: null,
    transcript: null,
    overlays: {
      texts: [
        { start: 1, end: 2, text: "未採番", pos: { x: 1, y: 1 } },
        { id: "txt_keep01", start: 2, end: 3, text: "既存", pos: { x: 2, y: 2 } },
      ],
    },
    chapters: null,
    bgm: null,
    thumbnail: null,
  } satisfies EditableDocs);
  assert.match(stamped.overlays!.texts![0].id as string, /^txt_[0-9a-z]{6}$/);
  assert.equal(stamped.overlays!.texts![1].id, "txt_keep01");
});

test("縦プロファイル(ショート)でもテキストが描かれる(テロップと揃える)", () => {
  // canvas が landscape 以外だと resolveCanvas が profile.layout を返し
  // props.layout が入る。annotations は「本編のみ」だがテキストはタイトル用途で
  // ショートでこそ要る。テロップ(layerOrder 経由)が縦でも描かれるのと揃える
  const base = {
    ...defaultProps,
    videoFile: "proxy.mp4",
    width: 1080,
    height: 1920,
    canvas: { w: 1080, h: 1920 },
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    captions: [{ start: 0, end: 5, text: "テロップ", track: 1 }],
    texts: [{ start: 0, end: 5, text: "テキスト", pos: { x: 540, y: 400 } }],
  };
  const captionsOf = (p: RenderProps) =>
    describeFrame(p, 2).items
      .filter((i) => i.kind === "rendered" && i.content.kind === "caption")
      .map((i) => (i.kind === "rendered" && i.content.kind === "caption" ? i.content.text : ""));

  const landscape = captionsOf(base as RenderProps);
  const portrait = captionsOf({
    ...base,
    layout: { panels: [{ source: "screen", rect: { x: 0, y: 420, w: 1080, h: 608 }, fit: "contain" }] },
  } as RenderProps);
  assert.deepEqual(landscape, ["テロップ", "テキスト"]);
  assert.deepEqual(portrait, ["テロップ", "テキスト"], "縦でもテキストが消えない");
});

test("音声主体の収録(videoFile 空)でもテキストが描かれる(テロップと揃える)", () => {
  // manifest.layout = "stills"(音声ファイル主体)のとき editor の
  // videoFileForPreview は "" を返す。テキストはベース映像を参照しない
  // 自己完結レイヤーなので、ベース映像が無くても描かれないといけない
  // (ここで落とすと音声主体プロジェクトで texts が丸ごと出ない)
  const base = {
    ...defaultProps,
    width: 1080,
    height: 1920,
    canvas: { w: 1080, h: 1920 },
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    captions: [{ start: 0, end: 5, text: "テロップ", track: 1 }],
    texts: [{ start: 0, end: 5, text: "テキスト", pos: { x: 540, y: 400 } }],
  };
  const captionsOf = (p: RenderProps) =>
    describeFrame(p, 2).items
      .filter((i) => i.kind === "rendered" && i.content.kind === "caption")
      .map((i) => (i.kind === "rendered" && i.content.kind === "caption" ? i.content.text : ""));

  // テロップが描かれる条件と完全に一致させる(テロップだけ出てテキストが
  // 消える、という前回の症状をそのまま固定する)
  assert.deepEqual(
    captionsOf({ ...base, videoFile: "" } as RenderProps),
    ["テロップ", "テキスト"],
    "videoFile 空でもテキストが消えない",
  );
  assert.deepEqual(
    captionsOf({ ...base, videoFile: "proxy.mp4" } as RenderProps),
    ["テロップ", "テキスト"],
  );
});

test("layerOrder の text の位置で描画順(重なり)が変わる", () => {
  const p = {
    ...defaultProps,
    videoFile: "proxy.mp4",
    width: 1920,
    height: 1080,
    canvas: { w: 1920, h: 1080 },
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    captions: [{ start: 0, end: 5, text: "TELOP", track: 1 }],
    texts: [{ start: 0, end: 5, text: "TEXT", pos: { x: 100, y: 100 } }],
  };
  const seq = (layerOrder: LayerId[]) =>
    describeFrame({ ...p, layerOrder } as RenderProps, 2).items
      .filter((i) => i.kind === "rendered" && i.content.kind === "caption")
      .map((i) => (i.kind === "rendered" && i.content.kind === "caption" ? i.content.text : ""));
  // 配列は下→上。後ろに置いたほうが前面に出る
  assert.deepEqual(seq(["ov1", "wipe", "caption", "text"]), ["TELOP", "TEXT"]);
  assert.deepEqual(seq(["ov1", "wipe", "text", "caption"]), ["TEXT", "TELOP"]);
});

test("validate: layerOrder の text<N> を受け付ける(GUI が text2 を書いても保存できる)", () => {
  const r = validateDocs(DIR, docs({
    texts: [
      { start: 1, end: 3, text: "1本目", pos: { x: 960, y: 540 } },
      { start: 1, end: 3, text: "2本目", pos: { x: 960, y: 700 }, track: 2 },
    ],
    layerOrder: ["ov1", "wipe", "caption", "text", "text2"],
  }));
  assert.deepEqual(r.errors, []);
});

test("validate: texts[].track が 0 / 小数ならエラー", () => {
  const r = validateDocs(DIR, docs({
    texts: [
      { start: 1, end: 3, text: "a", pos: { x: 1, y: 1 }, track: 0 },
      { start: 1, end: 3, text: "b", pos: { x: 1, y: 1 }, track: 1.5 },
    ],
  }));
  assert.equal(r.errors.filter((e) => e.where.endsWith(".track")).length, 2);
});

test("validate: 未知のレイヤーは従来どおりエラー(text の緩和で穴を開けない)", () => {
  const r = validateDocs(DIR, docs({ layerOrder: ["ov1", "wipe", "caption", "texture"] }));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /不明なレイヤーです/);
});
