# Phase 4: AIに直させる / Refinement / VLM

*2026-07-10 / 実装担当: gpt-5.4 想定*

目的:

- `AIに直させる` を実装する。
- VLM checkbox を廃止し、画像外部送信を明示 action にする。
- refinement 後は必ず新 proposal review へ戻す。

前提:

- Phase 1 完了。
- Phase 2 完了。
- Phase 3 完了。

---

## 1. 触るファイル

更新:

- `editor/client/AiVisualReview.tsx`
- `editor/client/App.tsx`
- `editor/client/apiTypes.ts`
- `editor/server.ts`
- `src/stages/editorAi.ts`
- `test/editorAi.test.ts`
- `test/editorServer.test.ts`
- 必要なら `test/review.test.ts`

触らない:

- `src/lib/docDiff.ts`
- `applyProposalResolution()` の意味
- `approvals.json`

---

## 2. UI

右ペインに `AIに直させる` button を置く。

押すと refinement panel を開く。

```text
AIに直させる

この変更をもう一度見直します。
代表フレーム最大4枚を vision provider に送れます。
結果は自動採用されず、新しい提案としてもう一度レビューします。

[追加指示 input]
[画像を見せずに再提案] [画像を見せて再提案]
```

重要:

- checkbox は置かない。
- `画像を見せて再提案` を押すまで VLM を実行しない。
- refinement 中は `再提案中` と表示し、event 操作と確定 button を disabled にする。
- 失敗時は元 proposal / resolution / reviewBundle を維持する。

---

## 3. Client API types

`editor/client/apiTypes.ts` に追加:

```ts
export interface AiRefineRequest {
  proposalId: string;
  acceptedHunkLabels: string[];
  instruction?: string;
  vlm?: boolean;
}

export interface AiRefineResponse {
  proposalId: string;
  proposal: EditorAiProposeResponse;
}
```

client API helper が `App.tsx` 近辺にある場合は `postAiRefine()` を追加する。

---

## 4. App state

`AiWorkflowPhase` に追加:

```ts
type AiWorkflowPhase = ... | "refining";
```

`AiVisualReview` に渡す:

```tsx
refining={aiWorkflowReview.phase === "refining"}
onRefine={(options) => void refineAiWorkflow(options)}
```

---

## 5. refineAiWorkflow

`App.tsx` に追加する。

擬似コード:

```ts
const refineAiWorkflow = async (options: { withVlm: boolean; instruction?: string }) => {
  if (!aiWorkflowReview || !proj) return;
  const current = aiWorkflowReview;
  setAiWorkflow({ ...current, phase: "refining" });
  setError(null);
  try {
    const response = await postAiRefine({
      proposalId: current.response.proposalId,
      acceptedHunkLabels: current.diff.hunks.flatMap((hunk) =>
        (current.resolution.get(hunk) ?? "theirs") === "theirs"
          ? [hunk.address.label]
          : [],
      ),
      instruction: options.instruction?.trim() || undefined,
      vlm: options.withVlm,
    });
    const diff = proposalDiff(reviewDocsOf(proj), response.proposal.proposedDocs);
    setAiWorkflow({
      phase: "reviewing",
      instruction: current.instruction,
      scope: current.scope,
      response,
      diff,
      resolution: new Map(diff.hunks.map((h) => [h, "theirs"] as const)),
    });
  } catch (e) {
    const message = `再提案に失敗しました: ${(e as Error).message}`;
    setAiWorkflow({ ...current, phase: "reviewing", error: message });
    setError(message);
  }
};
```

---

## 6. Server API

`editor/server.ts` に `POST /api/ai/refine` を追加する。

処理:

1. request body を validate。
2. `proposalId` から proposal store を引く。
3. 期限切れなら 410 `proposal_expired`。
4. disk state が `record.baseHash` と違うなら 409 `proposal_stale`。
5. `acceptedHunkLabels` を既存 `/api/ai/review` と同じ方法で validate。
6. accepted hunk labels から candidate docs を作る。
7. `reviewEdit()` で review bundle を作る。
8. `vlm=true` の場合だけ VLM を許可する。
9. `refineEditorAi()` を呼ぶ。
10. 新 proposal を proposal store へ保存し、新 `proposalId` を返す。

VLM failure:

- provider 未設定 / timeout / capability 不足 / invalid response は 422 `SECONDARY_OBSERVATION_UNAVAILABLE`。
- 元 proposal store record は削除しない。

---

## 7. refineEditorAi

`src/stages/editorAi.ts` に追加。

```ts
export async function refineEditorAi(
  dir: string,
  cfg: Config,
  input: {
    originalInstruction: string;
    additionalInstruction?: string;
    baseDocs: ReviewDocs;
    candidateDocs: ReviewDocs;
    priorProposal: AiProposeResponse;
    reviewBundle: ReviewBundle;
  },
): Promise<AiProposeResponse>;
```

prompt 方針:

- `baseDocs`: 保存済み基準。
- `candidateDocs`: ユーザーが現在使う予定の hunk だけを反映した候補。
- rejected hunk は「ユーザーが使わない予定」と説明する。
- deterministic checks は一次観測。
- VLM summary は二次観測。
- VLM は座標や patch の正ではない。
- output schema は既存 AI proposal と同じ。

やってはいけない:

- disk 書き込み。
- live editor state 変更。
- VLM result から直接 patch 生成。
- 古い proposal store record の mutate。

---

## 8. Tests

`test/editorServer.test.ts`:

- `/api/ai/refine` が `proposalId` 必須を検査する。
- unknown key を拒否する。
- expired proposal は 410。
- stale proposal は 409。
- accepted hunk labels の重複を拒否する。
- refinement 成功時に新 proposalId を返す。
- VLM unavailable 時に 422 を返し、元 proposal を消さない。

`test/editorAi.test.ts`:

- `refineEditorAi` prompt が deterministic checks を含む。
- VLM summary が二次観測として入る。
- JSON schema output を既存 proposal と同じ形式で parse する。

---

## 9. 検証

```sh
node --test test/editorAi.test.ts test/editorServer.test.ts test/review.test.ts
npm run typecheck
```

手動:

1. AI proposal review を開く。
2. `AIに直させる` を開く。
3. `画像を見せずに再提案` で新 proposal review に戻る。
4. `画像を見せて再提案` は明示クリックまで VLM を呼ばない。
5. VLM 失敗時に元 proposal が残る。
6. refinement 後も自動保存されない。

---

## 10. 完了条件

- VLM checkbox が無い。
- `AIに直させる` がある。
- 画像なし / 画像あり再提案が分かれている。
- refinement は新 proposal として review に戻る。
- VLM 結果で自動採用しない。
- refinement 結果で自動保存しない。
