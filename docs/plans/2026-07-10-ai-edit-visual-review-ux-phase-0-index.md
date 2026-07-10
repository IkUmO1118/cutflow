# AI 編集レビュー検品モード Phase 分割

*2026-07-10 / 実装担当: gpt-5.4 想定*

親設計:

- `docs/plans/2026-07-10-ai-edit-visual-review-ux-implementation-design.md`
- `docs/plans/2026-07-10-ai-edit-visual-review-ux-second-opinion.md`

結論: 一気に実装しない。全採用の到達点は維持しつつ、PR / 作業単位を 5 phase に分ける。
Phase 1-5 完了後の追加改善として、検証警告 UX / AI 修正導線を Phase 6 として扱う。

---

## Phase 一覧

### Phase 1: ReviewEvent foundation

ファイル:

- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-1-review-events.md`

目的:

- JSON hunk を UI 用の `ReviewEvent` へ変換する純関数を作る。
- UI にはまだ触らない。

完了条件:

- `src/lib/reviewEvents.ts` がある。
- `test/reviewEvents.test.ts` が通る。
- `docDiff.ts` の意味は変わっていない。

### Phase 2: AiVisualReview shell

ファイル:

- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-2-visual-review-shell.md`

目的:

- AI proposal review を hunk modal から 3 ペイン検品 UI へ差し替える。
- まだ比較生成や refinement は深追いしない。

完了条件:

- `AiVisualReview.tsx` が表示される。
- `使う` / `使わない` / `この内容で確定` が既存保存経路につながる。
- AI proposal review 用の古い `DiffReview` 呼び出しが main path から消えている。
- 外部変更 conflict review は壊れていない。

### Phase 3: Visual comparison / warnings / markers

ファイル:

- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-3-comparison-warning-timeline.md`

目的:

- AI 編集後 preview を主役にする。
- deterministic 比較自動生成、before / after / overlay、警告要約、modal 内 timeline marker を入れる。

完了条件:

- review 開始後に deterministic review が自動生成される。
- `AI編集後` / `Beforeを見る` / `左右比較` / `重ねて比較` が動く。
- JSON diff は details に退避されている。

### Phase 4: AIに直させる / refinement / VLM

ファイル:

- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-4-refinement-vlm.md`

目的:

- `AIに直させる` を実装する。
- VLM checkbox を廃止し、画像外部送信を明示 action にする。
- refinement 後は必ず新 proposal review に戻す。

完了条件:

- `/api/ai/refine` がある。
- `画像を見せずに再提案` と `画像を見せて再提案` が分かれている。
- VLM 結果で自動採用・自動保存しない。

### Phase 5: Clip sync / polish

ファイル:

- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-5-clip-sync-polish.md`

目的:

- before / after clip 同期再生を追加する。
- responsive layout、アクセシビリティ、長文崩れ、最終テストを固める。

完了条件:

- clips がある場合に同期再生できる。
- still fallback がある。
- `npm run typecheck` と関連テストが通る。

### Phase 6: Validation warning UX / warning-fix refine

ファイル:

- `docs/plans/2026-07-10-ai-edit-validation-warning-fix-gpt54.md`

目的:

- 検証警告の全文表示を圧縮し、中央 preview を圧迫しないようにする。
- 通常 refine とは別に `検証警告をAIで修正` 導線を追加する。
- 初回は `overlays.json` と `transcript.json` の警告修正に限定し、`chapters.json`
  編集は解禁しない。

完了条件:

- warning-fix refine が `applyWarnings` / accepted hunk / rejected hunk /
  prior diff を context に含む。
- warning-fix 結果は自動適用・自動保存されない。
- `chapters.json` が unsupported のまま維持される。

---

## 実装順序

必ず次の順に進める。

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6

Phase 4 は Phase 3 完了前に始めない。理由は、refinement prompt が review / observation の形に依存するため。

Phase 5 は Phase 3 の still compare が安定してから実装する。動画同期を先に作ると UI と状態のデバッグが難しくなる。

Phase 6 は Phase 4 の refinement context が安定してから実装する。通常 refine と
warning-fix refine の責務を混ぜないこと。

---

## 既存 diff 画面の扱い

既存 diff 画面を丸ごと削除する計画ではない。
負債として整理する対象は、AI proposal review で JSON hunk modal が主 UI になっている部分。

- `DiffReview` は外部変更 conflict review 用に残す。
- `docDiff.ts` / `applyProposalResolution()` / `resolution` は残す。
- AI proposal review の render path は `AiVisualReview` に置き換える。
- `DiffReview` 内の AI proposal 専用分岐や props が到達不能になったら、Phase 2 以降で削除する。
- JSON diff は消さず、`AiVisualReview` の details に退避する。

清掃の優先順位:

1. `App.tsx` から AI proposal 用 `DiffReview` 呼び出しを消す。
2. VLM checkbox を主導線から外す。
3. 未使用になった `aiWorkflowActions` / props / CSS を型チェック後に削除する。
4. 外部変更 conflict review と共有している実装は残す。

---

## 各 Phase 共通の禁止事項

- `docDiff.ts` の merge 意味を変えない。
- `applyProposalResolution()` を置き換えない。
- `approvals.json` を書かない。
- `review.probe/` を手編集しない。
- 外部変更 conflict review を巻き込まない。
- VLM 結果で自動採用しない。
- proposal refinement 結果を自動保存しない。

---

## 推奨検証

各 phase の最後に最低限:

```sh
npm run typecheck
```

Phase 1:

```sh
node --test test/reviewEvents.test.ts test/docDiff.test.ts
```

Phase 2 / 3:

```sh
node --test test/reviewEvents.test.ts test/docDiff.test.ts test/editorAi.test.ts
```

Phase 4:

```sh
node --test test/editorAi.test.ts test/editorServer.test.ts test/review.test.ts
```

Phase 5:

```sh
npm test
```

Phase 6:

```sh
npm run typecheck
node --test test/editorAi.test.ts test/editorServer.test.ts test/reviewEvents.test.ts test/docDiff.test.ts
```
