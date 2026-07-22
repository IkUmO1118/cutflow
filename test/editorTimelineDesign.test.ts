import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("P3 adds one scoped root while preserving Timeline semantic hooks", () => {
  const timeline = read("editor/client/Timeline.tsx");
  assert.match(timeline, /<div className="timeline ocTimeline" style=\{\{ height \}\}>/);
  for (const hook of [
    "tlToolbar", "tlTool", "tlSnap", "tlZoom", "zoomSlider", "tlBody",
    "tlLabels", "tlRulerSpacer", "tlLabelScroll", "tlLabel", "tlResize",
    "tlRename", "trackEye", "trackMute", "trackDel", "grip", "tlScroll",
    "tlContent", "tlRuler", "tlTick", "tlTrack", "tlClip", "tlWave",
    "tlEdge", "tlClipLabel", "tlCutMark", "tlGhost", "tlDropGhost",
    "tlSnapLine", "tlPlayhead", "tlPlayheadCap",
  ]) assert.ok(timeline.includes(hook), `lost Timeline semantic hook ${hook}`);
});

test("P3 preserves output-time geometry, ruler math, row geometry, and virtualization", () => {
  const timeline = read("editor/client/Timeline.tsx");
  for (const contract of [
    "const pps = fitPps * zoom",
    "const totalW = Math.max(viewW, Math.ceil(duration * pps))",
    "return Math.min(Math.max(x / pps, 0), duration)",
    "const RULER_H = 24",
    "Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, trackHeights[id] ?? ROW_H))",
    "left: clip.outStart * pps",
    "width: Math.max(6, (clip.outEnd - clip.outStart) * pps)",
    "left: m.out * pps + m.stack * 10",
    "left: Math.min(ghost.a, ghost.b) * pps",
    "width: Math.abs(ghost.b - ghost.a) * pps",
    "left: drop.t * pps",
    "width: Math.max(6, dragDurSec * pps)",
    "Math.floor(e.currentTarget.scrollLeft / VIRT_CHUNK)",
    "const [from, to] = visibleRange(g)",
  ]) assert.ok(timeline.includes(contract), `lost geometry contract: ${contract}`);
});

test("P3 preserves pointer, drag, resize, create, select, drop, and keyboard handlers", () => {
  const timeline = read("editor/client/Timeline.tsx");
  for (const handler of [
    "onPointerDown={onRulerDown}",
    'onPointerDown={(e) => onClipDown(e, clip, "move")}',
    'onPointerDown={(e) => onClipDown(e, clip, "trim-start")}',
    'onPointerDown={(e) => onClipDown(e, clip, "trim-end")}',
    "onPointerDown={(e) => onResizeDown(e, t.id)}",
    "onPointerDown={(e) => onTrackDown(e, track)}",
    "onDragOver={onDragOverTimeline}",
    "onDragLeave={onDragLeaveTimeline}",
    "onDrop={onDropTimeline}",
    "onToggleCaptionSel(clip.index)",
    "onDragStart({ kind: clip.kind, index: clip.index }, mode, clip)",
    "onDragMove(delta, tracks[trackIndexAt(ev.clientY)].id)",
    "onDragEnd()",
    "onReorderTrack(t.id, target)",
    "onCreate(g.track, s, en)",
    "onDropMaterial(track, t, path)",
    "onDropFile(track, t, f)",
    'if (e.key === "Enter") (e.target as HTMLInputElement).blur()',
    'else if (e.key === "Escape") setRenaming(null)',
  ]) assert.ok(timeline.includes(handler), `lost behavior hook: ${handler}`);
  assert.ok((timeline.match(/if \(e\.button !== 0\) return/g) ?? []).length >= 5);
  assert.doesNotMatch(timeline, /onContextMenu=/);
});

test("P3 keeps toolbar actions, state affordances, and their titles", () => {
  const timeline = read("editor/client/Timeline.tsx");
  for (const action of [
    "onAddTrack(kind)", "onUndo", "onRedo", "onSplit", "onDelete",
    "setSnapOn((v) => !v)", "applyZoom(1 / 1.5)", "setZoomTo(2 ** Number(e.target.value))",
    "applyZoom(0)", "applyZoom(1.5)", "onToggleTrackHide(t.layer as LayerId)",
    "onToggleTrackMute(audio)", "onRemoveTrack(t.id)", "onRenameTrack(t.renamableCaption as number, renaming.value)",
    "onSelectCaptionTrack(t.renamableCaption)",
  ]) assert.ok(timeline.includes(action), `lost action ${action}`);
  for (const title of [
    "トラックを追加(種類を選択)", "元に戻す (⌘Z)", "やり直す (⇧⌘Z)",
    "再生ヘッド位置でクリップを分割", "選択中のクリップを削除",
    "吸着(ドロップ・クリップの移動・左右トリムで", "縮小(⌘+スクロールでも可)",
    "拡大(⌘+スクロールでも可)", "ドラッグでトラックの高さを変更",
  ]) assert.ok(timeline.includes(title), `lost title ${title}`);
});

test("P3 styles every CutFlow clip family and all timeline states inside its scope", () => {
  const css = read("editor/client/styles.css");
  for (const kind of [
    "cut", "insert", "caption", "wipe", "wipeFull", "zoom", "blur",
    "annotation", "bgm", "short",
  ]) assert.ok(css.includes(`.ocTimeline .tlClip.${kind}`), `missing clip skin ${kind}`);
  // Overlay clips retain the existing per-track inline OV_COLORS mapping.
  const timeline = read("editor/client/Timeline.tsx");
  assert.match(timeline, /clip\.kind === "overlays"[\s\S]*background: ovColor\(clip\.track\)/);
  for (const state of [
    ".tlClip:hover:not(.static)", ".tlClip.sel", ".tlLabel:hover", ".tlLabel.sel",
    ".tlLabel .trackMute.muted", ".tlLabel .trackEye.off", ".tlTrack.layerHidden .tlClip",
    ".tlTrack.dropOk", ".tlTrack.dropActive", ".tlGhost", ".tlDropGhost",
    ".tlSnapLine", ".tlPlayhead", ".tlPlayheadCap",
  ]) assert.ok(css.includes(`.ocTimeline ${state}`), `missing Timeline state ${state}`);
});

test("P3 skin covers compact toolbar, ruler, headers, zoom, scrollbars, and narrow widths", () => {
  const css = read("editor/client/styles.css");
  for (const selector of [
    ".ocTimeline .tlToolbar", ".ocTimeline .tlRuler", ".ocTimeline .tlTick",
    ".ocTimeline .tlLabels", ".ocTimeline .tlLabel", ".ocTimeline .tlZoom",
    ".ocTimeline .tlZoom .zoomSlider", ".ocTimeline .tlScroll::-webkit-scrollbar",
  ]) assert.ok(css.includes(selector), `missing P3 selector ${selector}`);
  assert.match(css, /@container \(max-width: 1100px\)[\s\S]*\.ocTimeline \.tlLabels \{ width: 8\.75rem; \}/);
  assert.match(css, /@container \(max-width: 760px\)[\s\S]*\.ocTimeline \.tlLabels \{ width: 7\.75rem; \}/);
  assert.match(css, /\.ocTimeline \.tlToolbar[\s\S]*:focus-visible/);
  assert.match(css, /\.ocTimeline \.tlScroll[\s\S]*scrollbar-width: thin/);
  assert.doesNotMatch(css, /\.ocTimeline[\s\S]*\.ocInspector/);
});

test("P3 provenance records the visual-only boundary and no context menu", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");
  assert.match(provenance, /P3 adapts the pinned OpenCut editor-layout and token sources/);
  assert.match(provenance, /output-time geometry, raw-time write mapping/);
  assert.match(provenance, /No secondary-button context menu is introduced/);
});

test("P6.6 timeline parity: playhead primary+round, clip rounded-sm + single primary ring, zoom de-pilled", () => {
  const css = read("editor/client/styles.css");
  assert.match(css, /\.ocTimeline \.tlPlayhead \{[\s\S]*background: hsl\(var\(--oc-primary\)\)/);
  assert.match(css, /\.ocTimeline \.tlPlayheadCap \{[\s\S]*border-radius: 50%[\s\S]*clip-path: none/);
  assert.match(css, /\.ocTimeline \.tlClip \{[\s\S]*border-radius: 0\.2rem/);
  assert.match(css, /\.ocTimeline \.tlClip\.sel \{[\s\S]*box-shadow: 0 0 0 1\.5px hsl\(var\(--oc-primary\)\)/);
  assert.match(css, /\.ocTimeline \.tlZoom \{[\s\S]*border: none/);
});

test("P7.4c material overlays with volume>0 get an in-clip waveform", () => {
  const app = read("editor/client/App.tsx");
  // audible video material contributes a wave in the clip build
  assert.match(app, /\(sp\.volume \?\? 0\) > 0 && VIDEO_EXT_RE\.test\(sp\.file\)\s*\?\s*\{ wave: \{ src: sp\.file, startSec: sp\.startFrom \?\? 0 \} \}/);
  // and its peaks are prefetched
  assert.match(app, /for \(const sp of overlays\?\.overlays \?\? \[\]\)[\s\S]*requestPeaks\(sp\.file\)/);
});
