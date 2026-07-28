// src/engine/hash.ts — FrameDescriptor の rendered content 用コンテンツハッシュ。
// 同期・純関数(crypto.subtle は async なので不採用)。FNV-1a 64bit を自前実装。
// ハッシュ材料は「解決済み仕様の安定 stringify(キー順ソート) + 出力解像度」
// (docs/plans/2026-07-28-engine-m2-frame-descriptor-design.md §2)。

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64bit ハッシュ(16桁 hex 固定長)。同期・決定論。
 * キャッシュキー用途であり暗号学的ハッシュではない */
export function fnv1a64(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, "0");
}

/** JSON.stringify のキー順を安定化する(オブジェクトキーをソートしてから
 * 文字列化。配列順は意味を持つのでそのまま) */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      sorted[key] = sortKeysDeep(input[key]);
    }
    return sorted;
  }
  return value;
}

/** rendered content の contentHash。材料は「解決済み仕様の安定 stringify +
 * 出力解像度」。同一ハッシュ = 同一ラスタ結果になることがバックエンドの
 * テクスチャキャッシュ判定の前提(render.fast/captions/*.png と同じ発想) */
export function contentHashOf(content: unknown, size: { w: number; h: number }): string {
  return fnv1a64(stableStringify({ content, size }));
}
