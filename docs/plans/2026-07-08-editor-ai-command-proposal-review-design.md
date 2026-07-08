# GUI 内 AI 指示チャネル + AI 提案 diff review 主経路化(設計)

*2026-07-08 / 新診断 P0「GUI 内 AI 指示」「AI 編集の差分承認フローの主経路化」*

> 対象: エディター内から自然言語で AI 編集を依頼し、AI の出力を即時書き込みではなく
> **提案 diff** として表示し、accept / reject / tweak の流れで人間が採用する。
>
> 前提: 設計は強いモデルで行い、実装は普通のモデルへ分割して渡す。そのため本書は
> 判断理由だけでなく、実装単位・触るファイル・状態遷移・テスト観点・やらないことを
> 明示する。

---

## 0. 結論

v1 は **チャット UI を作らない**。作るのは:

1. **Selection-aware AI command bar**
   選択中の区間・字幕・overlay・blur・annotation・short を文脈にして、短い編集指示を送る。

2. **AI proposal review**
   AI は `ApplyPatch` を返す。サーバは `planApply` で検査するが、ファイルへは書かない。
   クライアントは base と proposed の差分を `DiffReview` 系 UI で見せる。

3. **採用後も既存保存経路**
   accept した提案は live state に入るだけ。最終書き込みは既存の `save()` /
   `/api/save` / `validateDocs` を通す。

この順序にする理由は、現行実装にすでに次があるため:

- `src/lib/applyEdits.ts` の `planApply` / `applyEdits`
- `src/lib/docDiff.ts` の `threeWayDiff` / `applyResolution`
- `editor/client/DiffReview.tsx`
- GUI の `proj` = base、live state = mine という状態モデル
- approval gate と `approved` 書換拒否

不足しているのは AI の能力ではなく、**GUI から提案を出し、差分として採用する常用導線**。

---

## 1. 採用する設計判断

### 論点1: AI 実行場所

**結論**: v1 は `editor/server.ts` に `POST /api/ai/propose` を足し、既存
`src/lib/llm.ts` の `complete(prompt, cfg)` を使う。

理由:

- GUI クライアントから `claude` CLI や Anthropic API を直接叩けない。
- editor server は既に `dir` と `cfg` を持つ。
- 既存の preview / render / config と同じく、GUI から押された操作の副作用境界として自然。
- MCP は外部ホスト向けの標準 I/F であり、GUI 内 UX の直接実行経路にしない方が単純。

却下:

- **ブラウザから MCP ホストを呼ぶ**: ホストごとに起動・認証・権限が違い、GUI の初期実装が
  MCP クライアント実装に引きずられる。
- **AI が `applyEdits` で直接書く**: diff review を主経路化できず、外部変更レビューと
  二重の体験になる。

### 論点2: AI の出力形式

**結論**: AI は最終 JSON ドキュメントではなく、`schemas/apply-patch.schema.json`
互換の `ApplyPatch` を返す。

レスポンス契約:

```json
{
  "title": "短い提案タイトル",
  "summary": ["何を変えるか", "なぜ変えるか"],
  "patch": {
    "ops": [],
    "replace": {}
  },
  "review": {
    "frames": ["12.3", "1:05.0"],
    "notes": ["採用前に見るべき箇所"]
  }
}
```

実装上のルール:

- JSON 以外の散文を許さない。パースに失敗したら提案失敗として UI に出す。
- `patch` は必須。
- `title` / `summary` / `review` は表示用なので、欠けてもサーバ側で既定値を補える。
- `approved` / `approvals.json` は触れない。これは `planApply` 側でも拒否する。

理由:

- `ApplyPatch` なら既存の安全編集・検査・id 採番を再利用できる。
- full replace だけにすると差分が粗くなり、普通の実装モデルが不要に大きな変更を返しやすい。
- ops だけに限定すると初期実装で表現しにくいケースが出るため、schema どおり
  `ops` と `replace` の両方を許す。

### 論点3: v1 の dirty 扱い

**結論**: v1 では未保存編集がある間、AI 提案作成を無効化する。UI は「保存してから提案」
を出す。

理由:

- サーバが見る正のデータはディスク上の JSON。
- 未保存 live state をサーバへ全量送る設計にすると、`/api/save` と同等の大きな
  body を AI 提案 API に持ち込むことになり、実装範囲が広がる。
- v1 の価値は「AI 提案を diff で採用する」ことであり、未保存編集との同時編集は
  existing external diff review に任せればよい。

v2:

- dirty 状態でも `ReviewDocs` をリクエスト body に含め、AI の base を live state にする。
- その場合も保存はせず、提案 diff だけ返す。

### 論点4: diff review の扱い

**結論**: 既存 `DiffReview.tsx` を「外部変更 conflict 専用」から
「review session 汎用」へ拡張する。

2種類の review session を扱う:

```ts
type ReviewKind = "external-conflict" | "ai-proposal";
```

- `external-conflict`: 既存どおり conflicts だけを見せる。
- `ai-proposal`: base と proposed の全 hunk を見せる。各 hunk は採用 / 不採用を選べる。

必要な純関数:

```ts
export function proposalDiff(base: ReviewDocs, proposed: ReviewDocs): ProposalDiffResult;
export function applyProposalResolution(
  base: ReviewDocs,
  proposed: ReviewDocs,
  result: ProposalDiffResult,
  resolution: ProposalResolution,
): ReviewDocs;
```

実装の近道:

- `proposalDiff(base, proposed)` は内部的に `threeWayDiff(base, base, proposed)` を使ってよい。
- ただし `threeWayDiff(...).cleanMerge === true` でも `hunks` は存在するので、
  AI 提案では `conflicts` ではなく `hunks` を表示する。
- `applyResolution` は non-conflict hunk を自動で `theirs` 採用するため、そのままでは
  hunk 単位 reject ができない。AI 用に別関数を作る。

### 論点5: 提案の保存

**結論**: v1 は提案をファイルに永続化しない。メモリ上の review session として扱う。

理由:

- まず必要なのは UX 経路の確立。
- 提案履歴ファイルを作ると、生成物か編集対象か、削除タイミング、AGENTS_CONTRACT の更新が
  必要になる。
- 失敗時の復元は既存 undo / draft / save gate で足りる。

v2 候補:

- `.ai-proposals/` か `ai.proposals.json` を導入。
- ただし導入時は generated / editable / approval の分類を `src/lib/files.ts` と
  `AGENTS_CONTRACT.md` に追加する。

### 論点6: チャット履歴

**結論**: v1 はチャット履歴を持たない。単発命令だけ。

UI 名称は「AI コマンド」または「提案」であり、「チャット」にはしない。

理由:

- 動画編集で必要なのは会話ログではなく、どの区間・どの要素がどう変わるか。
- 履歴を持つと「前の会話文脈が今の JSON と一致しているか」という別問題が出る。
- 既存の `rules.md` / `learn` が長期記憶の受け皿なので、v1 で会話メモリを作らない。

---

## 2. UX

### 2.1 入口

配置:

- Header 右側、保存/書き出し付近に小さな AI ボタン。
- 選択中オブジェクトがあるときは Inspector 上部にも compact command input を出す。
- ショート編集中は active short 名を文脈に含める。

入力:

- 1行 input + submit。
- 例:
  - `この字幕を短く`
  - `選択範囲の間を詰めてテンポを上げる`
  - `この場所に注意を引く矢印を追加`
  - `この範囲の個人情報をぼかす`
  - `このショートを冒頭3秒で引きが出るようにする`

表示状態:

- idle
- disabled because dirty
- proposing
- proposal ready
- proposal error

v1 で入れないもの:

- 常設チャット欄
- 会話履歴
- スレッド一覧
- 自動連続実行

### 2.2 提案レビュー

AI 提案が返ったら、既存 diff modal と同じ視覚言語で表示する。

外部変更レビューとの表示差:

- 外部変更: 「外部変更と競合しています」
- AI 提案: 「AI 提案を確認」

AI 提案 hunk の選択肢:

- `採用`
- `不採用`

一括:

- `すべて採用`
- `すべて不採用`

適用:

- 採用された hunk だけ live state に反映。
- `pushHistory()` は 1 回だけ。
- `proj` は base のままにする。採用後は dirty になり、既存保存ボタンで保存する。

補足:

- AI 提案は外部変更ではないので `setExternalChange(true)` しない。
- 採用後に `preview` / `frames` を強制実行しない。重い処理は v2。
- 提案が `planApply` warnings を持つ場合、review modal の上部に表示する。
- `planApply` errors がある場合、review modal は出さず、エラーとして表示する。

---

## 3. データフロー

```text
User selects range/caption/overlay/etc
        |
        v
AI command input
        |
        v
POST /api/ai/propose
  body:
    instruction
    selection context
    activeShortName
        |
        v
editor/server.ts
  load current disk docs
  describeJson(dir, cfg)
  build prompt
  complete(prompt, cfg)
  parse AiPatchResponse JSON
  planApply(dir, patch)          # no writes
  if errors -> return 400
  proposedDocs = mergeBodyOverDisk(dir, plan.body)
        |
        v
client receives proposal
  base = reviewDocsOf(proj)
  proposed = response.proposedDocs
  diff = proposalDiff(base, proposed)
        |
        v
AiProposalReview modal
  hunk accept/reject
        |
        v
Apply selected hunks to live state
  pushHistory once
  setCutplan / setOverlays / ...
  keep proj as base
        |
        v
User checks preview/timeline
        |
        v
Existing Save
  /api/save -> validateDocs -> write editable JSON
```

---

## 4. API 契約

### `POST /api/ai/propose`

Request:

```ts
export interface AiProposeRequest {
  instruction: string;
  selection?: AiSelectionContext;
  activeShortName?: string | null;
}
```

Response:

```ts
export interface AiProposeResponse {
  title: string;
  summary: string[];
  patch: ApplyPatch;
  applyPlan: ApplyPlan;
  proposedDocs: ReviewDocs;
  review: {
    frames: string[];
    notes: string[];
  };
}
```

Error response:

```ts
export interface ApiError {
  error: string;
}
```

HTTP status:

- `200`: 提案あり。`applyPlan.errors.length === 0`。
- `400`: instruction 空、AI JSON parse 失敗、patch 不正、`planApply` errors。
- `409`: dirty 前提のリクエストを将来受ける場合の予約。v1 ではクライアント側で送らない。
- `500`: LLM backend / unexpected error。

### `AiSelectionContext`

v1 は少なく始める。

```ts
export interface AiSelectionContext {
  playheadSec?: number;
  outputSec?: number;
  activeShortName?: string | null;
  selectedIds?: string[];
  selectedRange?: { startSec: number; endSec: number };
  selectedText?: string;
  selectedKind?: "cut" | "caption" | "overlay" | "blur" | "annotation" | "short" | "range";
}
```

実装者への注意:

- selection の完全対応を最初から狙わない。
- 最初は `playheadSec` / `activeShortName` / `selectedIds` / `selectedText` だけでよい。
- `selectedRange` は既存 Timeline の選択状態から安全に取れる場合だけ入れる。

---

## 5. プロンプト設計

新規:

- `prompts/editor-ai-propose.md`

含める情報:

- `AGENTS_CONTRACT.md` の要点
- ユーザー指示
- selection context
- `describeJson(dir, cfg)` の必要部分
- stable id の使い方
- `ApplyPatch` schema の要約
- `approved` を触らないこと
- 出力 JSON 契約

含めすぎない情報:

- 全 transcript を毎回そのまま入れない。長尺で破綻する。
- v1 は describe のうち、選択周辺・全 ID 一覧・短い timeline summary を優先する。

実装順序の簡略案:

1. v1a は describeJson 全体を入れる。まず機能を通す。
2. v1b で selection 周辺に絞る。

普通の実装モデルへ渡すなら、v1a を先に実装させる方が安全。最適化は後続タスクに分ける。

---

## 6. 変更ファイル

### 新規

| ファイル | 目的 |
|---|---|
| `src/stages/editorAi.ts` | prompt build、LLM response parse、`planApply`、`proposedDocs` 作成 |
| `prompts/editor-ai-propose.md` | AI 提案用 prompt template |
| `editor/client/AiCommand.tsx` | command input / busy / error / submit UI |
| `test/editorAi.test.ts` | parser / prompt / plan errors の単体テスト |

### 変更

| ファイル | 変更 |
|---|---|
| `editor/server.ts` | `POST /api/ai/propose` 追加 |
| `editor/client/apiTypes.ts` | `AiProposeRequest` / `AiProposeResponse` / `AiSelectionContext` |
| `editor/client/widgets.tsx` | `postAiPropose` |
| `editor/client/App.tsx` | AI command state、proposal review state、apply handler |
| `editor/client/DiffReview.tsx` | external conflict と AI proposal の両方を扱う汎用 review UI に拡張 |
| `src/lib/docDiff.ts` | `proposalDiff` / `applyProposalResolution` |
| `test/docDiff.test.ts` | AI proposal hunk accept/reject のテスト |
| `editor/client/index.html` | command bar / proposal review の CSS |

### 触らない

| ファイル | 理由 |
|---|---|
| `src/mcp/*` | v1 の GUI AI は MCP 経由にしない |
| `src/lib/approval.ts` | 承認境界は既存のまま |
| `src/stages/render.ts` | render gate は既存のまま |
| `AGENTS_CONTRACT.md` | 永続ファイルや新 CLI command を増やさないため v1 では不要 |

---

## 7. 実装タスク分割

### T1: AI 提案 stage の純粋部分

目的:

- LLM response JSON を parse して `ApplyPatch` を取り出す。
- `planApply` errors を API エラーへ変換できる形にする。

触る:

- `src/stages/editorAi.ts`
- `prompts/editor-ai-propose.md`
- `test/editorAi.test.ts`

受け入れ条件:

- JSON だけの response を parse できる。
- markdown fenced JSON は v1 では rejected でよい。
- `patch` 欠落を error にする。
- `approved` 変更 patch は `planApply` errors として返る。

### T2: `docDiff` の AI proposal 対応

目的:

- base と proposed の全変更を hunk として出す。
- hunk 単位で採用 / 不採用を反映できる。

触る:

- `src/lib/docDiff.ts`
- `test/docDiff.test.ts`

受け入れ条件:

- `proposalDiff(base, proposed).hunks.length > 0` が取れる。
- すべて不採用なら base と等価。
- すべて採用なら proposed と等価。
- 1 hunk だけ不採用にできる。
- `approved` は差分にも反映結果にも混ぜない。

### T3: editor server API

目的:

- GUI から AI 提案を作れるようにする。
- API はディスクへ書かない。

触る:

- `editor/server.ts`
- `editor/client/apiTypes.ts`
- `editor/client/widgets.tsx`

受け入れ条件:

- `POST /api/ai/propose` が `AiProposeResponse` を返す。
- `planApply` errors は 400。
- 成功時も編集 JSON の mtime が変わらない。
- LLM backend error は既存 API と同じ `{error}` 形式。

### T4: AI command UI

目的:

- エディターから短い命令を送れるようにする。

触る:

- `editor/client/AiCommand.tsx`
- `editor/client/App.tsx`
- `editor/client/index.html`

受け入れ条件:

- dirty のとき command input は disabled。
- busy 中は二重 submit できない。
- エラーは既存 toast / error 表示に乗る。
- 成功時に AI proposal review が開く。

### T5: DiffReview 汎用化

目的:

- 外部変更 conflict と AI proposal を同じ review 表現で扱う。

触る:

- `editor/client/DiffReview.tsx`
- `editor/client/App.tsx`
- `editor/client/index.html`

受け入れ条件:

- 既存 external conflict review が壊れない。
- AI proposal は conflict ではなく全 hunk を表示する。
- hunk ごとに採用 / 不採用できる。
- 適用は `pushHistory()` 1回。
- 適用後は dirty になる。
- キャンセル時は live state が変わらない。

### T6: 最小統合テスト

目的:

- 実装モデルが UI 全体を壊していないことを安く確認する。

実行:

```sh
node --test test/editorAi.test.ts test/docDiff.test.ts test/applyEdits.test.ts
npm run typecheck
```

必要なら追加:

```sh
node --test test/saveProject.test.ts test/mcpTools.test.ts
```

---

## 8. 重要な落とし穴

### 8.1 `planApply` と `applyEdits` を間違えない

`/api/ai/propose` では必ず `planApply` を使う。`applyEdits` は書くので使わない。

### 8.2 `proj` の扱い

AI proposal 採用時:

- `setCutplan` / `setOverlays` / `setTranscript` / `setBgm` / `setShorts` は更新する。
- `setProj` は更新しない。

理由:

- `proj` は最後にディスクから読んだ base。
- AI 提案を採用してもまだ保存していない。
- `proj` を proposed にすると dirty 判定が消えてしまう。

外部変更 review とは逆なので注意。

### 8.3 active short

AI 提案で `shorts` を変えた結果、現在の `activeShortName` が消える可能性がある。
既存 `applyMergedDocs` と同じく、存在しなければ `null` に戻す。

### 8.4 approval

AI proposal 採用後に保存しても、承認は自動更新しない。keep-set が変われば
approval warning / render gate は既存どおり働く。

UI に「AI が承認した」表現を出さない。

### 8.5 frames / av

AI response の `review.frames` は「見るとよい時刻」の提案だけ。v1 では自動で
`frames` を実行しない。

自動実行は v2:

- `review.frames` があれば user action で `frames` を実行。
- さらに進めるなら `cutflow_av` 相当の probe を editor server API に露出する。

---

## 9. v1 の完成定義

ユーザーがエディターで次を完了できること:

1. 字幕またはタイムライン範囲を選ぶ。
2. AI command に `この字幕を短く` などを入力する。
3. AI 提案が diff として表示される。
4. hunk ごとに採用 / 不採用を選ぶ。
5. 適用するとタイムライン / Inspector / Player に反映される。
6. 既存保存ボタンで validate 付き保存ができる。
7. render は従来どおり approval gate を要求する。

この時点で「GUI 内 AI 指示チャネル」と「AI 提案を diff review の主経路にする」は
成立したと見なす。

---

## 10. v2 以降

優先順:

1. dirty 状態でも AI 提案できるようにする。
2. selection 周辺だけを prompt に入れる context slicer。
3. 提案に before/after still を付ける。
4. `review.frames` からワンクリック frame 生成。
5. `cut this span` / `rewrite selected captions` / `add blur here` など高水準 tool 化。
6. 提案履歴の永続化。
7. 実 A/V 再観測ループ。
8. MCP tool と GUI AI proposal の内部実装を共通化する。

---

## 11. 実装者向けの進め方

普通の実装モデルには、上の T1 から順に 1 タスクずつ渡す。複数タスクを一度に渡すと
`App.tsx` と `DiffReview.tsx` の状態変更が混ざりやすい。

各タスクの終わりで必ず:

```sh
npm run typecheck
```

共有ロジックを触った場合は:

```sh
node --test test/docDiff.test.ts test/applyEdits.test.ts
```

UI まで触った最後だけ、手動確認として:

```sh
node src/cli.ts editor <fixture-or-recording-dir>
```

確認観点:

- dirty 時に AI command が押せない。
- AI 提案 cancel で何も変わらない。
- AI 提案 apply で dirty になる。
- 保存前にリロードすると採用内容は失われる。
- 保存すると validate を通る。
- 既存 external diff review がまだ動く。

