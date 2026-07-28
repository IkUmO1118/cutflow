// src/engine/runtime/sourcePool.ts — 素材オーバーレイ/insert 用に複数ソース
// (source id ごとに1 FrameSource)を管理するプール(M3a Phase2)。
// 同時デコーダ数の上限を超えたら最終アクセスが最も古いものから LRU close する。
import { FrameSource } from "./frameSource.ts";

/** 既定の同時デコーダ数上限。ベース映像1 + 素材/insert 複数を想定した控えめな値
 * (WebCodecs のハードウェアデコーダ数には実機上限があるため無制限にしない) */
export const DEFAULT_MAX_CONCURRENT_SOURCES = 6;

/**
 * アクセス順リスト(先頭が最古)と上限から、追い出すべき sourceId を返す純関数。
 * 追加後のサイズが上限を超えていなければ null(何も追い出さない)。
 */
export function decideEviction(
  accessOrder: readonly string[],
  maxConcurrent: number,
): string | null {
  if (accessOrder.length <= maxConcurrent) return null;
  return accessOrder[0] ?? null;
}

/**
 * sourceId(≒URL) → FrameSource の解決関数。実運用では
 * `(sourceId) => \`/media/${encodeURIComponent(sourceId)}\`` のように
 * editor サーバの Range 対応配信 URL へマップする(server.ts の `/media/`
 * ルート。CLAUDE.md 経由の契約は変えない=読み取り専用の GET のみ使う)。
 */
export type SourceUrlResolver = (sourceId: string) => string;

export class SourcePool {
  private readonly sources = new Map<string, FrameSource>();
  private readonly accessOrder: string[] = [];
  private readonly maxConcurrent: number;
  private readonly resolveUrl: SourceUrlResolver;

  constructor(resolveUrl: SourceUrlResolver, maxConcurrent = DEFAULT_MAX_CONCURRENT_SOURCES) {
    this.resolveUrl = resolveUrl;
    this.maxConcurrent = maxConcurrent;
  }

  /** sourceId に対応する FrameSource を返す(無ければ作る)。LRU 順を更新する */
  acquire(sourceId: string): FrameSource {
    this.touch(sourceId);
    let source = this.sources.get(sourceId);
    if (!source) {
      source = new FrameSource(sourceId, this.resolveUrl(sourceId));
      this.sources.set(sourceId, source);
    }
    this.evictIfNeeded();
    return source;
  }

  private touch(sourceId: string): void {
    const i = this.accessOrder.indexOf(sourceId);
    if (i !== -1) this.accessOrder.splice(i, 1);
    this.accessOrder.push(sourceId);
  }

  private evictIfNeeded(): void {
    for (;;) {
      const victim = decideEviction(this.accessOrder, this.maxConcurrent);
      // 直近アクセス(末尾)は追い出さない(今まさに使っているソースを
      // 上限超過の1件目として即座に閉じてしまう事故を避ける)
      if (victim === null || victim === this.accessOrder[this.accessOrder.length - 1]) return;
      this.close(victim);
    }
  }

  private close(sourceId: string): void {
    const source = this.sources.get(sourceId);
    if (source) {
      source.dispose();
      this.sources.delete(sourceId);
    }
    const i = this.accessOrder.indexOf(sourceId);
    if (i !== -1) this.accessOrder.splice(i, 1);
  }

  /** 保持中の VideoFrame 数の合計(リークカウンタ。§6 完了基準) */
  get openSampleCount(): number {
    let total = 0;
    for (const source of this.sources.values()) total += source.openSampleCount;
    return total;
  }

  get size(): number {
    return this.sources.size;
  }

  disposeAll(): void {
    for (const source of this.sources.values()) source.dispose();
    this.sources.clear();
    this.accessOrder.length = 0;
  }
}
