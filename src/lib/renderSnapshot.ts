import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { defaultShortProfileName, resolveProfile } from "./profile.ts";
import { buildRenderProps } from "./renderProps.ts";
import { mergeIntervals } from "./timeline.ts";
import { hasCamera } from "../types.ts";
import type { Config } from "./config.ts";
import type { EditSnapshot } from "./review.ts";
import type { Profile } from "./profile.ts";
import type { Interval, Manifest, Overlays, Shorts } from "../types.ts";
import type { RenderProps } from "../../remotion/props.ts";

export interface SnapshotRenderInput {
  dir: string;
  cfg: Config;
  snapshot: EditSnapshot;
  shortName?: string;
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

function readOptionalJson<T>(dir: string, file: string): T | null {
  const p = join(dir, file);
  if (!existsSync(p)) return null;
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

function resolveShort(shorts: Shorts | null, name: string) {
  if (!shorts) {
    throw new Error("shorts.json がありません(このフォルダにショートは未定義です)");
  }
  const short = shorts.shorts.find((s) => s.name === name);
  if (!short) {
    throw new Error(
      `ショートが見つかりません: ${name}(shorts.json の name 一覧: ` +
        `${shorts.shorts.map((s) => s.name).join(", ") || "(なし)"})`,
    );
  }
  return short;
}

export function readEditSnapshot(dir: string): EditSnapshot {
  return {
    cutplan: readJson<EditSnapshot["cutplan"]>(dir, "cutplan.json", null),
    transcript: readJson<EditSnapshot["transcript"]>(dir, "transcript.json", null),
    overlays: readJson<EditSnapshot["overlays"]>(dir, "overlays.json", {}),
    bgm: readOptionalJson<EditSnapshot["bgm"]>(dir, "bgm.json"),
    shorts: readOptionalJson<EditSnapshot["shorts"]>(dir, "shorts.json"),
  };
}

export function resolveSnapshotRenderContext(input: SnapshotRenderInput): SnapshotRenderContext {
  const { dir, cfg, snapshot, shortName, fullRes } = input;
  assertSnapshotPathsWithinRoot(dir, snapshot, fullRes);
  const manifest = readJson<Manifest>(dir, "manifest.json", null);

  let keeps: Interval[];
  let overlays: Overlays;
  let profile: Profile;
  if (shortName) {
    const short = resolveShort(snapshot.shorts, shortName);
    keeps = mergeIntervals(short.ranges);
    overlays = {
      captionTracks: short.captionTracks,
      ...(snapshot.overlays.colorFilter ? { colorFilter: snapshot.overlays.colorFilter } : {}),
    };
    profile = resolveProfile(
      manifest.video.screenRegion,
      short.profile ?? defaultShortProfileName(hasCamera(manifest)),
    );
  } else {
    keeps = mergeIntervals(snapshot.cutplan.segments.filter((s) => s.action === "keep"));
    overlays = snapshot.overlays;
    profile = resolveProfile(manifest.video.screenRegion, "default");
  }
  if (keeps.length === 0) {
    throw new Error(
      shortName
        ? `ショート "${shortName}" の ranges が0件です(shorts.json を確認してください)`
        : "keep 区間が0件です(cutplan.json を確認してください)",
    );
  }

  const props = buildRenderProps({
    manifest,
    keeps,
    transcript: snapshot.transcript,
    overlays,
    renderCfg: cfg.render,
    width: profile.width,
    height: profile.height,
    profile,
    videoFile: fullRes ? manifest.source : "proxy.mp4",
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
