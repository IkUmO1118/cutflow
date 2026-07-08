import { ID_RE } from "./ids.ts";
import type { Bgm, CutPlan, Overlays, Shorts, Transcript } from "../types.ts";

/** 差分レビューが扱う「GUI が保持する編集ドキュメントの束」。 */
export interface ReviewDocs {
  cutplan: CutPlan;
  overlays: Overlays;
  transcript: Transcript;
  bgm: Bgm | null;
  shorts: Shorts | null;
}

export type ReviewFileKey = keyof ReviewDocs;

export interface HunkAddress {
  file: ReviewFileKey;
  arrayKey?: string;
  elementId?: string;
  field?: string;
  label: string;
}

export type HunkKind =
  | "file"
  | "element-add"
  | "element-remove"
  | "element-modify"
  | "field";

export interface Hunk {
  address: HunkAddress;
  kind: HunkKind;
  base: unknown;
  mine: unknown;
  theirs: unknown;
  conflict: boolean;
}

export interface ThreeWayResult {
  hunks: Hunk[];
  conflicts: Hunk[];
  cleanMerge: boolean;
}

export type Resolution = Map<Hunk, "theirs" | "mine">;
export type ProposalDiffResult = ThreeWayResult;
export type ProposalResolution = Resolution;

interface ArraySpec {
  file: ReviewFileKey;
  arrayKey: string;
}

const ARRAY_SPECS: ArraySpec[] = [
  { file: "cutplan", arrayKey: "segments" },
  { file: "transcript", arrayKey: "segments" },
  { file: "overlays", arrayKey: "overlays" },
  { file: "overlays", arrayKey: "inserts" },
  { file: "overlays", arrayKey: "wipeFull" },
  { file: "overlays", arrayKey: "hideCaption" },
  { file: "overlays", arrayKey: "captionTracks" },
  { file: "overlays", arrayKey: "zooms" },
  { file: "overlays", arrayKey: "blurs" },
  { file: "overlays", arrayKey: "annotations" },
  { file: "bgm", arrayKey: "tracks" },
  { file: "shorts", arrayKey: "shorts" },
];

const TOP_LEVEL_ARRAYS: Record<ReviewFileKey, Set<string>> = {
  cutplan: new Set(ARRAY_SPECS.filter((s) => s.file === "cutplan").map((s) => s.arrayKey)),
  overlays: new Set(ARRAY_SPECS.filter((s) => s.file === "overlays").map((s) => s.arrayKey)),
  transcript: new Set(ARRAY_SPECS.filter((s) => s.file === "transcript").map((s) => s.arrayKey)),
  bgm: new Set(ARRAY_SPECS.filter((s) => s.file === "bgm").map((s) => s.arrayKey)),
  shorts: new Set(ARRAY_SPECS.filter((s) => s.file === "shorts").map((s) => s.arrayKey)),
};

const FILE_KEYS: ReviewFileKey[] = ["cutplan", "overlays", "transcript", "bgm", "shorts"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepClone<T>(v: T): T {
  return v === null || v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function stripApproved<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripApproved(x)) as T;
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(v)) {
    if (k !== "approved") out[k] = stripApproved(value);
  }
  return out as T;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(stripApproved(a)) === JSON.stringify(stripApproved(b));
}

function validIdOf(v: unknown): string | null {
  if (!isObj(v) || typeof v.id !== "string" || !ID_RE.test(v.id)) return null;
  return v.id;
}

function arrayHasUsableIds(arrays: unknown[][]): boolean {
  const elems = arrays.flat();
  return elems.length > 0 && elems.every((x) => validIdOf(x) !== null);
}

function idMap(arr: unknown[]): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const x of arr) {
    const id = validIdOf(x);
    if (id) m.set(id, x);
  }
  return m;
}

function docOf(docs: ReviewDocs, file: ReviewFileKey): unknown {
  return docs[file];
}

function arrayOf(doc: unknown, key: string): unknown[] {
  if (!isObj(doc)) return [];
  const arr = doc[key];
  return Array.isArray(arr) ? arr : [];
}

function keysOfRecord(v: unknown): string[] {
  return isObj(v) ? Object.keys(v) : [];
}

function label(file: ReviewFileKey, arrayKey?: string, elementId?: string, field?: string): string {
  return [file, arrayKey, elementId, field ? `.${field}` : ""].filter(Boolean).join(" ");
}

function changedSide(base: unknown, mine: unknown, theirs: unknown): {
  mineChanged: boolean;
  theirsChanged: boolean;
  conflict: boolean;
} {
  const mineChanged = !equal(mine, base);
  const theirsChanged = !equal(theirs, base);
  return { mineChanged, theirsChanged, conflict: mineChanged && theirsChanged && !equal(mine, theirs) };
}

function pushHunk(
  out: Hunk[],
  address: Omit<HunkAddress, "label"> & { label?: string },
  kind: HunkKind,
  base: unknown,
  mine: unknown,
  theirs: unknown,
): void {
  if (equal(mine, theirs)) return;
  const changed = changedSide(base, mine, theirs);
  if (!changed.mineChanged && !changed.theirsChanged) return;
  const fullAddress: HunkAddress = {
    ...address,
    label: address.label ?? label(address.file, address.arrayKey, address.elementId, address.field),
  };
  out.push({
    address: fullAddress,
    kind,
    base: deepClone(stripApproved(base)),
    mine: deepClone(stripApproved(mine)),
    theirs: deepClone(stripApproved(theirs)),
    conflict: changed.conflict,
  });
}

function valueAt(v: unknown, path: string[]): unknown {
  let cur = v;
  for (const p of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function collectLeafPaths(base: unknown, mine: unknown, theirs: unknown, prefix: string[] = []): string[][] {
  if (prefix[0] === "id" || prefix[0] === "approved") return [];
  const values = [base, mine, theirs];
  if (values.every(isObj)) {
    const keys = new Set<string>();
    for (const v of values) for (const k of Object.keys(v)) keys.add(k);
    const out: string[][] = [];
    for (const k of [...keys].sort()) {
      if (k === "id" || k === "approved") continue;
      out.push(...collectLeafPaths(valueAt(base, [k]), valueAt(mine, [k]), valueAt(theirs, [k]), [...prefix, k]));
    }
    return out;
  }
  return [prefix];
}

function diffFields(
  out: Hunk[],
  file: ReviewFileKey,
  base: unknown,
  mine: unknown,
  theirs: unknown,
  arrayKey?: string,
  elementId?: string,
  prefix: string[] = [],
): void {
  for (const path of collectLeafPaths(base, mine, theirs)) {
    if (path.length === 0 && prefix.length === 0) continue;
    const fullPath = [...prefix, ...path];
    const field = fullPath.join(".");
    pushHunk(
      out,
      { file, arrayKey, elementId, field },
      "field",
      valueAt(base, path),
      valueAt(mine, path),
      valueAt(theirs, path),
    );
  }
}

function diffArray(out: Hunk[], spec: ArraySpec, baseDoc: unknown, mineDoc: unknown, theirsDoc: unknown): void {
  const baseArr = arrayOf(baseDoc, spec.arrayKey);
  const mineArr = arrayOf(mineDoc, spec.arrayKey);
  const theirsArr = arrayOf(theirsDoc, spec.arrayKey);
  if (!arrayHasUsableIds([baseArr, mineArr, theirsArr])) {
    pushHunk(
      out,
      { file: spec.file, arrayKey: spec.arrayKey },
      "file",
      baseArr.length ? baseArr : undefined,
      mineArr.length ? mineArr : undefined,
      theirsArr.length ? theirsArr : undefined,
    );
    return;
  }

  const baseMap = idMap(baseArr);
  const mineMap = idMap(mineArr);
  const theirsMap = idMap(theirsArr);
  const ids = new Set([...baseMap.keys(), ...mineMap.keys(), ...theirsMap.keys()]);
  for (const id of [...ids].sort()) {
    const base = baseMap.get(id);
    const mine = mineMap.get(id);
    const theirs = theirsMap.get(id);
    if (base === undefined || mine === undefined || theirs === undefined) {
      const kind: HunkKind =
        base === undefined ? "element-add" : mine === undefined || theirs === undefined ? "element-remove" : "element-modify";
      pushHunk(
        out,
        { file: spec.file, arrayKey: spec.arrayKey, elementId: id },
        kind,
        base,
        mine,
        theirs,
      );
      continue;
    }
    diffFields(out, spec.file, base, mine, theirs, spec.arrayKey, id);
  }
}

function diffTopLevel(out: Hunk[], file: ReviewFileKey, baseDoc: unknown, mineDoc: unknown, theirsDoc: unknown): void {
  if (!isObj(baseDoc) || !isObj(mineDoc) || !isObj(theirsDoc)) {
    pushHunk(out, { file }, "file", baseDoc, mineDoc, theirsDoc);
    return;
  }
  const arrayKeys = TOP_LEVEL_ARRAYS[file];
  const keys = new Set([...keysOfRecord(baseDoc), ...keysOfRecord(mineDoc), ...keysOfRecord(theirsDoc)]);
  for (const key of [...keys].sort()) {
    if (key === "approved" || arrayKeys.has(key)) continue;
    diffFields(out, file, baseDoc[key], mineDoc[key], theirsDoc[key], undefined, undefined, [key]);
  }
}

export function threeWayDiff(base: ReviewDocs, mine: ReviewDocs, theirs: ReviewDocs): ThreeWayResult {
  const hunks: Hunk[] = [];
  for (const file of FILE_KEYS) {
    const baseDoc = docOf(base, file);
    const mineDoc = docOf(mine, file);
    const theirsDoc = docOf(theirs, file);
    diffTopLevel(hunks, file, baseDoc, mineDoc, theirsDoc);
  }
  for (const spec of ARRAY_SPECS) {
    const baseDoc = docOf(base, spec.file);
    const mineDoc = docOf(mine, spec.file);
    const theirsDoc = docOf(theirs, spec.file);
    if (isObj(baseDoc) && isObj(mineDoc) && isObj(theirsDoc)) {
      diffArray(hunks, spec, baseDoc, mineDoc, theirsDoc);
    }
  }
  const conflicts = hunks.filter((h) => h.conflict);
  return { hunks, conflicts, cleanMerge: conflicts.length === 0 };
}

function ensureObj(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = parent[key];
  if (isObj(next)) return next;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function setPath(obj: unknown, field: string | undefined, value: unknown): unknown {
  if (!field) return deepClone(value);
  if (!isObj(obj)) return obj;
  const parts = field.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = ensureObj(cur, parts[i]);
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = deepClone(value);
  return obj;
}

function restoreApprovalsFrom(base: ReviewDocs, merged: ReviewDocs): void {
  merged.cutplan.approved = base.cutplan.approved;
  if (merged.shorts) {
    const baseByName = new Map((base.shorts?.shorts ?? []).map((s) => [s.name, s.approved]));
    merged.shorts.shorts = merged.shorts.shorts.map((s) => ({
      ...s,
      approved: baseByName.get(s.name) ?? false,
    }));
  }
}

function applyHunkValue(merged: ReviewDocs, hunk: Hunk, value: unknown): void {
  const doc = merged[hunk.address.file] as unknown;
  const { arrayKey, elementId, field } = hunk.address;
  if (arrayKey) {
    if (!isObj(doc)) return;
    if (!elementId) {
      if (value === undefined) delete doc[arrayKey];
      else doc[arrayKey] = deepClone(value);
      return;
    }
    const arr = Array.isArray(doc[arrayKey]) ? (doc[arrayKey] as unknown[]) : [];
    doc[arrayKey] = arr;
    const i = arr.findIndex((x) => validIdOf(x) === elementId);
    if (value === undefined) {
      if (i >= 0) arr.splice(i, 1);
      return;
    }
    if (field) {
      if (i < 0) arr.push(deepClone(value));
      else setPath(arr[i], field, value);
      return;
    }
    if (i >= 0) arr[i] = deepClone(value);
    else arr.push(deepClone(value));
    return;
  }
  const next = setPath(doc, field, value);
  (merged as unknown as Record<string, unknown>)[hunk.address.file] = next;
}

function applyMineValue(merged: ReviewDocs, hunk: Hunk): void {
  applyHunkValue(merged, hunk, hunk.mine);
}

export function applyResolution(
  theirs: ReviewDocs,
  result: ThreeWayResult,
  resolution: Resolution,
): ReviewDocs {
  const merged = deepClone(theirs);
  for (const hunk of result.hunks) {
    const side = hunk.conflict
      ? resolution.get(hunk) ?? "theirs"
      : !equal(hunk.mine, hunk.base) && equal(hunk.theirs, hunk.base)
        ? "mine"
        : "theirs";
    if (side === "mine") applyMineValue(merged, hunk);
  }
  restoreApprovalsFrom(theirs, merged);
  return merged;
}

export function proposalDiff(base: ReviewDocs, proposed: ReviewDocs): ProposalDiffResult {
  return threeWayDiff(base, base, proposed);
}

export function applyProposalResolution(
  base: ReviewDocs,
  _proposed: ReviewDocs,
  result: ProposalDiffResult,
  resolution: ProposalResolution,
): ReviewDocs {
  const merged = deepClone(base);
  for (const hunk of result.hunks) {
    const side = resolution.get(hunk) ?? "theirs";
    if (side === "theirs") applyHunkValue(merged, hunk, hunk.theirs);
  }
  restoreApprovalsFrom(base, merged);
  return merged;
}
