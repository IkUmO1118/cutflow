# P0 残タスク: plan 知覚の明示化 + 対話一発編集 workflow 化

*2026-07-08 / 実装担当: gpt-5.4 想定*

## 0. 目的

P0 として残っている次の2点を、既存実装の上に最小侵襲で完了させる。

1. `plan` 知覚経路を「既定オン」または「明示」へ寄せる。
2. GUI の AI 指示を、単発 API ではなく「対話一発編集 workflow」として完結させる。

本書は、既に入っている実装を前提にした残作業の設計である。過去設計の全面再実装ではない。

## 1. 現状

### 1.1 plan 知覚

既にある実装:

- `src/lib/config.ts`
  - `Config.plan.perception.{audio,ocr,ocrMaxSegments,ocrMaxLines,systemSpeech}`
  - `resolvePerceptionCfg(cfg)`
- `src/lib/perception.ts`
  - `computeAudioFeatures`
  - `computeSegmentOcr`
  - `computeSystemSpeech`
  - `renderPerceptionBlock`
- `src/stages/plan.ts`
  - `plan` / `plan --cuts-only` / `remeta` が `{{perception}}` を prompt に渡す
- `config.yaml`
  - 現在のテンプレートでは `plan.perception.audio: true` / `ocr: true`

問題:

- コード上の未指定 fallback はまだ全オフである。
- テンプレート `config.yaml` ではオンなので、新規ユーザーは知覚ありになるが、古い config や最小 config では黙ってオフになる。
- README / usage / CLI 表示上、「今回の plan が知覚ありか無しか」を実行者が即座に判断できない。

P0 で解くべきこと:

- 「AI が目耳を使う」というプロダクト主張と実際の `plan` 入力状態を一致させる。
- ただし OCR は重く、macOS / Apple Vision 依存があるため、コード fallback で強制オンにすると旧環境を壊す。

### 1.2 対話一発編集

既にある実装:

- `src/stages/editorAi.ts`
  - `POST /api/ai/propose` 用の prompt build
  - schema 付き AI 応答
  - `planApply` による dry-run 検査
  - `proposedDocs` 作成
- `src/lib/docDiff.ts`
  - `proposalDiff`
  - `applyProposalResolution`
- `editor/client/AiCommand.tsx`
  - command input
- `editor/client/DiffReview.tsx`
  - AI proposal review 表示
- `editor/client/App.tsx`
  - header / inspector の AI command
  - 提案差分の採用
  - AI 推奨 frame の「適用して確認」

問題:

- ユーザー操作としては「提案」止まりで、workflow の完了条件が UI / 状態 / テストで固定されていない。
- 「AI に一発で直して」から、保存、検証、必要なら frames 確認、次の追指示までの遷移が散らばっている。
- `runAiFrameCheck` は提案を保存してフレーム生成するため強い副作用を持つが、workflow 名や状態として明示されていない。
- 採用後の保存、検証結果、失敗時再試行、追加指示の扱いが P0 UX として未定義。

P0 で解くべきこと:

- AI command を「1回の自然言語指示」から「安全に適用される編集 workflow」に昇格する。
- チャット履歴や agent loop は作らない。P0 は一発編集の成功率と安全性を上げる。

## 2. 採用判断

### 2.1 plan 知覚は「コード fallback 全オン」ではなく「明示化 + テンプレート推奨オン」

決定:

- `resolvePerceptionCfg` の未指定 fallback は P0 では全オンにしない。
- リポジトリ標準 `config.yaml` と新規 bootstrap / docs では知覚設定を明示し、推奨値をオンにする。
- `plan` / `remeta` 実行時に、今回の有効な知覚設定を必ずログへ出す。
- `plan.perception` が config に存在しない場合は、警告を出す。警告は止めない。

理由:

- `audio` は決定論的で安いが、`ocr` は重く環境依存である。
- 旧 config を使うユーザーに突然 OCR パスを走らせると、速度低下や macOS 非対応 warning が P0 の別問題になる。
- 「黙ってオフ」が問題であり、必ずしも「全環境で強制オン」が最善ではない。

有効化ポリシー:

| 状況 | audio | ocr | systemSpeech | 表示 |
|---|---:|---:|---:|---|
| 標準 `config.yaml` | true | true | false | 通常ログ |
| `plan.perception` 明示あり | config 値 | config 値 | config 値 | 通常ログ |
| `plan.perception` 未指定 | false | false | false | 警告 |
| `ocr: true` だが OCR 非対応 | true | 劣化して空 | config 値 | OCR warning。plan は継続 |

将来、コード fallback をオンにする場合も、この P0 のログと警告は残す。

### 2.2 対話一発編集は「proposal session」ではなく「workflow session」として扱う

決定:

- クライアント状態名を概念上 `aiWorkflow` に昇格する。
- v1 workflow は1ターンだけ。チャット履歴は持たない。
- workflow の状態を `idle -> proposing -> reviewing -> applying -> saved -> verified | failed` として明示する。
- AI の編集は引き続き `ApplyPatch -> planApply -> proposedDocs -> diff review` を通す。
- 「適用して確認」は workflow の optional verification step として扱い、隠れた保存ではなく UI 文言と状態で明示する。

理由:

- 既存の安全境界は正しい。壊す必要はない。
- 足りないのはモデル能力ではなく、ユーザーが「一発編集が完了した」と判断できる主経路である。
- diff review は安全性の核なので、P0 でもスキップしない。

## 3. P0-A: plan 知覚の明示化

### 3.1 追加する純関数

`src/lib/config.ts` に追加する。

```ts
export interface PerceptionStatus {
  explicit: boolean;
  audio: boolean;
  ocr: boolean;
  systemSpeech: boolean;
  ocrMaxSegments: number;
  ocrMaxLines: number;
  warnings: string[];
}

export function resolvePerceptionStatus(cfg: Config): PerceptionStatus {
  const pc = resolvePerceptionCfg(cfg);
  const explicit = cfg.plan?.perception !== undefined;
  const warnings: string[] = [];
  if (!explicit) {
    warnings.push(
      "plan.perception が config.yaml にありません。plan の知覚(audio/ocr/systemSpeech)は全てオフです。"
    );
  }
  return { explicit, ...pc, warnings };
}
```

注意:

- `resolvePerceptionCfg` の返り値は既存テストが依存しているので、互換を保つ。
- `loadConfig` で `cfg.plan ??=` や `cfg.plan.perception ??=` をしてはいけない。
- `PerceptionStatus` は CLI / editor 表示用の wrapper であり、実行ロジックは既存 `resolvePerceptionCfg` を使ってよい。

### 3.2 CLI ログ

`src/cli.ts` の `plan` と `remeta` で、実行前に status を stderr か stdout へ出す。

推奨は通常コマンドでは stdout。`describe --json` ではないため JSON 汚染の問題はない。

表示例:

```text
plan 知覚: audio=on / ocr=on(max 40 segments, 6 lines) / systemSpeech=off
```

未指定時:

```text
警告: plan.perception が config.yaml にありません。plan の知覚(audio/ocr/systemSpeech)は全てオフです。
plan 知覚: audio=off / ocr=off / systemSpeech=off
```

実装:

```ts
function printPerceptionStatus(cfg: Config): void {
  const s = resolvePerceptionStatus(cfg);
  for (const w of s.warnings) console.log(`警告: ${w}`);
  console.log(
    `plan 知覚: audio=${s.audio ? "on" : "off"} / ` +
      `ocr=${s.ocr ? `on(max ${s.ocrMaxSegments} segments, ${s.ocrMaxLines} lines)` : "off"} / ` +
      `systemSpeech=${s.systemSpeech ? "on" : "off"}`
  );
}
```

呼び出し箇所:

- `plan <dir>` の `guardRerun` 後、`await plan` 前。
- `remeta <dir>` の backup 後、`await remeta` 前。

壊してはいけないこと:

- `plan.raw.txt` の内容をログ文で変えない。
- `renderPrompt` の golden を変えない。
- `plan-shorts` には出さない。対象外。

### 3.3 editor 表示

P0 では editor の設定画面に大きな UI を足さない。まず API payload に明示情報を載せ、ヘッダーに短い status を出す。

変更:

- `editor/server.ts` の `loadProject` が返す `ProjectData` に `planPerception` を追加する。
- `editor/client/apiTypes.ts` に型を追加する。
- `editor/client/App.tsx` header の AI command 近くに `目耳: on/off` の小さい表示を足す。

型:

```ts
export interface PlanPerceptionStatus {
  explicit: boolean;
  audio: boolean;
  ocr: boolean;
  systemSpeech: boolean;
  ocrMaxSegments: number;
  ocrMaxLines: number;
  warnings: string[];
}
```

表示:

- `audio || ocr || systemSpeech` が真なら `目耳: on`
- 全て false なら `目耳: off`
- `warnings.length > 0` なら title に warning を入れ、CSS class `warn`

この表示は AI command の実行可否には影響させない。`plan` の知覚と GUI AI 提案は別機能であるため。

### 3.4 docs 更新

変更対象:

- `README.md`
- `docs/usage.md`
- `docs/decisions.md`
- `docs/plans/2026-07-07-plan-eyes-ears-design.md`

書く内容:

- 現在の標準 config は `plan.perception.audio/ocr` を明示オンにしている。
- 古い config で `plan.perception` が無い場合は互換のためオフになり、CLI が警告する。
- OCR は非対応環境では空として劣化し、plan は継続する。
- `systemSpeech` は `whisper.systemAudio` と `transcript.system.json` が必要。

既存文書の「既定オフ=バイト等価」は、過去設計としては残してよいが、現行方針の注記を追記する。

追記例:

```md
2026-07-08 P0 更新: コード上の未指定 fallback は互換のため全オフのままだが、標準 config では plan.perception を明示し audio/ocr をオンにする。未指定 config で plan/remeta を実行した場合は警告を出す。
```

### 3.5 テスト

追加または更新:

- `test/config.test.ts`
  - `resolvePerceptionStatus` は `cfg.plan?.perception` なしで `explicit:false` と warning を返す。
  - 明示 config では warning が空。
  - `resolvePerceptionCfg` の既存 fallback は変わらない。
- `test/plan.test.ts` または CLI 系テスト
  - `plan` 実行時に知覚 status が表示される。
  - `plan.perception` 未指定で警告が表示される。
- `test/editorServer.test.ts`
  - `/api/project` に `planPerception` が含まれる。

実行:

```sh
npm test
npm run typecheck
```

## 4. P0-B: 対話一発編集 workflow 化

### 4.1 workflow の定義

「対話一発編集」とは、ユーザーが1つの自然言語指示を出し、次の一連が1つの session として完了すること。

```text
instruction
  -> AI patch proposal
  -> static validation(planApply)
  -> diff review
  -> selected hunks applied to live state
  -> save
  -> validate
  -> optional frames verification
  -> complete or retry
```

P0 でやらないこと:

- 複数ターンのチャット履歴
- AI が自動で再提案し続ける loop
- diff review の完全スキップ
- `approved` の自動 true 化
- render / preview の自動実行

### 4.2 クライアント状態

`editor/client/App.tsx` の現状 `aiProposal`, `aiBusy`, `aiFrameBusy` を、概念上1つの workflow state にまとめる。実装は一気に大改造しなくてよいが、型は分ける。

推奨型:

```ts
type AiWorkflowPhase =
  | "idle"
  | "proposing"
  | "reviewing"
  | "applying"
  | "saving"
  | "verifying"
  | "complete"
  | "failed";

interface AiWorkflowState {
  phase: AiWorkflowPhase;
  instruction: string;
  scope: AiScope;
  response?: AiProposeResponse;
  diff?: ProposalDiffResult;
  resolution?: Map<Hunk, "theirs" | "mine">;
  saved?: boolean;
  frameFiles?: string[];
  error?: string;
}
```

移行方針:

- まず `aiWorkflow` を追加し、既存 `aiProposal` を置き換える。
- `aiBusy` は `phase === "proposing"` から導出する。
- `aiFrameBusy` は `phase === "verifying"` から導出する。
- `DiffReview` へ渡す値は `aiWorkflow.response/diff/resolution` から作る。

### 4.3 主要関数

#### `startAiWorkflow(scope, instruction)`

現 `submitAiCommand` を置換する。

責務:

- dirty なら開始しない。
- workflow を `proposing` にする。
- `postAiPropose` を呼ぶ。
- `proposalDiff` を作る。
- 差分なしなら `complete` で toast を出して終了。
- 差分ありなら `reviewing`。

擬似コード:

```ts
const startAiWorkflow = async (scope: AiScope, instruction: string) => {
  if (!proj) return;
  if (anyDirty) {
    setError("AI 一発編集は保存済みの状態から開始します。先に保存してください");
    return;
  }
  setAiWorkflow({ phase: "proposing", instruction, scope });
  try {
    const response = await postAiPropose({ instruction, activeShortName, selection: buildAiSelectionContext(scope) });
    const diff = proposalDiff(reviewDocsOf(proj), response.proposedDocs);
    if (diff.hunks.length === 0) {
      setAiWorkflow({ phase: "complete", instruction, scope, response, diff, saved: false });
      addToast({ kind: "info", message: "AI 提案に差分はありませんでした", ttlMs: 4000 });
      return;
    }
    setAiWorkflow({
      phase: "reviewing",
      instruction,
      scope,
      response,
      diff,
      resolution: new Map(diff.hunks.map((h) => [h, "theirs"] as const)),
    });
  } catch (e) {
    setAiWorkflow({ phase: "failed", instruction, scope, error: (e as Error).message });
    setError((e as Error).message);
  }
};
```

#### `applyAiWorkflow({ save, verifyFrames })`

現 `applyAiProposal` と `runAiFrameCheck` を統合する。

引数:

```ts
interface ApplyAiWorkflowOptions {
  save: boolean;
  verifyFrames: boolean;
}
```

ボタン:

- `適用`
  - live state に反映するだけ。保存しない。
- `適用して保存`
  - live state に反映して `/api/save`。
- `適用して確認`
  - live state に反映して `/api/save` し、AI 推奨 frames を生成。

P0 の推奨主ボタン:

- primary は `適用して保存`
- frames がある場合だけ secondary として `適用して確認`
- `適用のみ` は小さい secondary。既存の「採用後は未保存編集」という挙動を残す逃げ道。

重要:

- `verifyFrames` は必ず `save: true` を含む。frames API はディスクの JSON を読むため。
- 保存後は `setProj((p) => p && { ...p, ...merged })` と `deleteDraft()` を行う。
- `/api/save` が失敗したら workflow は `failed`。live state には反映済みの可能性があるため、message は「画面には反映しましたが保存に失敗しました」とする。

### 4.4 DiffReview 拡張

`editor/client/DiffReview.tsx` に workflow 用の footer actions を足す。

追加 props:

```ts
actions?: {
  label: string;
  kind?: "primary" | "secondary";
  disabled?: boolean;
  onClick: () => void;
}[];
```

既存互換:

- `actions` が無い場合は現行の `キャンセル` + `選んだ提案を適用` を表示。
- `kind === "external-conflict"` は既存表示のまま。

AI workflow 時:

- `キャンセル`
- `適用のみ`
- `適用して保存`
- `適用して確認`。`response.review.frames.length > 0` のときだけ。

文言:

- 現在の `checkFramesLabel="適用して確認"` は hidden save になるので廃止。
- ボタン説明に「保存して frames を生成」と明記する。

### 4.5 server 側 workflow API は増やさない

P0 では新しい `/api/ai/workflow` は作らない。

理由:

- 提案、保存、frames は既存 API の組み合わせで足りる。
- サーバに長寿命 session を持たせると、editor reload / external change / dirty state との整合が増える。
- workflow は UI の状態機械として実装する方が単純。

ただし `AiProposeResponse` に workflow 表示用 metadata を足してよい。

候補:

```ts
workflow?: {
  recommendedAction: "apply" | "save" | "verify";
}
```

P0 では不要。AI の `review.frames` があれば verify ボタンを出すだけで足りる。

### 4.6 追指示

P0 では「チャットの続き」ではなく「現在の状態からもう一度一発編集」として扱う。

ルール:

- workflow `reviewing` 中は新しい AI command を disabled。
- workflow `complete` または `failed` 後は、command input を再度使える。
- `complete` 後に追加指示を出すには、保存済みである必要がある。
- `適用のみ` を選んだ直後は dirty なので、追加 AI 指示は disabled。これは現行 dirty 方針と一致する。

### 4.7 エラー表示

分類:

| エラー | phase | 表示 | 回復 |
|---|---|---|---|
| AI JSON parse | failed | toast + error banner | 指示を変えて再実行 |
| `planApply` errors | failed | エラー詳細 | 指示を具体化して再実行 |
| proposed diff なし | complete | info toast | なし |
| save 失敗 | failed | 「画面には反映したが保存失敗」 | 手動保存 |
| frame time parse 失敗 | reviewing | review 内 warning | `適用して保存` は可能 |
| frames 生成失敗 | failed | 保存済みなら「保存済み、確認画像のみ失敗」 | frames 再実行 |

実装上は `setError` だけでなく、workflow 内にも `error` を残す。modal を閉じても header で分かるようにする。

### 4.8 UI コピー

Header command:

- placeholder: `AI に一発編集させる`
- dirty disabled: `保存してから AI 一発編集`
- busy: `提案中...`

Inspector command:

- selection あり: `選択中の内容を AI で編集`
- selection なし: `現在位置を AI で編集`

Review title:

- `AI 一発編集を確認`

Review description:

- `採用する変更だけを選んでください。適用して保存すると、この編集は JSON に書き込まれます。`

Buttons:

- `適用のみ`
- `適用して保存`
- `保存してフレーム確認`

完了 toast:

- 保存なし: `AI 編集を画面に適用しました。保存はまだです。`
- 保存あり: `AI 編集を保存しました。`
- frames あり: `AI 編集を保存し、確認フレームを N 枚生成しました。`

### 4.9 テスト

既存 Node test で可能なもの:

- `test/editorAi.test.ts`
  - 既存維持。
  - `AiProposeResponse.review.frames` が空でも response が成立する。
  - `planEditorAiPatch` はファイルを書かない。

- `test/docDiff.test.ts`
  - 既存維持。
  - proposal resolution で `approved` が変わらない。

追加したい client 純関数テスト:

`editor/client` 内に workflow reducer を切り出す。

新規:

- `editor/client/aiWorkflow.ts`
- `test/editorAiWorkflow.test.ts`

純関数:

```ts
export function isAiWorkflowBusy(s: AiWorkflowState): boolean;
export function canStartAiWorkflow(s: AiWorkflowState, dirty: boolean): boolean;
export function workflowApplyActions(s: AiWorkflowState): {
  applyOnly: boolean;
  save: boolean;
  verify: boolean;
};
```

テスト:

- dirty のとき開始不可。
- `reviewing` 中は開始不可。
- `review.frames.length === 0` なら verify action は false。
- `phase === "proposing" | "applying" | "saving" | "verifying"` は busy。

手動検証:

```sh
npm test
npm run typecheck
node src/cli.ts editor <recording>
```

GUI で確認:

1. 保存済み状態で header AI command から「この動画のテンポを少し上げる」。
2. diff review が開く。
3. `適用のみ` で dirty になる。
4. 保存して reload して変更が残る。
5. もう一度、selection ありで inspector AI command。
6. `適用して保存` で dirty が解消される。
7. `review.frames` がある提案で `保存してフレーム確認` が frames を生成する。

## 5. 実装タスク分解

### T1: plan perception status の純関数

触る:

- `src/lib/config.ts`
- `test/config.test.ts`

作業:

- `PerceptionStatus` / `resolvePerceptionStatus` を追加。
- 未指定 warning をテスト。
- `resolvePerceptionCfg` 既存 fallback は変えない。

受け入れ条件:

- `npm test -- test/config.test.ts` が緑。
- 既存 perception golden が変わらない。

### T2: CLI plan/remeta の知覚表示

触る:

- `src/cli.ts`
- 必要なら `test/plan.test.ts` または CLI 系テスト

作業:

- `printPerceptionStatus` を追加。
- `plan` / `remeta` 実行前に表示。
- `plan-shorts` には表示しない。

受け入れ条件:

- `plan.perception` 明示ありで status が出る。
- 未指定 config で warning が出る。
- `plan.raw.txt` の内容は変わらない。

### T3: editor project data に知覚状態を出す

触る:

- `editor/server.ts`
- `editor/client/apiTypes.ts`
- `editor/client/App.tsx`
- `editor/client/index.html`
- `test/editorServer.test.ts`

作業:

- `/api/project` に `planPerception` を追加。
- header に `目耳: on/off` 表示。
- warning は title と class で表す。

受け入れ条件:

- Editor 起動時に現在の plan 知覚状態が見える。
- AI command の enable/disable には影響しない。

### T4: AI workflow state 型と reducer 的 helper

触る:

- `editor/client/aiWorkflow.ts` 新規
- `editor/client/App.tsx`
- `test/editorAiWorkflow.test.ts` 新規

作業:

- `AiWorkflowState` を定義。
- busy / canStart / actions の純関数を追加。
- 既存 `aiBusy` / `aiFrameBusy` を導出へ寄せる。

受け入れ条件:

- dirty 中は開始不可。
- reviewing 中は開始不可。
- frames が無いと verify action は出ない。

### T5: App の AI proposal を workflow に置換

触る:

- `editor/client/App.tsx`
- `editor/client/AiCommand.tsx` 必要なら文言だけ

作業:

- `submitAiCommand` を `startAiWorkflow` へ置換。
- `aiProposal` / `aiResolution` を `aiWorkflow` に統合。
- 既存 `proposalDiff` / `applyProposalResolution` はそのまま使う。

受け入れ条件:

- 既存の AI 提案 diff review が引き続き開く。
- 差分なしは info toast。
- エラーは workflow failed として残る。

### T6: DiffReview の workflow action footer

触る:

- `editor/client/DiffReview.tsx`
- `editor/client/App.tsx`
- `editor/client/index.html`

作業:

- `actions` props を追加。
- AI proposal では `適用のみ` / `適用して保存` / `保存してフレーム確認` を表示。
- external conflict の既存表示は不変。

受け入れ条件:

- 外部変更レビューの文言とボタンは変わらない。
- AI review では hidden save がなくなる。

### T7: apply/save/verify の統合

触る:

- `editor/client/App.tsx`

作業:

- `applyAiWorkflow({save, verifyFrames})` を実装。
- `verifyFrames` は必ず save する。
- save 成功後は `proj` 更新、draft 削除、dirty 解消。
- frames 成功時は toast action で reveal。

受け入れ条件:

- `適用のみ`: dirty になる。ディスクは書かない。
- `適用して保存`: dirty が解消される。ディスクに反映される。
- `保存してフレーム確認`: 保存後に frames が生成される。
- save 失敗時は画面反映済みであることを明示する。

### T8: docs 同期

触る:

- `README.md`
- `docs/usage.md`
- `docs/decisions.md`
- 本設計書に実装結果の補足があれば追記

作業:

- `plan.perception` の現行方針を明記。
- GUI AI は「一発編集 workflow」として説明。
- `approved` は自動変更しないことを明記。

受け入れ条件:

- README だけ読んでも「AI 提案は diff review 後に保存される」ことが分かる。
- `plan.perception` 未指定がオフで warning になることが分かる。

## 6. 不変条件

1. AI は `approved` を true にしない。
2. `approvals.json` は触らない。
3. `plan.perception` 未指定時の prompt は既存 golden とバイト等価。
4. `plan.perception` 明示時だけ知覚ブロックが prompt に入る。
5. OCR 非対応環境で `plan` は失敗しない。
6. GUI AI は必ず `planApply` を通し、直接ファイルを書かない。
7. workflow の `適用のみ` はディスクを書かない。
8. workflow の frames 確認は、保存済み JSON に対してだけ走る。
9. 外部変更 diff review の挙動は変えない。
10. `plan-shorts` は本P0の対象外。

## 7. 実装順序

推奨順:

1. T1
2. T2
3. T4
4. T5
5. T6
6. T7
7. T3
8. T8

理由:

- 先に perception 明示化を終えると、P0 の「知覚が本当に使われているか」が CLI で確認できる。
- workflow はまず状態型を作ってから App を移行する方が、既存 `App.tsx` の巨大 state に飲まれにくい。
- editor 表示の `planPerception` は独立なので、workflow 移行と並行しなくてよい。

## 8. 完了条件

P0 完了とみなす条件:

- `node src/cli.ts plan <dir>` または `remeta <dir>` で、知覚状態が必ず表示される。
- `plan.perception` 未指定 config で warning が出る。
- 標準 `config.yaml` では `audio/ocr` が明示オンである。
- GUI で AI 指示を出すと、workflow として `提案 -> review -> 適用のみ/保存/確認` を選べる。
- `保存してフレーム確認` が hidden save ではなく明示 action になっている。
- `npm test` と `npm run typecheck` が通る。
