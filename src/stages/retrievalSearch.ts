import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { searchIndex, type RetrievalQuery, type RetrievalResult, type RetrievalIndex } from "../lib/retrieval.ts";
import { buildRetrievalIndex, retrievalIndexPath } from "./retrievalIndex.ts";

export function retrievalSearch(
  recordingsDir: string,
  query: RetrievalQuery,
  rebuild = false,
): RetrievalResult[] {
  const index = rebuild
    ? buildRetrievalIndex(recordingsDir)
    : readIndexOrBuild(recordingsDir);
  return searchIndex(index, {
    ...query,
    currentRecording: query.currentRecording ? basename(query.currentRecording) : undefined,
  });
}

function readIndexOrBuild(recordingsDir: string): RetrievalIndex {
  try {
    const index = JSON.parse(readFileSync(retrievalIndexPath(recordingsDir), "utf8")) as RetrievalIndex;
    if (index.schemaVersion === 1) return index;
  } catch {
    // Missing or stale-format indexes are rebuilt on demand.
  }
  return buildRetrievalIndex(recordingsDir);
}
