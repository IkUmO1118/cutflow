# AI 編集レビュー 検証警告 UX / AI 修正導線 実装計画

*2026-07-10 / 実装担当: gpt-5.4 想定*

この文書は、AI 一発編集レビュー画面に表示される `applyPlan.warnings`
の UI/UX と、検証警告を AI で修正する導線を追加するための実装計画である。

親設計:

- `docs/plans/2026-07-10-ai-edit-visual-review-ux-implementation-design.md`
- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-0-index.md`

この追加実装は Phase 1-5 完了後の追加 phase として扱う。
gpt-5.4 で一気に実装すると危ないため、必ず本書の順に小さく進める。

---

## 0. 結論

gpt-5.4 で実装してよい。ただし **一括実装は禁止**。

危ない点:

- 通常の `AIに直させる` と `検証警告をAIで修正` が混ざりやすい。
- warning-fix refine で rejected hunk を再導入しやすい。
- `chapters.json` を編集してはいけない初回実装なのに、AI が `chapters.chapters`
  を変更しようとしやすい。
- 検証警告の全文表示が中央 preview を圧迫し、レビュー画面の主目的を壊しやすい。
- `overlays.zooms` の rect 補正は機械的に可能だが、chapters/transcript 不一致は
  意味判断を含む。

したがって、初回実装では次だけを行う。

1. 検証警告 UI を折りたたむ。
2. `検証警告をAIで修正` を通常 refine とは別の action として追加する。
3. warning-fix refine の prompt/context を追加する。
4. 初回の編集対象は `overlays.json` と `transcript.json` に限定する。
5. `chapters.json` 編集は解禁しない。必要な場合は AI メモに残す。

---

## 1. 対象警告の判断

ユーザーが確認した警告例:

```text
overlays.json zooms[0]: rect のアスペクト比(2.04)が出力(1.78)と1%を超えてずれています
chapters.json chapters: 概要欄チャプター「今回作ったツールの紹介」(0:06.7)に対応する画面の章テロップがありません
chapters.json chapters: 章「料金を抑えるための工夫」の開始位置が概要欄(1:03.9)と画面テロップ(1:03.0)でずれています
transcript.json segments: 画面の章テロップ「今回作ったツールの」(0:06.7)が概要欄チャプター(chapters.json)にありません
transcript.json segments: 画面の章テロップ「CutFlowのプロジェクト」(0:33.6)が概要欄チャプター(chapters.json)にありません
```

### 1.1 機械的に直せるもの

`overlays.json zooms[n]` の rect アスペクト比警告。

方針:

- 出力アスペクト比に合うように `rect.w` または `rect.h` を補正する。
- 可能なら中心点を維持する。
- 出力範囲からはみ出す場合は、rect を出力範囲内へ収める。
- `start` / `end` / `id` / その他フィールドは変えない。

この補正は AI に任せてもよいが、将来的には deterministic helper に切り出す。
初回は prompt で明示し、AI proposal としてレビューさせる。

### 1.2 AI 提案は可能だがレビュー必須のもの

chapters と画面章テロップの不一致。

validate の見方:

- `chapters.json` は概要欄チャプター。
- `transcript.json` の `overlays.captionTracks[].name === "章"` の track が画面章テロップ。
- validate はタイトル一致と開始位置一致で警告する。

初回方針:

- `chapters.json` は編集しない。
- `transcript.json` の章テロップ側を `chapters.json` に寄せる候補だけ出す。
- タイトルの部分一致と時刻の近さで対応候補を推定する。
- 確信できないものは編集せず AI メモに書く。

例:

- `今回作ったツールの` と `今回作ったツールの紹介` は同一候補として扱ってよい。
- `料金を抑えるための工夫` の開始位置ずれは、transcript 側の章テロップ時刻を
  chapters 側に合わせる候補を出してよい。
- `CutFlowのプロジェクト` は chapters 側に無い。削除、変更、chapters 追加の
  どれが正しいか判断が必要なため、自動確定しない。

---

## 2. やらないこと

初回実装では次を禁止する。

- `chapters.json` 編集の解禁。
- `planEditorAiPatch()` から `chapters.json` unsupported 判定を外すこと。
- warning-fix refine の結果を自動適用すること。
- warning-fix refine の結果を自動保存すること。
- rejected hunk の再導入。
- 通常の字幕改善、表現改善、カット調整を warning-fix に混ぜること。
- VLM の画像観測だけを根拠に patch を作ること。
- `review.probe/` の手編集。
- `approved` / `approvals.json` の変更。

`chapters.json` 編集が必要なケースは `review.notes` に残す。

---

## 3. 実装 Phase

### Phase 6A: 検証警告 UI を圧縮する

目的:

- 中央 preview 下の検証警告全文表示をやめる。
- 初期表示では preview を主役に戻す。

触るファイル:

- `editor/client/AiVisualReview.tsx`
- `editor/client/index.html`
- 必要なら `editor/client/App.tsx`

実装:

1. `globalWarnings` の表示を `details` ベースに変更する。
2. `検証警告` グループは初期表示で次だけ見せる。
   - `検証警告 N件`
   - 先頭1件の短い要約
   - 展開 affordance
3. 展開時だけ全文を `ul` で表示する。
4. `AIメモ` も同様に要約 + 展開へ変更する。
5. `aiReviewWarnings` の `max-height` は 180px 以下に保つ。
6. 中央 preview/still/video の高さを警告が押しつぶさないこと。

禁止:

- 警告全文を modal 初期表示で全部出さない。
- 右 inspector の選択中 `注意` を消さない。

完了条件:

- 警告が多くても中央 preview が主役に見える。
- details 展開で全文を確認できる。
- `npm run typecheck` が通る。

### Phase 6B: warning-fix action を UI に追加する

目的:

- 通常の `AIに直させる` と別に、検証警告だけを直す導線を作る。

触るファイル:

- `editor/client/AiVisualReview.tsx`
- `editor/client/App.tsx`
- `editor/client/apiTypes.ts`

推奨 UI:

- 中央の `検証警告 N件` 要約の近くに `検証警告をAIで修正` ボタンを置く。
- 右 inspector の通常 refine は `この変更をAIに直させる` に文言変更する。
- warning-fix 実行中は `AI が検証警告を修正中...` と表示する。

Props 案:

```ts
onFixWarnings?: (options: { withVlm: boolean }) => void;
fixingWarnings?: boolean;
```

`withVlm` は初回 UI では `false` 固定でよい。
画像を使う導線は warning-fix の初回 scope に入れない。

`App.tsx` では通常 refine と分ける。

```ts
const fixAiWorkflowWarnings = async (): Promise<void> => {
  await refineAiWorkflow({
    mode: "warning-fix",
    withVlm: false,
    instruction: buildWarningFixInstruction(...),
  });
};
```

`refineAiWorkflow` の options は次の形に拡張する。

```ts
type AiRefineMode = "normal" | "warning-fix";

const refineAiWorkflow = async (
  options: { mode?: AiRefineMode; withVlm: boolean; instruction?: string },
): Promise<void> => { ... }
```

完了条件:

- 通常 refine と warning-fix のボタンが UI 上で混同しない。
- warning-fix でも結果は新 proposal review として戻る。
- 自動適用・自動保存しない。

### Phase 6C: API request に refine mode と warnings を追加する

目的:

- server/prompt 側で warning-fix と通常 refine を区別できるようにする。

触るファイル:

- `editor/client/apiTypes.ts`
- `editor/server.ts`
- `src/stages/editorAi.ts`
- `test/editorServer.test.ts`
- `test/editorAi.test.ts`

型変更:

```ts
export type AiRefineMode = "normal" | "warning-fix";

export interface AiRefineRequest {
  proposalId: string;
  acceptedHunkLabels: string[];
  instruction?: string;
  vlm?: boolean;
  mode?: AiRefineMode;
}
```

server validation:

- `mode` は省略可。
- 省略時は `"normal"`。
- 許可値は `"normal"` / `"warning-fix"` のみ。
- それ以外の extra key は従来どおり拒否。

`/api/ai/refine` の job key に mode を含める。

```ts
mode: body.mode ?? "normal"
```

`RefineEditorAiInput` に追加する。

```ts
mode: "normal" | "warning-fix";
applyWarnings: string[];
```

`applyWarnings` は `record.proposal.applyPlan.warnings` から作る。

```ts
const applyWarnings = record.proposal.applyPlan.warnings.map(
  (w) => `${w.file} ${w.where}: ${w.message}`,
);
```

`buildRefineEditorAiPrompt()` / `refineContextJson()` に `mode` と
`applyWarnings` を含める。

完了条件:

- warning-fix prompt に `applyWarnings` が入る。
- prompt に `mode: "warning-fix"` が入る。
- 通常 refine の既存テストが壊れない。

### Phase 6D: warning-fix 専用 prompt ルールを追加する

目的:

- AI が警告解消以外の変更を混ぜないようにする。

触るファイル:

- `src/stages/editorAi.ts`
- `test/editorAi.test.ts`

prompt に追加する warning-fix 専用ルール:

```text
When mode is "warning-fix":
- The only goal is to reduce or resolve applyWarnings.
- Do not perform general copy editing, caption shortening, cut changes, styling changes, or unrelated cleanup.
- Keep acceptedHunkLabels unless the warning explicitly proves one is invalid.
- Do not reintroduce rejectedHunkLabels unless the additional instruction explicitly asks for it.
- Do not edit chapters.json in this implementation. If chapters.json should change, leave a review note instead.
- Prefer transcript.json chapter telop edits over chapters.json edits for chapter/telop sync warnings.
- For overlays.json zoom rect aspect ratio warnings, adjust only the affected zoom rect and preserve id/start/end.
- If a warning cannot be fixed safely, leave the patch unchanged for that warning and explain it in review.notes.
```

AI response notes への要求:

- 何件の警告に対応したかを書く。
- 対応しなかった警告は理由を書く。
- chapters 側編集が必要なものは `chapters.json の編集が必要` と明記する。

完了条件:

- `test/editorAi.test.ts` で warning-fix prompt に上記の重要文言が入ることを固定する。
- rejected hunk 再導入禁止の文言がテストされる。
- `chapters.json` 編集禁止の文言がテストされる。

### Phase 6E: zoom rect 補正 helper を追加するか判断する

目的:

- 初回では AI proposal でもよいが、実装負債を増やさないため補正式を明確化する。

推奨:

- helper はこの phase では必須にしない。
- 入れるなら `src/lib/zoomRectFix.ts` のような純関数にする。
- UI や server から直接 recording JSON を書かない。
- helper の結果も AI proposal / patch として review させる。

補正式:

```text
outAr = output.w / output.h
rectAr = rect.w / rect.h

if rectAr > outAr:
  newW = rect.h * outAr
  newH = rect.h
else:
  newW = rect.w
  newH = rect.w / outAr

centerX = rect.x + rect.w / 2
centerY = rect.y + rect.h / 2
newX = clamp(centerX - newW / 2, 0, output.w - newW)
newY = clamp(centerY - newH / 2, 0, output.h - newH)
```

注意:

- rect を広げるより、基本は狭める方が安全。
- 拡大率警告がある場合は別警告として扱い、ここで無理に解消しない。

完了条件:

- helper を追加した場合は unit test を追加する。
- helper を追加しない場合でも prompt に補正方針が明記されている。

---

## 4. 実装時の具体プロンプト

gpt-5.4 に渡す場合は、1回で全部やらせない。
次の順に個別に渡す。

### Prompt 1: UI 圧縮だけ

```text
docs/plans/2026-07-10-ai-edit-validation-warning-fix-gpt54.md の Phase 6A だけ実装してください。
検証警告とAIメモの表示を details/summary 形式に圧縮し、初期表示では全文を出さないでください。
warning-fix API やAI修正ボタンはまだ追加しないでください。
npm run typecheck を通してください。
```

### Prompt 2: warning-fix ボタンだけ

```text
docs/plans/2026-07-10-ai-edit-validation-warning-fix-gpt54.md の Phase 6B だけ実装してください。
「検証警告をAIで修正」ボタンを追加し、通常の「この変更をAIに直させる」とUI上で分けてください。
この段階では既存 /api/ai/refine を呼ぶだけでよいですが、mode を送るための最小型変更まで行ってください。
自動適用・自動保存はしないでください。
npm run typecheck を通してください。
```

### Prompt 3: API / prompt context

```text
docs/plans/2026-07-10-ai-edit-validation-warning-fix-gpt54.md の Phase 6C と 6D を実装してください。
AiRefineRequest に mode: "normal" | "warning-fix" を追加し、server validation、job key、RefineEditorAiInput、refineContextJson、buildRefineEditorAiPrompt に反映してください。
warning-fix の prompt には applyWarnings、acceptedHunkLabels、rejectedHunkLabels、priorProposalDiff を必ず含めてください。
chapters.json 編集は禁止し、必要な場合は review.notes に残すルールにしてください。
test/editorAi.test.ts と test/editorServer.test.ts を更新してください。
npm run typecheck と node --test test/editorAi.test.ts test/editorServer.test.ts を通してください。
```

### Prompt 4: 仕上げ確認

```text
docs/plans/2026-07-10-ai-edit-validation-warning-fix-gpt54.md の完了条件を満たしているか確認してください。
特に、通常 refine と warning-fix refine が混ざっていないこと、chapters.json 編集が解禁されていないこと、rejected hunk 再導入禁止が prompt test で固定されていることを確認してください。
npm run typecheck と関連テストを実行してください。
```

---

## 5. テスト計画

最低限:

```sh
npm run typecheck
node --test test/editorAi.test.ts test/editorServer.test.ts test/reviewEvents.test.ts test/docDiff.test.ts
```

余裕があれば:

```sh
npm test
```

追加/更新するテスト:

- `validateRefineRequest` が `mode` を受け入れる。
- `validateRefineRequest` が不正な `mode` を拒否する。
- warning-fix prompt に `applyWarnings` が入る。
- warning-fix prompt に `chapters.json` 編集禁止が入る。
- warning-fix prompt に `rejectedHunkLabels` 再導入禁止が入る。
- warning-fix prompt に zoom rect 補正ルールが入る。

UI は現状 React test が無いので、初回は typecheck と手動確認でよい。
ただし CSS 変更でボタンや details が見切れないことはブラウザで確認する。

---

## 6. 手動確認

1. AI 一発編集を実行する。
2. `applyPlan.warnings` がある proposal を表示する。
3. 中央 preview 下に警告全文が常時出ないことを見る。
4. details を開くと全文が見えることを見る。
5. `この変更をAIに直させる` が通常 refine の用途として分かることを見る。
6. `検証警告をAIで修正` を押す。
7. 新 proposal review に戻ることを見る。
8. 自動保存されていないことを見る。
9. JSON diff details で変更対象が `overlays.json` / `transcript.json` に収まることを見る。
10. `chapters.json` が変更されていないことを見る。

---

## 7. ロールバック方針

問題が出た場合:

1. UI 圧縮は残してよい。
2. warning-fix ボタンだけ非表示にする。
3. `/api/ai/refine` の通常 refine は壊さない。
4. `mode` は残っていても省略時 `"normal"` なら互換性がある。

最も避けるべきロールバック:

- `docDiff.ts` や `applyProposalResolution()` を触って戻すこと。
- `chapters.json` 編集解禁と warning-fix を同時に戻すこと。

---

## 8. 完了条件

- 検証警告が UI 上で折りたたまれ、preview を圧迫しない。
- `検証警告をAIで修正` が通常 refine と別導線になっている。
- warning-fix refine は `applyWarnings` を context に含む。
- accepted/rejected/prior diff context を保持する。
- `chapters.json` は初回実装では編集されない。
- warning-fix 結果は自動適用・自動保存されない。
- typecheck と関連テストが通る。
