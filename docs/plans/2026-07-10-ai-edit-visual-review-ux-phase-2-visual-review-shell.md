# Phase 2: AiVisualReview Shell

*2026-07-10 / 実装担当: gpt-5.4 想定*

目的:

- AI proposal review を `DiffReview kind="ai-proposal"` から `AiVisualReview` へ差し替える。
- 3 ペインの検品 UI を作る。
- この phase では still 比較、自動 review、refinement は最小限にする。
- 既存 diff 画面のうち、AI proposal review の主 UI として残っている部分を負債として外す。

前提:

- Phase 1 完了。
- `src/lib/reviewEvents.ts` と `test/reviewEvents.test.ts` がある。

---

## 1. 触るファイル

追加:

- `editor/client/AiVisualReview.tsx`

更新:

- `editor/client/App.tsx`
- `editor/client/index.html`

触らない:

- `editor/server.ts`
- `src/stages/editorAi.ts`
- `src/lib/docDiff.ts`

---

## 2. UI の責務

`AiVisualReview.tsx` は proposal review 専用。

責務:

- `ReviewEvent[]` を左ペインに表示する。
- 選択中 event を local state で持つ。
- `使う` / `使わない` を event hunk 群に適用する。
- `この内容で確定` を呼ぶ。
- JSON diff はまだ簡易 details でよい。

この phase では以下は placeholder でよい。

- preview area
- comparison mode
- warning summary
- timeline marker
- `AIに直させる`

---

## 3. Props

```ts
import type { Hunk } from "../../src/lib/docDiff.ts";
import type { ReviewBundle } from "../../src/stages/review.ts";
import type { ReviewEvent } from "../../src/lib/reviewEvents.ts";

type Side = "theirs" | "mine";

export interface AiVisualReviewProps {
  title: string;
  description: string;
  events: ReviewEvent[];
  hunks: Hunk[];
  resolution: Map<Hunk, Side>;
  reviewBundle?: ReviewBundle;
  reviewStale?: boolean;
  frameChecks: string[];
  globalWarnings: { label: string; items: string[] }[];
  checkingFrames: boolean;
  refining: boolean;
  onSetHunks: (hunks: Hunk[], side: Side) => void;
  onBulk: (side: Side) => void;
  onGenerateReview: (options: { withVlm: boolean }) => void;
  onRefine: (options: { withVlm: boolean; instruction?: string }) => void;
  onApply: () => void;
  onCancel: () => void;
}
```

Phase 2 では `onGenerateReview` / `onRefine` は props として受けるが、UI から呼ばなくてよい。

---

## 4. Layout

構造:

```text
diffBackdrop
aiReviewModal
  aiReviewHead
  aiReviewGrid
    aiReviewEventList
    aiReviewPreview
    aiReviewInspector
  aiReviewFoot
```

左:

- event list
- time
- title
- status badge

中央:

- placeholder: `AI編集後プレビュー`
- review bundle が無い場合でも何も壊れないこと。

右:

- selected event title
- timeRange
- checkPoints
- `使わない`
- `使う`

footer:

- `キャンセル`
- `この内容で確定`

---

## 5. event hunk の取得

```ts
function hunksOfEvent(event: ReviewEvent, hunks: Hunk[]): Hunk[] {
  return event.hunkIndexes.flatMap((index) => hunks[index] ? [hunks[index]] : []);
}
```

`index` が壊れていても throw しない。

---

## 6. visited state

UX 上、初期全採用でも `未確認` と見せたい。

local state:

```ts
const [selectedEventId, setSelectedEventId] = useState(events[0]?.id ?? "");
const [visitedEventIds, setVisitedEventIds] = useState<Set<string>>(() => new Set());
```

event click 時:

- selectedEventId を更新
- visitedEventIds に追加

badge 表示:

- resolution status が `use` かつ未訪問: `未確認`
- resolution status が `use` かつ訪問済み: `使う`
- `skip`: `使わない`
- `mixed`: `一部だけ`

---

## 7. App.tsx 接続

import:

```ts
import { buildReviewEvents } from "../../src/lib/reviewEvents.ts";
import { AiVisualReview } from "./AiVisualReview.tsx";
```

`aiWorkflowReview` がある render block で events を作る。

```ts
const aiReviewEvents = aiWorkflowReview
  ? buildReviewEvents({
      hunks: aiWorkflowReview.diff.hunks,
      reviewBundle: aiWorkflowReview.reviewBundle,
      aiNotes: aiWorkflowReview.response.proposal.review.notes,
      applyWarnings: aiWorkflowReview.response.proposal.applyPlan.warnings.map(
        (w) => `${w.file} ${w.where}: ${w.message}`,
      ),
    })
  : [];
```

resolution helper:

```ts
const setAiWorkflowHunks = (hunks: Hunk[], side: "theirs" | "mine") => {
  setAiWorkflow((prev) => {
    if (!prev?.resolution) return prev;
    const next = new Map(prev.resolution);
    for (const hunk of hunks) next.set(hunk, side);
    return { ...prev, resolution: next, reviewStale: prev.reviewBundle ? true : prev.reviewStale };
  });
};
```

既存 `DiffReview kind="ai-proposal"` を `AiVisualReview` に差し替える。

外部変更 conflict review の `DiffReview` は残す。

清掃:

- `App.tsx` の AI proposal review path から `DiffReview kind="ai-proposal"` を消す。
- `aiWorkflowActions` が AI proposal review から参照されなくなったら削除する。
- 削除で型エラーが出る場合は、先に未使用化したまま typecheck を通し、次の小さい commit で消す。
- `DiffReview.tsx` の AI proposal 専用 props / 分岐が到達不能になった場合だけ削除する。
- 外部変更 conflict review と共有している `DiffReview` の表示・採否・保存導線は削除しない。

---

## 8. CSS

`editor/client/index.html` に追加。

最低限:

```css
.aiReviewModal {
  position: fixed;
  inset: 24px;
  z-index: 80;
  display: grid;
  grid-template-rows: auto 1fr auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.aiReviewGrid {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(190px, 260px) minmax(320px, 1fr) minmax(240px, 320px);
}

@media (max-width: 900px) {
  .aiReviewModal { inset: 10px; }
  .aiReviewGrid {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(280px, 1fr) auto;
    overflow: auto;
  }
}
```

注意:

- card in card にしない。
- button text が折り返しても崩れないようにする。
- preview placeholder の高さを固定気味にする。

---

## 9. 検証

```sh
npm run typecheck
node --test test/reviewEvents.test.ts test/docDiff.test.ts test/editorAi.test.ts
```

手動:

1. AI 一発編集を実行する。
2. `AiVisualReview` が開く。
3. event list が見える。
4. event をクリックすると右ペインが変わる。
5. `使わない` で badge が変わる。
6. `この内容で確定` で既存保存経路が動く。
7. 外部変更 conflict review が従来通り開く。

---

## 10. 完了条件

- AI proposal review の初期画面で JSON hunk が主役ではない。
- `App.tsx` の AI proposal review main path が `AiVisualReview` になっている。
- `使う` / `使わない` が `aiWorkflow.resolution` を更新する。
- `この内容で確定` が既存 `applyAiWorkflow({ save: true, reviewFirst: false })` に接続されている。
- `DiffReview` は外部変更 conflict review 用に残っている。
- 到達不能になった AI proposal 専用 diff UI 配線が、削除済みまたは削除待ちコメント付きで局所化されている。
