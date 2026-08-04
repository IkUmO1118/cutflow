import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

test("ruler-zone drop creates a new track without touching the per-track drop path", () => {
  const timeline = read("editor/client/Timeline.tsx");

  // 帯の判定はビューポート座標(scrollTop を足さない)
  assert.match(timeline, /const NEW_TRACK_ZONE_H = RULER_H \+ 6;/);
  const zoneStart = timeline.indexOf("const inNewTrackZone = (clientY: number): boolean =>");
  assert.ok(zoneStart >= 0, "inNewTrackZone が無い");
  const zoneBody = timeline.slice(zoneStart, timeline.indexOf("\n  };", zoneStart));
  assert.match(zoneBody, /clientY - el\.getBoundingClientRect\(\)\.top/);
  assert.ok(!zoneBody.includes("scrollTop"), "帯の判定にコンテンツ座標を使わない");

  // 既存の行ドロップ経路はそのまま残っている
  assert.ok(timeline.includes("onDropMaterial(track, t, path)"));
  assert.ok(timeline.includes("onDropFile(track, t, f)"));
  // 新規トラック経路は別の呼び出しで、行 id を渡さない
  assert.ok(timeline.includes("onDropMaterialNewTrack(t, path)"));
  assert.ok(timeline.includes("onDropFileNewTrack(t, nf)"));

  // drop() の分岐順: PRESET → 新規トラック → 行ドロップ
  const dropStart = timeline.indexOf("const onDropTimeline = (e: ReactDragEvent) => {");
  const dropBody = timeline.slice(dropStart, timeline.indexOf("\n  };", dropStart));
  assert.ok(dropBody.indexOf("getData(PRESET_MIME)") < dropBody.indexOf("getData(MATERIAL_MIME)"));
  assert.ok(dropBody.indexOf("if (newTrack) {") < dropBody.indexOf("onDropMaterial(track, t, path)"));

  // 新規トラック中は行/ラベルのハイライトも行内ゴーストも出さない
  assert.match(timeline, /drop === null \|\| drop\.newTrack/);
  assert.match(timeline, /drop && !drop\.newTrack && drop\.track === t\.id \? " dropActive"/);
  assert.match(timeline, /\{drop && !drop\.newTrack && drop\.track === track\.id && \(/);
  // 目印はルーラーの下線だけ(帯の塗り・ゴーストは出さない)
  assert.match(timeline, /className=\{`tlRuler\$\{drop\?\.newTrack \? " dropNewTrack" : ""\}`\}/);
  assert.ok(!timeline.includes("tlNewTrackGhost"), "ルーラーにゴーストを出さない");
});

test("App decides the new track and never writes track-creation code for it", () => {
  const app = read("editor/client/App.tsx");

  // 採番は「必ず今ある素材トラックの上」。占有の最大番号だけで決めると
  // layerOrder に空のまま残っている素材トラックを拾ってしまう(回帰 pin)
  assert.match(
    app,
    /const occupiedOvTracks = \(overlays\?\.overlays \?\? \[\]\)\.map\(overlayTrack\);/,
  );
  assert.match(
    app,
    /const newOverlayTrackNo =\s*\n?\s*occupiedOvTracks\.length === 0 \? 1 : Math\.max\(ovTracks, \.\.\.occupiedOvTracks\) \+ 1;/,
  );

  const h1 = app.indexOf("const onDropMaterialNewTrack = (outT: number, file: string) => {");
  const h2 = app.indexOf("const onDropFileNewTrack = (outT: number, f: File) => {");
  assert.ok(h1 >= 0 && h2 >= 0, "新規トラック用ハンドラが無い");
  const body = app.slice(h1, app.indexOf("\n  };", h2));
  // 音声のみ = BGM、それ以外 = 新しい素材トラック
  assert.match(body, /AUDIO_ONLY_RE\.test\(file\)\) onDropMaterial\("bgm", outT, file\)/);
  assert.match(body, /onDropMaterial\(ovId\(newOverlayTrackNo\), outT, file\)/);
  assert.match(body, /AUDIO_ONLY_RE\.test\(f\.name\)\) onDropFile\("bgm", outT, f\)/);
  assert.match(body, /onDropFile\(ovId\(newOverlayTrackNo\), outT, f\)/);
  // トラック生成コードは書かない(addOverlaySpan の既存処理に任せる)
  for (const forbidden of ["layerOrder", "addTrack(", "setOverlays("]) {
    assert.ok(!body.includes(forbidden), `新規トラック経路が ${forbidden} を触っている`);
  }

  // Timeline へ渡す props
  assert.match(app, /onDropFileNewTrack=\{onDropFileNewTrack\}/);
  assert.match(app, /onDropMaterialNewTrack=\{onDropMaterialNewTrack\}/);
  assert.match(app, /newOverlayTrackId=\{ovId\(newOverlayTrackNo\)\}/);
});

test("App counts text tracks from texts entries as well as layerOrder", () => {
  const app = read("editor/client/App.tsx");
  const textTracksAt = app.indexOf("const textTracks = useMemo(() => {");
  assert.ok(textTracksAt >= 0, "textTracks useMemo が無い");
  const body = app.slice(textTracksAt, app.indexOf("\n  }, [layerOrder, overlays]);", textTracksAt));
  assert.match(body, /fromOrder[\s\S]*layerOrder\.reduce/);
  assert.match(body, /fromEntries[\s\S]*overlays\?\.texts/);
  assert.match(body, /textTrack\(t\)/);
  assert.match(app, /const newTextTrackNo = \(overlays\?\.texts \?\? \[\]\)\.length === 0 \? 1 : textTracks \+ 1;/);
});

test("the new-track drop hint is a blue ruler underline in both timeline CSS layers", () => {
  const css = read("editor/client/styles.css");
  for (const selector of [".tlRuler.dropNewTrack", ".ocTimeline .tlRuler.dropNewTrack"])
    assert.ok(css.includes(selector), `missing CSS pin ${selector}`);
  // 高さを動かさない下線(border ではなく inset shadow)。帯は塗らない
  assert.equal((css.match(/inset 0 -2px 0 hsl\(var\(--oc-primary\)\)/g) ?? []).length, 2);
  assert.ok(!css.includes(".tlNewTrackGhost"), "ゴーストの skin は残さない");
});
