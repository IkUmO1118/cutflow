import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolveProfile } from "./profile.ts";
import { buildRenderProps } from "./renderProps.ts";
import { renderCfgWithDesign } from "./designAsset.ts";
import { mergeIntervals } from "./timeline.ts";
import type { Config } from "./config.ts";
import type { EditSnapshot } from "./review.ts";
import type { Profile } from "./profile.ts";
import type { Interval, Manifest, Overlays } from "../types.ts";
import type { RenderProps } from "./renderPropsTypes.ts";

export interface SnapshotRenderInput {
  dir: string;
  cfg: Config;
  snapshot: EditSnapshot;
  fullRes?: boolean;
}

export interface SnapshotRenderContext {
  manifest: Manifest;
  keeps: Interval[];
  overlays: Overlays;
  profile: Profile;
  props: RenderProps;
}

function readJson<T>(dir: string, file: string, fallback: T | null): T {
  const p = join(dir, file);
  if (!existsSync(p)) {
    if (fallback !== null) return fallback;
    throw new Error(`${file} がありません。先にパイプライン(run)を実行してください`);
  }
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

function assertRecordingRelativePath(dir: string, file: string, label: string): void {
  const root = resolve(dir);
  const abs = resolve(dir, file);
  if (abs !== root && abs.startsWith(root + sep)) return;
  throw new Error(`${label} が収録フォルダ外を指しています: ${file}`);
}

function assertSnapshotPathsWithinRoot(dir: string, snapshot: EditSnapshot, fullRes?: boolean): void {
  for (const item of snapshot.overlays.overlays ?? []) {
    assertRecordingRelativePath(dir, item.file, "overlay file");
  }
  for (const item of snapshot.overlays.inserts ?? []) {
    assertRecordingRelativePath(dir, item.file, "insert file");
  }
  if (!fullRes) return;
  const manifest = readJson<Manifest>(dir, "manifest.json", null);
  assertRecordingRelativePath(dir, manifest.source, "manifest.source");
}

export function readEditSnapshot(dir: string): EditSnapshot {
  return {
    cutplan: readJson<EditSnapshot["cutplan"]>(dir, "cutplan.json", null),
    transcript: readJson<EditSnapshot["transcript"]>(dir, "transcript.json", null),
    overlays: readJson<EditSnapshot["overlays"]>(dir, "overlays.json", {}),
    bgm: existsSync(join(dir, "bgm.json"))
      ? readJson<NonNullable<EditSnapshot["bgm"]>>(dir, "bgm.json", null)
      : null,
  };
}

export function resolveSnapshotRenderContext(input: SnapshotRenderInput): SnapshotRenderContext {
  const { dir, cfg, snapshot, fullRes } = input;
  assertSnapshotPathsWithinRoot(dir, snapshot, fullRes);
  const manifest = readJson<Manifest>(dir, "manifest.json", null);

  const keeps = mergeIntervals(snapshot.cutplan.segments.filter((s) => s.action === "keep"));
  const overlays = snapshot.overlays;
  const profile = resolveProfile(manifest.video.screenRegion, "default");
  if (keeps.length === 0) {
    throw new Error("keep 区間が0件です(cutplan.json を確認してください)");
  }

  const props = buildRenderProps({
    manifest,
    keeps,
    transcript: snapshot.transcript,
    overlays,
    renderCfg: renderCfgWithDesign(dir, cfg),
    width: profile.width,
    height: profile.height,
    profile,
    // stills projects have no video source/proxy. The composition is driven by
    // inserts, while cut.m4a supplies the narration during final rendering.
    videoFile: manifest.layout === "stills"
      ? ""
      : (fullRes ? manifest.source : "proxy.mp4"),
    videoIsSource: true,
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: (file) => existsSync(join(dir, file)),
    warn: () => {},
  });
  return { manifest, keeps, overlays, profile, props };
}

export function buildSnapshotRenderProps(input: SnapshotRenderInput): RenderProps {
  return resolveSnapshotRenderContext(input).props;
}
