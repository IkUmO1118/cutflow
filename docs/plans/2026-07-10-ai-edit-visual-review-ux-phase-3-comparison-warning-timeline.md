# Phase 3: Visual Comparison / Warnings / Timeline

*2026-07-10 / 実装担当: gpt-5.4 想定*

目的:

- AI 編集後 preview を主役にする。
- review 開始時に deterministic 比較を自動生成する。
- `AI編集後` / `Beforeを見る` / `左右比較` / `重ねて比較` を実装する。
- 警告要約と変更 marker を実装する。

前提:

- Phase 1 完了。
- Phase 2 完了。

---

## 1. 触るファイル

更新:

- `editor/client/AiVisualReview.tsx`
- `editor/client/App.tsx`
- `editor/client/index.html`
- `src/lib/reviewEvents.ts`
- `test/reviewEvents.test.ts`

触らない:

- `editor/server.ts`
- `src/stages/editorAi.ts`
- `src/lib/docDiff.ts`

---

## 2. 自動 deterministic 比較生成

AI proposal が review に入ったら、自動で `/api/ai/review` を deterministic のみで呼ぶ。

`AiWorkflowReviewState` に追加:

```ts
autoReviewRequested?: boolean;
```

`App.tsx` に effect を追加:

```ts
useEffect(() => {
  if (!aiWorkflow || aiWorkflow.phase !== "reviewing") return;
  if (aiWorkflow.reviewBundle || aiWorkflow.reviewStale) return;
  if (aiWorkflow.autoReviewRequested) return;
  setAiWorkflow((prev) =>
    prev && prev.phase === "reviewing"
      ? { ...prev, autoReviewRequested: true }
      : prev,
  );
  void generateAiReview({ withVlm: false });
}, [aiWorkflow]);
```

注意:

- VLM は自動実行しない。
- 失敗しても review は閉じない。
- 失敗時は error を global warning として表示し、`比較を更新` を出す。

---

## 3. `generateAiReview` の引数化

変更前:

```ts
const generateAiReview = async (): Promise<ReviewBundle | null> => {
  ...
  vlm: aiVlmReview,
}
```

変更後:

```ts
const generateAiReview = async (options?: { withVlm?: boolean }): Promise<ReviewBundle | null> => {
  const withVlm = options?.withVlm ?? aiVlmReview;
  ...
  vlm: withVlm,
}
```

Phase 3 では UI から `withVlm: true` を呼ばない。VLM は Phase 4。

---

## 4. PreviewMode

`AiVisualReview.tsx` に追加:

```ts
type PreviewMode = "after" | "before" | "side-by-side" | "overlay";
```

既定:

```ts
const [previewMode, setPreviewMode] = useState<PreviewMode>("after");
```

表示:

- `after`: after still を大きく表示
- `before`: before still を大きく表示
- `side-by-side`: before / after still を横並び
- `overlay`: before / after still を重ね、opacity slider で after の透明度を調整

opacity:

```ts
const [overlayOpacity, setOverlayOpacity] = useState(0.55);
```

---

## 5. still 選択

selected event に近い still を選ぶ。

優先順:

1. `event.timeRange` がある場合、range 内の still。
2. range 内が無ければ中心時刻に最も近い still。
3. `event.reviewFrameReasons` と `still.requested.reason` が一致する still。
4. それでも無ければ最初の still。
5. still が無ければ placeholder。

関数:

```ts
function selectStillForEvent(event: ReviewEvent, bundle?: ReviewBundle) {
  if (!bundle || bundle.stills.length === 0) return null;
  // 実装は親設計の優先順に従う
}
```

画像 URL は既存 `DiffReview` と同じ:

```tsx
`/media/${encodeURIComponent(file).replace(/%2F/g, "/")}`
```

---

## 6. JSON diff details

Phase 2 の簡易表示を完成させる。

仕様:

- 初期は閉じる。
- summary は `詳細: JSON diff`。
- 開いた直後は selected event の hunk だけ表示。
- `すべての JSON diff を表示` toggle で全 hunk 表示。

表示項目:

- `hunk.address.label`
- 現在値: `hunk.mine`
- AI 提案: `hunk.theirs`

`formatValue`:

```ts
function formatValue(value: unknown): string {
  if (value === undefined) return "(なし)";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
```

---

## 7. Warning summary

`src/lib/reviewEvents.ts` の `warningSummary()` を完成させる。

最小仕様:

- `events[].warnings.length` を集計する。
- kind ごとに count を出す。

戻り値:

```ts
{
  total: number;
  groups: { label: string; count: number }[];
}
```

UI:

- total 0 の場合は出さない。
- total > 0 の場合は header 下に `要確認 N件` を出す。
- event list item に warning badge を出す。

---

## 8. Timeline marker

review modal 内の local timeline として実装する。

入力:

- `events`
- selected event id

range:

- timeRange を持つ event の min start / max end を使う。
- timeRange が無い event は marker を出さない。
- duration が 0 に近い場合は 1 秒として扱う。

marker:

- click で selected event を切り替える。
- selected marker を強調。
- warning がある event は warning style。

既存 main timeline component へ差し込まない。

---

## 9. CSS 注意

- preview image は `max-width: 100%; max-height: 100%; object-fit: contain;`
- overlay mode は同じ grid area に before / after を置く。
- narrow viewport では `side-by-side` も縦積みにしてよい。
- timeline marker は高さを固定し、hover で layout shift しない。

---

## 10. テスト

`test/reviewEvents.test.ts`:

```ts
test("warningSummary: event warning を件数要約する", () => {});
```

既存:

```sh
node --test test/reviewEvents.test.ts test/docDiff.test.ts test/editorAi.test.ts
npm run typecheck
```

手動:

1. AI review が開いた後、自動で比較生成が始まる。
2. still が表示される。
3. `AI編集後` / `Beforeを見る` / `左右比較` / `重ねて比較` が切り替わる。
4. 採否を変えると stale 表示が出る。
5. `比較を更新` で stale が解消される。
6. details を開くまで JSON diff が主役にならない。

---

## 11. 完了条件

- review 開始後に deterministic 比較が自動生成される。
- VLM は自動実行されない。
- preview は after を既定表示する。
- before / side-by-side / overlay が動く。
- warning summary と event warning badge がある。
- modal 内 timeline marker が selected event と連動する。
