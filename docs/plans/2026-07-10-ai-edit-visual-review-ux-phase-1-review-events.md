# Phase 1: ReviewEvent Foundation

*2026-07-10 / 実装担当: gpt-5.4 想定*

親設計:

- `docs/plans/2026-07-10-ai-edit-visual-review-ux-implementation-design.md`
- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-0-index.md`

目的:

- 既存 `Hunk[]` を、動画編集者向けの `ReviewEvent[]` に変換する。
- UI / server / save path は触らない。
- この phase は純関数と unit test だけで終える。

---

## 1. 触るファイル

追加:

- `src/lib/reviewEvents.ts`
- `test/reviewEvents.test.ts`

触らない:

- `editor/client/App.tsx`
- `editor/client/DiffReview.tsx`
- `editor/server.ts`
- `src/lib/docDiff.ts`

---

## 2. 型

`src/lib/reviewEvents.ts` に追加する。

```ts
import type { Hunk } from "./docDiff.ts";
import type { ReviewBundle } from "../stages/review.ts";

export type ReviewEventKind =
  | "cut"
  | "caption"
  | "overlay"
  | "insert"
  | "annotation"
  | "blur"
  | "zoom"
  | "wipe"
  | "caption-track"
  | "bgm"
  | "short"
  | "json";

export type ReviewEventStatus = "use" | "skip" | "mixed" | "unreviewed";

export interface ReviewEventTimeRange {
  axis: "source" | "output";
  startSec: number;
  endSec: number;
}

export interface ReviewEvent {
  id: string;
  kind: ReviewEventKind;
  title: string;
  subtitle: string;
  timeRange?: ReviewEventTimeRange;
  hunkLabels: string[];
  hunkIndexes: number[];
  jsonPaths: string[];
  intent?: string;
  checkPoints: string[];
  warnings: string[];
  reviewFrameReasons: string[];
}
```

`hunkIndexes` は必須。`Map<Hunk, Side>` が object identity を使うため、clone した hunk や label だけで処理しない。

---

## 3. 実装する関数

```ts
export function buildReviewEvents(args: {
  hunks: Hunk[];
  reviewBundle?: ReviewBundle;
  aiNotes?: string[];
  applyWarnings?: string[];
}): ReviewEvent[];

export function reviewEventStatus(args: {
  event: ReviewEvent;
  hunks: Hunk[];
  resolution: Map<Hunk, "theirs" | "mine">;
}): ReviewEventStatus;

export function warningSummary(events: ReviewEvent[]): {
  total: number;
  groups: { label: string; count: number }[];
};
```

---

## 4. Grouping ルール

`Hunk.address` から group key を作る。

```ts
function groupKey(hunk: Hunk): string {
  const a = hunk.address;
  if (a.arrayKey && a.elementId) return `${a.file}:${a.arrayKey}:${a.elementId}`;
  if (a.arrayKey) return `${a.file}:${a.arrayKey}`;
  if (a.field) return `${a.file}:${a.field}`;
  return a.label;
}
```

同じ group key の hunk を 1 event にまとめる。

注意:

- `Hunk.address.label` は表示には使ってよいが、一意性の正にしない。
- `hunkIndexes` には元 `hunks` 配列の index を入れる。

---

## 5. kind ルール

| 条件 | kind |
|---|---|
| `file=cutplan` | `cut` |
| `file=transcript`, `arrayKey=segments` | `caption` |
| `file=overlays`, `arrayKey=overlays` | `overlay` |
| `file=overlays`, `arrayKey=inserts` | `insert` |
| `file=overlays`, `arrayKey=annotations` | `annotation` |
| `file=overlays`, `arrayKey=blurs` | `blur` |
| `file=overlays`, `arrayKey=zooms` | `zoom` |
| `file=overlays`, `arrayKey=wipeFull` | `wipe` |
| `file=overlays`, `arrayKey=captionTracks` | `caption-track` |
| `file=bgm` | `bgm` |
| `file=shorts` | `short` |
| その他 | `json` |

---

## 6. title ルール

最初は switch でよい。自然言語生成をしない。

| kind | hunk.kind / field | title |
|---|---|---|
| annotation | `element-add` | `注釈を追加` |
| annotation | `element-remove` | `注釈を削除` |
| annotation | `rect.*` / `points` | `注釈の位置を変更` |
| blur | `element-add` | `ぼかしを追加` |
| blur | `rect.*` | `ぼかし範囲を変更` |
| zoom | `element-add` | `ズームを追加` |
| caption | `text` | `字幕文言を変更` |
| caption | `start` / `end` | `字幕の表示時間を変更` |
| cut | `action` / `start` / `end` | `カット範囲を変更` |
| bgm | `volume` | `BGM 音量を変更` |
| short | `ranges` / `start` / `end` | `ショート範囲を変更` |
| fallback | any | `JSON 変更` |

---

## 7. timeRange ルール

AI 提案後の見た目を検品するので、`hunk.theirs` を優先する。

実装:

1. group 内に `field=start` と `field=end` があれば使う。
2. group 内に object hunk があり、その object に `start` / `end` があれば使う。
3. `start` だけなら `end = start + 2`。
4. `end` だけなら `start = max(0, end - 2)`。
5. どちらも無ければ `undefined`。

axis は初期実装では `"source"` 固定。

---

## 8. checkPoints

kind ごとの固定文。

| kind | checkPoints |
|---|---|
| annotation | `画面外に出ていないか`, `字幕や重要な文字を隠していないか`, `表示時間が長すぎないか` |
| blur | `隠したい範囲を覆えているか`, `不要な場所まで隠していないか`, `動きに対して範囲がずれていないか` |
| zoom | `見せたい箇所が中央付近にあるか`, `字幕や注釈が見切れていないか`, `ズーム開始と終了が唐突でないか` |
| caption | `意味が変わっていないか`, `読める長さになっているか`, `表示時間が短すぎないか` |
| cut | `話の意味がつながっているか`, `音声や画面が不自然に切れていないか` |
| bgm | `声を邪魔していないか`, `区間の入りと終わりが自然か` |
| short | `冒頭で内容が伝わるか`, `切り出し範囲が主題に合っているか` |
| json | `変更内容が意図に合っているか` |

---

## 9. event id

暗号 hash は不要。client bundle で動く簡易 hash にする。

```ts
function stableEventId(input: unknown): string {
  const text = JSON.stringify(input);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `rev_${(h >>> 0).toString(36)}`;
}
```

---

## 10. テスト

`test/reviewEvents.test.ts` に追加する。

必須:

```ts
test("buildReviewEvents: annotation の field hunks を 1 event にまとめる", () => {});
test("buildReviewEvents: caption text hunk に字幕文言タイトルを付ける", () => {});
test("buildReviewEvents: blur add に確認ポイントを付ける", () => {});
test("buildReviewEvents: id 無し配列 hunk も event にする", () => {});
test("buildReviewEvents: start/end field から source timeRange を作る", () => {});
test("reviewEventStatus: 全 theirs は use", () => {});
test("reviewEventStatus: 全 mine は skip", () => {});
test("reviewEventStatus: 採否が混ざると mixed", () => {});
```

fixture は最小の `Hunk` object を手で作る。

注意:

- `resolution` test では `Map` key に同じ hunk object 参照を使う。
- `ReviewBundle` の巨大 fixture は不要。

---

## 11. 検証

```sh
node --test test/reviewEvents.test.ts test/docDiff.test.ts
npm run typecheck
```

---

## 12. 完了条件

- `buildReviewEvents()` が deterministic に同じ event を返す。
- hunk clone を作っていない。
- `docDiff.ts` に変更が無い、または import/export 調整だけで merge 意味が変わっていない。
- UI / server に変更が無い。
