import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  tokenizeRetrievalText,
  type RetrievalDocument,
  type RetrievalDocumentKind,
  type RetrievalIndex,
} from "../lib/retrieval.ts";

const INPUTS = [
  "meta.json",
  "chapters.json",
  "transcript.json",
  "materials.probe/index.json",
] as const;

export function retrievalIndexPath(recordingsDir: string): string {
  return join(recordingsDir, ".cutflow", "retrieval-v1.json");
}

export function buildRetrievalIndex(recordingsDir: string): RetrievalIndex {
  const old = readExisting(retrievalIndexPath(recordingsDir));
  const warnings: string[] = [];
  const recordings: RetrievalIndex["recordings"] = [];
  const documents: RetrievalDocument[] = [];
  for (const entry of readdirSync(recordingsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(recordingsDir, entry.name);
    if (!existsSync(join(dir, "manifest.json"))) continue;
    try {
      const fingerprint = recordingFingerprint(dir);
      const mtimeMs = Math.max(...["manifest.json", ...INPUTS]
        .map((file) => join(dir, file))
        .filter(existsSync)
        .map((file) => statSync(file).mtimeMs));
      recordings.push({ name: entry.name, fingerprint, mtimeMs });
      const oldRecording = old?.recordings.find((item) => item.name === entry.name);
      if (old && oldRecording?.fingerprint === fingerprint) {
        documents.push(...old.documents.filter((doc) => doc.recordingDir === entry.name));
      } else {
        documents.push(...documentsForRecording(dir, entry.name, fingerprint, warnings));
      }
    } catch (error) {
      warnings.push(`${entry.name}: ${(error as Error).message}`);
    }
  }
  const index: RetrievalIndex = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    root: basename(recordingsDir),
    recordings: recordings.sort((a, b) => a.name.localeCompare(b.name)),
    documents: documents.sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
  };
  const path = retrievalIndexPath(recordingsDir);
  mkdirSync(join(recordingsDir, ".cutflow"), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
  renameSync(tmp, path);
  return index;
}

function documentsForRecording(
  dir: string,
  recording: string,
  fingerprint: string,
  warnings: string[],
): RetrievalDocument[] {
  const out: RetrievalDocument[] = [];
  add(out, recording, "recording", recording, recording, undefined, undefined, fingerprint);
  readJson(dir, "meta.json", warnings, (value) => {
    add(out, recording, "meta", String(value.title ?? recording), JSON.stringify(value), "meta.json", undefined, fingerprint);
  });
  readJson(dir, "chapters.json", warnings, (value) => {
    for (const [index, chapter] of arrayAt(value, "chapters").entries()) {
      add(out, recording, "chapter", String(chapter.title ?? `chapter ${index + 1}`),
        String(chapter.summary ?? chapter.description ?? chapter.title ?? ""), "chapters.json",
        numericRange(chapter), fingerprint, String(index));
    }
  });
  readJson(dir, "transcript.json", warnings, (value) => {
    for (const [index, caption] of arrayAt(value, "segments").entries()) {
      add(out, recording, "caption", String(caption.text ?? ""), String(caption.text ?? ""),
        "transcript.json", numericRange(caption), fingerprint, String(index));
    }
  });
  readJson(dir, "materials.probe/index.json", warnings, (value) => {
    const candidates = Array.isArray(value) ? value : arrayAt(value, "materials");
    for (const [index, material] of candidates.entries()) {
      const file = String(material.file ?? material.path ?? "");
      const title = file || `material ${index + 1}`;
      add(out, recording, "material", title, JSON.stringify(material), file || undefined, undefined, fingerprint, String(index));
      const ocr = textFrom(material.ocr);
      if (ocr) add(out, recording, "material-ocr", title, ocr, file || undefined, undefined, fingerprint, `${index}:ocr`);
      const transcript = textFrom(material.transcript);
      if (transcript) add(out, recording, "material-transcript", title, transcript, file || undefined, undefined, fingerprint, `${index}:transcript`);
    }
  });
  return out;
}

function add(
  out: RetrievalDocument[],
  recordingDir: string,
  kind: RetrievalDocumentKind,
  title: string,
  text: string,
  file: string | undefined,
  sourceRange: { startSec: number; endSec: number } | undefined,
  fingerprint: string,
  suffix = "",
): void {
  const id = createHash("sha256").update(`${recordingDir}\0${kind}\0${file ?? ""}\0${suffix}`).digest("hex").slice(0, 20);
  out.push({
    id,
    recordingDir,
    kind,
    title,
    text,
    ...(file ? { file } : {}),
    ...(sourceRange ? { sourceRange } : {}),
    fingerprint,
    tokens: tokenizeRetrievalText(`${title}\n${file ?? ""}\n${text}`),
  });
}

function recordingFingerprint(dir: string): string {
  const hash = createHash("sha256");
  for (const name of ["manifest.json", ...INPUTS]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const stat = statSync(file);
    hash.update(`${name}\0${stat.size}\0${stat.mtimeMs}\n`);
  }
  return hash.digest("hex");
}

function readExisting(path: string): RetrievalIndex | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as RetrievalIndex;
    return value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

function readJson(
  dir: string,
  name: string,
  warnings: string[],
  consume: (value: Record<string, unknown>) => void,
): void {
  const file = join(dir, name);
  if (!existsSync(file)) return;
  try {
    consume(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
  } catch (error) {
    warnings.push(`${basename(dir)}/${name}: ${(error as Error).message}`);
  }
}

function arrayAt(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const array = value[key];
  return Array.isArray(array) ? array.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

function numericRange(value: Record<string, unknown>): { startSec: number; endSec: number } | undefined {
  const start = value.startSec ?? value.start;
  const end = value.endSec ?? value.end;
  return typeof start === "number" && typeof end === "number" ? { startSec: start, endSec: end } : undefined;
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(textFrom).filter(Boolean).join(" ");
  }
  return "";
}
