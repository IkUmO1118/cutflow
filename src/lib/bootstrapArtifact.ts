import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const BOOTSTRAP_CUT_REASON = "初期状態(全編)";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: JsonObject, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i]);
};

/** bootstrap の未編集初期値かを、マーカーと内容の両方で判定する。 */
export function isBootstrapArtifact(path: string): boolean {
  if (!existsSync(path)) return false;
  const file = basename(path);
  if (file !== "cutplan.json" && file !== "transcript.json") return false;
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(doc) || doc.generatedBy !== "bootstrap" || !Array.isArray(doc.segments)) return false;
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(path), "manifest.json"), "utf8"));
    if (!isObject(manifest) || typeof manifest.durationSec !== "number" || !Number.isFinite(manifest.durationSec)) {
      return false;
    }
    if (file === "transcript.json") {
      return hasExactKeys(doc, ["generatedBy", "segments"]) && doc.segments.length === 0;
    }
    if (!hasExactKeys(doc, ["approved", "generatedBy", "segments"]) || doc.approved !== false) return false;
    if (doc.segments.length !== 1) return false;
    const segment = doc.segments[0];
    return isObject(segment) &&
      hasExactKeys(segment, ["action", "start", "end", "reason"]) &&
      segment.action === "keep" &&
      segment.start === 0 &&
      segment.end === manifest.durationSec &&
      segment.reason === BOOTSTRAP_CUT_REASON;
  } catch {
    return false;
  }
}

/** 実際に書く文書から bootstrap マーカーを除く。 */
export function withoutBootstrapMarker<T>(doc: T): T {
  if (!isObject(doc) || !("generatedBy" in doc)) return doc;
  const next = { ...doc };
  delete next.generatedBy;
  return next as T;
}
