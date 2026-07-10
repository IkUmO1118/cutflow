# AI 編集レビュー検品モード 実装設計書

*2026-07-10 / 実装担当: gpt-5.4 想定*

対象:

- GUI の AI proposal review 画面
- AI が提案した JSON 変更を、人間が映像上の結果で検品して採用・不採用・再確認する体験
- `overlays` / `annotations` / `blurs` / `zooms` / `transcript segments` / `cutplan` / `bgm` / `shorts`

入力設計:

- `docs/plans/2026-07-10-ai-edit-visual-review-ux-second-opinion.md`

関連設計:

- `docs/plans/2026-07-07-editor-diff-review-design.md`
- `docs/plans/2026-07-08-editor-ai-command-proposal-review-design.md`
- `docs/plans/2026-07-09-p2-vlm-secondary-observation-agent-gui-design.md`

Phase 分割:

- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-0-index.md`
- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-1-review-events.md`
- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-2-visual-review-shell.md`
- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-3-comparison-warning-timeline.md`
- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-4-refinement-vlm.md`
- `docs/plans/2026-07-10-ai-edit-visual-review-ux-phase-5-clip-sync-polish.md`

この文書は、実装者が追加の UX 判断をせず、既存実装を段階的に置き換えられることを
優先する。特に gpt-5.4 のような弱い実装モデルでも迷わないように、触るファイル、
型、状態、関数、テスト、やらないことを固定する。

---

## 0. 結論

新しいレビュー画面は、JSON hunk を読む画面ではなく **AI 編集の検品モード** として
実装する。`docs/plans/2026-07-10-ai-edit-visual-review-ux-second-opinion.md` の
提案は全採用する。

採用する UX 判断:

1. レビュー画面の主役は `AI 編集後の大きなプレビュー` とする。
2. before / after は常時左右表示ではなく、必要時の比較モードとして提供する。
3. JSON hunk は初期表示から隠し、詳細表示へ退避する。
4. 変更単位は JSON hunk ではなく `ReviewEvent` として見せる。
5. 操作語彙は `使う` / `使わない` / `AIに直させる` / `この内容で確定` に寄せる。
6. `適用のみ` / `適用して保存` / `適用して確認` は主導線から外す。
7. 警告は全体要約 + 変更ごとの表示にする。
8. `画像もAIに確認させる` checkbox は廃止し、外部送信を伴う明示 action にする。
9. `比較を生成` は主操作にせず、自動生成 + stale 時の `比較を更新` にする。
10. 複数変更は一覧 + 1件フォーカスで検品する。

実装は段階化するが、到達点はセカンドオピニオンの全採用で固定する。
既存の次の仕組みを利用し、置き換えは review UI から進める。

- `src/lib/docDiff.ts`
  - `Hunk`
  - `proposalDiff()`
  - `applyProposalResolution()`
- `editor/client/App.tsx`
  - `aiWorkflow` state
  - `generateAiReview()`
  - `applyAiWorkflow()`
- `editor/client/DiffReview.tsx`
  - 現行の hunk diff modal
- `src/stages/review.ts`
  - `ReviewBundle`
  - before / after still
  - deterministic checks
  - optional VLM
- `editor/server.ts`
  - proposal store
  - `/api/ai/propose`
  - `/api/ai/review`

実装方針:

1. `Hunk[]` を UI 表示用の `ReviewEvent[]` に変換する。
2. AI proposal review だけ、新しい `AiVisualReview` コンポーネントで表示する。
3. 左ペインに変更リスト、中央に AI 編集後を主役にした preview / before-after、右ペインに選択中変更の判断 UI を置く。
4. `Hunk` 単位の採否 state は既存どおり `Map<Hunk, "theirs" | "mine">` を使う。
5. JSON diff は初期表示から隠し、詳細パネルとして既存 `DiffReview` 相当の hunk 表示を残す。
6. AI proposal が review へ入ったら deterministic 比較を自動生成する。
7. `画像もAIに確認させる` checkbox は廃止し、`AIに直させる` の中の明示操作へ移す。
8. `AIに直させる` は VLM 観測または現在の review 観測を次の proposal へ渡し、必ず新 proposal として review に戻す。
9. 確定ボタンは `この内容で確定` とし、内部では既存保存経路を通す。
10. 高度な同期動画比較と重ね合わせ比較は後半 phase で実装する。

---

## 1. 現状

### 1.1 既にあるもの

現コードには AI proposal review の主経路がある。

- `editor/client/App.tsx`
  - `startAiWorkflow()` が `/api/ai/propose` を呼ぶ。
  - `proposalDiff(reviewDocsOf(proj), response.proposal.proposedDocs)` で差分を作る。
  - `aiWorkflow.phase === "reviewing"` のとき `DiffReview kind="ai-proposal"` を出す。
  - 採用 hunk は `aiWorkflow.resolution` に持つ。
  - `generateAiReview()` が `/api/ai/review` を呼び、`ReviewBundle` を受け取る。
  - `applyAiWorkflow()` が live state 反映と保存を担当する。

- `editor/client/DiffReview.tsx`
  - hunk 一覧を表示する。
  - hunk ごとに現在値 / AI 提案値を選べる。
  - `ReviewBundle` があれば before / after still と deterministic checks を表示する。
  - optional VLM 結果も表示できる。

- `src/lib/docDiff.ts`
  - `Hunk` は address / kind / base / mine / theirs / conflict を持つ。
  - AI proposal では `mine` が現在値、`theirs` が AI 提案値として使われる。
  - `applyProposalResolution()` は resolution に従って hunk ごとに AI 提案値を採用する。

### 1.2 現状の問題

現 UI は技術的には正しいが、検品体験としては弱い。

- 主役が JSON hunk で、映像結果ではない。
- `ReviewBundle` が hunk 一覧の上に積まれており、選択中の変更と紐づかない。
- `確認推奨` がテキストで、変更リスト / preview / timeline に接続していない。
- ボタンが内部状態を露出している。
- VLM checkbox が主導線にあり、外部送信の重さが UI 上で軽く見える。

この設計では、hunk diff を捨てるのではなく **hunk の上に ReviewEvent 表示レイヤを作る**。
これにより、既存の diff / apply / save の安全性を保ったまま UX を改善する。

---

## 2. スコープ

### 2.1 実装する

- `src/lib/reviewEvents.ts` の追加
- `ReviewEvent` 型の追加
- `Hunk[]` から `ReviewEvent[]` への変換
- event ごとの time range / title / kind / check points / warning groups / hunk labels の生成
- AI proposal review 用 `editor/client/AiVisualReview.tsx` の追加
- AI proposal review の `DiffReview kind="ai-proposal"` 経路の置き換え
- AI review modal の 3 ペイン化
- event list から event selection
- event selection に合わせた hunk 採否の一括変更
- event selection に合わせた before / after still 表示
- JSON diff 詳細の折りたたみ
- `この内容で確定` を主ボタンにする
- AI proposal review 開始時の deterministic 比較自動生成
- stale / 失敗時だけ出る `比較を更新`
- `Beforeを見る` / `左右比較` / `重ねて比較` の比較モード
- VLM checkbox の廃止
- `AIに直させる` action と、画像外部送信の明示確認
- VLM / deterministic observation を使った proposal refinement API
- refinement 後に新 proposal review へ戻す状態遷移
- before / after clip の同期再生
- overlay / difference 表示による重ね比較
- timeline 上の変更 marker
- 置き換え後に不要になった AI proposal 用 diff UI 配線の清掃
- unit test と最小 UI test

### 2.2 実装しない

- `docDiff.ts` の merge 意味変更。採否の正は既存 hunk resolution のまま。
- `applyProposalResolution()` の置き換え。
- 外部変更 conflict review の全面置き換え。外部変更 review は既存 `DiffReview` のまま維持する。
- VLM 結果による自動採用 / 自動却下。
- VLM が直接 `ApplyPatch` を返す処理。
- proposal refinement 結果の自動保存。
- `approvals.json` への書き込み。
- proposal 履歴の disk 永続化。
- chapters / meta / thumbnail の review 対象追加。これは GUI editable docs 拡張の別設計にする。
- `review.probe/` を人間または agent が手編集すること。

### 2.3 既存 diff 画面の負債整理方針

この計画では、既存 diff 画面を一律に負債として削除しない。
負債として扱うのは **AI proposal review の主 UI として JSON hunk modal を見せる経路** だけ。

残すもの:

- `src/lib/docDiff.ts`
- `proposalDiff()`
- `applyProposalResolution()`
- `Hunk` / `resolution` による採否 state
- 外部変更 conflict review 用の `DiffReview`
- JSON diff details で必要な hunk 表示ロジック

置き換えるもの:

- `App.tsx` の `aiWorkflowReview && <DiffReview kind="ai-proposal" ... />`
- AI proposal review で JSON hunk を主画面にする構成
- AI proposal review の主ボタン文言と action 配置

削除または縮小するもの:

- AI proposal review 専用に残った `aiWorkflowActions`
- AI proposal review 主導線上の VLM checkbox
- `DiffReview` 側にしか使われなくなった AI proposal 専用 props / 分岐

削除してはいけないもの:

- 外部変更 conflict review に必要な `DiffReview` の props / 分岐
- apply / save の既存経路
- merge の正になる `docDiff.ts` の挙動

清掃は Phase 2 以降で行う。
ただし gpt-5.4 実装では、型エラーや外部変更 conflict review の破損を避けるため、1 PR で無理に削除しない。
削除候補が外部変更 conflict review と共有されている場合は、共有部を残し、AI proposal 専用の到達不能分岐だけを消す。

---

## 3. 不変条件

### 3.1 データ安全性

- AI proposal は採用まで editable JSON へ書かない。
- `この内容で確定` は既存 `applyAiWorkflow({ save: true, reviewFirst: false })` を通す。
- 保存は既存 `postSave()` / `validateDocs` gate を通す。
- `approved` / `approvals.json` は触らない。
- `review.probe/` は生成物なので手編集しない。

### 3.2 採否の正

正の採否 state は引き続き `Map<Hunk, "theirs" | "mine">` とする。

- `theirs`: AI 提案を使う
- `mine`: 現在の内容を使う、つまり AI 提案を使わない

`ReviewEvent` は表示用の grouping であり、merge の正にはしない。

理由:

- `Hunk` と `applyProposalResolution()` は既にテスト済み。
- event grouping は UX のための抽象で、必ずしも JSON apply 単位と一致しない。
- 初期実装では安全な既存 path を残す方がよい。

### 3.3 ReviewEvent と Hunk の関係

- 1つの `ReviewEvent` は 1つ以上の `Hunk` を持つ。
- 1つの `Hunk` は必ず 1つの `ReviewEvent` に属する。
- grouping できない hunk は `kind: "json"` の event として出す。
- event の採用状態は、属する hunk の resolution から計算する。
- event 操作 `使う` は属する hunk 全部を `theirs` にする。
- event 操作 `使わない` は属する hunk 全部を `mine` にする。

### 3.4 Visual review の正

`ReviewBundle` は補助情報であり、採否の正ではない。

- before / after still が無くても event の採否はできる。
- deterministic checks は警告として扱う。
- VLM は二次観測として扱い、自動採用しない。
- `reviewStale` のときは、比較が現在の resolution と一致しないことを表示する。

---

## 4. データ契約

### 4.1 新規ファイル

`src/lib/reviewEvents.ts` を追加する。

このファイルは純関数だけを持つ。React / DOM / fs / server API に依存しない。

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

`hunkIndexes` を持たせる理由:

- `Hunk` object は `Map` key として identity を使っている。
- UI から event hunk を探すとき、`hunkLabels` だけでは重複時に危険。
- `hunkIndexes` で `aiWorkflowReview.diff.hunks[index]` を参照する。

### 4.2 新規関数

`src/lib/reviewEvents.ts`:

```ts
export function buildReviewEvents(args: {
  hunks: Hunk[];
  reviewBundle?: ReviewBundle;
  aiNotes?: string[];
  applyWarnings?: string[];
}): ReviewEvent[];
```

初期実装では `aiNotes` は event ごとに賢く分解しない。

- 全体 note は `AiVisualReview` の warning summary に出す。
- event へ入れるのは `Hunk` / `ReviewBundle` から確実に推測できるものだけ。

補助関数:

```ts
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

### 4.3 event id

event id は deterministic にする。

形式:

```text
rev_<kind>_<short-hash>
```

hash input:

```ts
{
  kind,
  hunkLabels,
  jsonPaths,
  timeRange
}
```

実装は Node crypto に依存しない。クライアントで動く必要があるため、初期実装は簡易 hash を使う。

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

暗号用途ではない。React key と selection 維持用。

---

## 5. Hunk から ReviewEvent への変換ルール

### 5.1 grouping key

`Hunk.address` から次の順で grouping key を作る。

1. `file + arrayKey + elementId` がある場合:
   - その要素の hunk を 1 event にまとめる。
   - 例: `overlays annotations ann_xxxxxx .start` と `.end` と `.points` は 1 event。
2. `file + arrayKey` だけの場合:
   - id 無し配列の丸ごと hunk として 1 event。
3. `file + field` の場合:
   - top-level field 単位で 1 event。
4. 上記以外:
   - hunk 1件を 1 event。

実装:

```ts
function groupKey(hunk: Hunk): string {
  const a = hunk.address;
  if (a.arrayKey && a.elementId) return `${a.file}:${a.arrayKey}:${a.elementId}`;
  if (a.arrayKey) return `${a.file}:${a.arrayKey}`;
  if (a.field) return `${a.file}:${a.field}`;
  return a.label;
}
```

### 5.2 kind

`file` と `arrayKey` から決める。

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

### 5.3 title

タイトルは短く、編集者の判断語彙にする。

優先順:

1. `kind` と `hunk.kind` から action を作る。
2. field が `text` / `reason` / `start` / `end` / `rect.*` / `points` の場合は具体化する。
3. 判断できない場合は `JSON 変更`。

例:

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

実装者は最初から完全な日本語生成を狙わない。上表を switch で実装する。

### 5.4 timeRange

event の時刻は AI 編集後候補の値を優先する。AI 提案を検品する画面なので、まず
after を見るため。

対象値の取得:

- event に含まれる hunk の `theirs` を見る。
- `theirs` が field 値だけの場合、同じ event に含まれる hunk の値だけでは全体 object が足りない。
- そのため初期実装では `hunk.theirs` が object の場合だけ完全抽出する。
- field hunk の場合は field 名から推測できる範囲だけ使う。

簡易ルール:

1. hunk group 内に `field=start` と `field=end` があればそれを使う。
2. hunk group 内に object hunk があり、その object に `start` / `end` があれば使う。
3. `start` だけあれば `end = start + 2`。
4. `end` だけあれば `start = max(0, end - 2)`。
5. どちらも無ければ `undefined`。

axis:

- 初期実装はすべて `"source"` とする。
- この repo の編集 JSON は原則 raw/source 秒である。
- `ReviewBundle.stills[].requested.axis` は still 表示用に別途扱う。

### 5.5 checkPoints

kind ごとの固定文を使う。

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

### 5.6 warnings

初期実装の event warning は次の3種類から作る。

1. `ReviewBundle.observation.checks` の status が `warn` / `fail` のもの
2. `applyPlan.warnings` から来る検証警告
3. `reviewBundle.vlm` の summary / observations

ただし正確な event 紐付けができない場合、event ごとに無理に重複表示しない。

実装ルール:

- `ReviewBundle.observation.checks[].message` に event の hunk label / elementId / kind 名が含まれる場合だけ event に付ける。
- `applyPlan.warnings` に hunk label / file / arrayKey が含まれる場合だけ event に付ける。
- 紐付け不能な警告は `AiVisualReview` の全体 summary に出す。

初期実装では false negative を許す。false positive で無関係な event に警告を付けないことを優先する。

---

## 6. UI コンポーネント設計

### 6.1 新規コンポーネント

`editor/client/AiVisualReview.tsx` を追加する。

責務:

- `ReviewEvent[]` を表示する。
- 選択中 event を持つ。
- event 操作を hunk resolution 更新へ変換する。
- `ReviewBundle` を event と関連づけて表示する。
- JSON diff 詳細を折りたたみ表示する。

このコンポーネントは proposal review 専用にする。外部変更 conflict review は既存
`DiffReview` のまま。

props:

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
  onOpenJsonDiff?: () => void;
}
```

`onGenerateReview({ withVlm })` は `App.tsx` 側で既存 `setAiVlmReview()` と
`generateAiReview()` に接続する。

### 6.2 レイアウト

モーダル内を 3 ペインにする。

```text
┌──────────────────────────────────────────────────────────────┐
│ AI 一発編集を確認                              [キャンセル]   │
├───────────────┬──────────────────────────────┬───────────────┤
│ 変更リスト      │ プレビュー / 比較               │ 選択中の変更    │
│               │                              │               │
│ 00:08 注釈追加 │ [AI編集後] [Before] [左右] [重ねる]│ 注釈を追加      │
│      要確認    │                              │ 確認ポイント... │
│ 00:34 字幕変更 │ after still / before-after      │ [使わない] [使う]│
│      OK        │                              │ [AIに直させる]   │
│               │                              │               │
├───────────────┴──────────────────────────────┴───────────────┤
│ [詳細: JSON diff]                         [この内容で確定]    │
└──────────────────────────────────────────────────────────────┘
```

CSS class:

- `.aiReviewModal`
- `.aiReviewHead`
- `.aiReviewGrid`
- `.aiReviewEventList`
- `.aiReviewEventButton`
- `.aiReviewPreview`
- `.aiReviewPreviewToolbar`
- `.aiReviewStillStage`
- `.aiReviewInspector`
- `.aiReviewActions`
- `.aiReviewJsonDetails`

既存 `.diffBackdrop` は再利用してよい。

### 6.3 変更リスト

左ペイン:

- event を時刻順に並べる。
- 時刻が無いものは末尾。
- 表示:
  - `formatTime(startSec)`
  - title
  - kind label
  - status badge
  - warning badge

status badge:

| status | label |
|---|---|
| `use` | `使う` |
| `skip` | `使わない` |
| `mixed` | `一部だけ` |
| `unreviewed` | `未確認` |

初期 resolution は既存どおり全 hunk `theirs` なので、実際の status は `use` になる。
ただし UX 上は未確認感を残したいので、event status とは別に `visitedEventIds`
をコンポーネント local state で持つ。

表示 label:

- resolution が `use` かつ未訪問: `未確認`
- resolution が `use` かつ訪問済み: `使う`
- resolution が `skip`: `使わない`
- resolution が `mixed`: `一部だけ`

### 6.4 中央 preview

Phase 4 では本物の動画 player を新設しない。

既存 `ReviewBundle.stills` / `ReviewBundle.clips` を使い、次の4モードを実装する。

```ts
type PreviewMode = "after" | "before" | "side-by-side" | "overlay";
```

- `after`: after still を大きく表示する。既定。
- `before`: before still を大きく表示する。
- `side-by-side`: before / after still を横並び表示する。
- `overlay`: before / after still を同じ領域に重ねる。初期実装は opacity slider でよい。

`ReviewBundle.clips` がある場合:

- `after` mode では after clip を表示してよい。
- `before` mode では before clip を表示してよい。
- `side-by-side` mode では before / after clip を横並び表示してよい。
- 同期再生は Phase 9 で実装する。Phase 4 では still 優先でよい。

event に対応する still の選び方:

1. event.timeRange がある場合:
   - `ReviewBundle.stills` の `requested.atSec` が range 内、または中心時刻に最も近いものを選ぶ。
2. event.reviewFrameReasons がある場合:
   - `still.requested.reason` と一致するものを優先。
3. 見つからなければ最初の still。
4. still が無ければ placeholder を表示し、`比較を更新` を出す。

重要:

- placeholder には長い説明文を置かない。
- `比較を更新` は `onGenerateReview({ withVlm: false })` を呼ぶ。
- `reviewStale` が true の場合は toolbar 近くに `比較が現在の採否と一致しません` を出す。

### 6.5 右ペイン

選択中 event の詳細を出す。

表示順:

1. title
2. timeRange
3. subtitle
4. 確認ポイント
5. event warnings
6. 操作

操作:

```text
[使わない] [使う]
[比較を更新]
[AIに直させる]
```

`AIに直させる` を押すと、右ペイン内に小さい refinement panel を開く。

表示:

```text
AIに直させる

この変更をもう一度見直します。
代表フレーム最大4枚を vision provider に送れます。
結果は自動採用されず、新しい提案としてもう一度レビューします。

[追加指示 input]
[画像を見せずに再提案] [画像を見せて再提案]
```

`画像を見せて再提案` の下に必ず短い注記を出す。

```text
外部AI providerへ最大4枚の画像を送ります。結果は自動採用されません。
```

挙動:

- `画像を見せずに再提案`: `onRefine({ withVlm: false, instruction })`
- `画像を見せて再提案`: `onRefine({ withVlm: true, instruction })`
- refinement 中は `再提案中` と表示し、event 操作と確定 button を disabled にする。
- refinement 成功時は新 proposal として review 全体を差し替える。
- refinement 失敗時は元 proposal / resolution / reviewBundle を維持し、global warning に出す。

checkbox ではなく button にする理由は、外部送信と再提案をその場の明示操作にするため。

### 6.6 JSON diff 詳細

モーダル下部に `<details>` を置く。

summary:

```text
詳細: JSON diff
```

中身:

- 選択中 event の hunk だけをまず表示。
- `すべての JSON diff を表示` toggle を押したら全 hunk を表示。

既存 `DiffReview` の `ValuePane` は private なので、そのまま import しない。
`AiVisualReview.tsx` に小さい JSON 表示関数を持つ。

```ts
function formatValue(value: unknown): string {
  if (value === undefined) return "(なし)";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
```

---

## 7. App.tsx への接続

### 7.1 import

`editor/client/App.tsx` に追加:

```ts
import { buildReviewEvents } from "../../src/lib/reviewEvents.ts";
import { AiVisualReview } from "./AiVisualReview.tsx";
```

### 7.2 events の作成

`aiWorkflowReview` render 直前で作る。

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

注意:

- `buildReviewEvents()` は純関数だが、render ごとに呼ばれても重くない想定。
- hunk 数が増えたときに問題になったら `useMemo` 化する。初期実装では必須ではない。

### 7.3 resolution 更新

`AiVisualReview` へ渡す helper:

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

`reviewStale` を true にする理由:

- before / after は acceptedHunkLabels に基づく candidate で作られている。
- 採否を変えたら以前の比較 bundle と一致しない。

既存 `onSet` でもこの stale 化を入れる。

### 7.4 比較生成

既存 `generateAiReview()` は `aiVlmReview` state を読む。

`onGenerateReview({ withVlm })` で次を行う。

```ts
const runAiVisualReview = async ({ withVlm }: { withVlm: boolean }) => {
  setAiVlmReview(withVlm);
  await generateAiReviewWithVlm(withVlm);
};
```

既存 `generateAiReview()` を引数付きに変える。

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

`applyAiWorkflow({ reviewFirst: true })` から呼ぶ箇所は既定値で動くので壊れない。

### 7.5 render 差し替え

現在の `aiWorkflowReview && <DiffReview kind="ai-proposal" ... />` を
`<AiVisualReview ... />` に差し替える。

外部変更の `diffReview && diffPanelOpen && <DiffReview ... />` は変更しない。

渡す props:

```tsx
<AiVisualReview
  title="AI 一発編集を確認"
  description={...既存 description と同じ...}
  events={aiReviewEvents}
  hunks={aiWorkflowReview.diff.hunks}
  resolution={aiWorkflowReview.resolution}
  reviewBundle={aiWorkflowReview.reviewBundle}
  reviewStale={aiReviewStale}
  frameChecks={aiFrameParse}
  globalWarnings={...既存 warningGroups と同じ...}
  checkingFrames={aiWorkflowReview.phase === "verifying"}
  refining={aiWorkflowReview.phase === "refining"}
  onSetHunks={setAiWorkflowHunks}
  onBulk={(side) => ...既存 onBulk...}
  onGenerateReview={(options) => void generateAiReview(options)}
  onRefine={(options) => void refineAiWorkflow(options)}
  onApply={() => void applyAiWorkflow({ save: true, reviewFirst: false })}
  onCancel={() => setAiWorkflow(null)}
/>
```

`aiWorkflowActions` は廃止してよい。ただし既存の3操作が必要なら下記に寄せる。

- `比較を更新`: `generateAiReview({ withVlm: false })`
- `適用のみ`: 詳細 menu に退避。主導線には出さない。
- `適用して保存`: `この内容で確定`
- `適用して確認`: `比較を更新` してから `この内容で確定` はユーザーが分けて行う。

弱い実装モデル向けの指示:

- まず `AiVisualReview` に `onApply` だけ置く。
- 既存 `aiWorkflowActions` を削除する前に `npm test` を通す。
- 型エラーが出る場合は `aiWorkflowActions` の定義を残して未使用にしてよい。

### 7.6 review 開始時の自動比較生成

AI proposal が `reviewing` へ入った直後、deterministic 比較を自動生成する。

実装:

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

`autoReviewRequested` を `AiWorkflowReviewState` に追加する。

注意:

- 自動生成は deterministic のみ。VLM は自動実行しない。
- 自動生成に失敗しても review は閉じない。
- 失敗時は `比較を更新` を出す。
- proposal が stale / expired の場合は既存エラー表示に従う。

### 7.7 proposal refinement

`AiWorkflowPhase` に `"refining"` を追加する。

`App.tsx` に追加:

```ts
const refineAiWorkflow = async (options: { withVlm: boolean; instruction?: string }) => {
  if (!aiWorkflowReview) return;
  setAiWorkflow({ ...aiWorkflowReview, phase: "refining" });
  setError(null);
  try {
    const response = await postAiRefine({
      proposalId: aiWorkflowReview.response.proposalId,
      acceptedHunkLabels: aiWorkflowReview.diff.hunks.flatMap((hunk) =>
        (aiWorkflowReview.resolution.get(hunk) ?? "theirs") === "theirs"
          ? [hunk.address.label]
          : [],
      ),
      instruction: options.instruction?.trim() || undefined,
      vlm: options.withVlm,
    });
    const diff = proposalDiff(reviewDocsOf(proj!), response.proposal.proposedDocs);
    setAiWorkflow({
      phase: "reviewing",
      instruction: aiWorkflowReview.instruction,
      scope: aiWorkflowReview.scope,
      response,
      diff,
      resolution: new Map(diff.hunks.map((h) => [h, "theirs"] as const)),
    });
  } catch (e) {
    const message = `再提案に失敗しました: ${(e as Error).message}`;
    setAiWorkflow({ ...aiWorkflowReview, phase: "reviewing", error: message });
    setError(message);
  }
};
```

実装時は `proj!` をそのまま使わず、`if (!proj) return;` を先頭に入れる。
上のコードは状態遷移の読みやすさを優先した擬似コードである。

### 7.8 refinement API

`editor/server.ts` に `POST /api/ai/refine` を追加する。

request:

```ts
export interface AiRefineRequest {
  proposalId: string;
  acceptedHunkLabels: string[];
  instruction?: string;
  vlm?: boolean;
}
```

response は既存 `AiProposeResponse` と同じ形にする。

```ts
export interface AiRefineResponse {
  proposalId: string;
  proposal: EditorAiProposeResponse;
}
```

server 処理:

1. `proposalId` から proposal store を引く。
2. 期限切れなら 410 `proposal_expired`。
3. 現在 disk state の hash が `record.baseHash` と違うなら 409 `proposal_stale`。
4. `acceptedHunkLabels` を validate する。既存 `/api/ai/review` と同じ検査を使う。
5. `acceptedHunkLabels` から candidate docs を作る。
6. `vlm=false` の場合:
   - deterministic review が既にあればそれを refinement context に使う。
   - 無ければ `reviewEdit()` を deterministic のみで実行して context を作る。
7. `vlm=true` の場合:
   - `reviewEdit()` を VLM 付きで実行する。
   - provider 未設定 / 失敗時は 422 `SECONDARY_OBSERVATION_UNAVAILABLE`。
   - 元 proposal は破棄しない。
8. `proposeEditorAi()` に refinement mode を追加して、新しい `ApplyPatch` を作る。
9. `planApply` 済みの proposed docs を新 proposal として store へ保存する。
10. 新しい `proposalId` と proposal を返す。

`src/stages/editorAi.ts` に追加する関数:

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

prompt の方針:

- prior proposal をそのまま採用済みとは扱わない。
- accepted hunk だけを「現在ユーザーが使う予定の候補」として説明する。
- rejected hunk は「ユーザーが使わない予定」として説明する。
- deterministic checks を一次観測として渡す。
- VLM summary は二次観測として渡し、判断を上書きしないよう明記する。
- output は既存 AI proposal と同じ JSON schema にする。

やってはいけないこと:

- refinement が disk を書く。
- refinement が live editor state を変える。
- VLM 結果から直接 patch を作る。
- 古い proposalId を上書きして proposal store の中身を mutate する。

---

## 8. CSS

`editor/client/index.html` の `<style>` に追加する。

既存 `.diffModal` と似せるが、class は分ける。

必須条件:

- modal は viewport 内に収まる。
- 3ペインは desktop で横並び。
- mobile / narrow width では縦並び。
- preview 画像は container をはみ出さない。
- button text が折り返してもレイアウトを壊さない。
- card in card にしない。各ペインは枠線で区切る。

推奨 CSS 構造:

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

色は既存 palette を使う。新しい一色テーマを作らない。

---

## 9. 段階実装

### Phase 1: ReviewEvent 純関数

触るファイル:

- 追加: `src/lib/reviewEvents.ts`
- 追加: `test/reviewEvents.test.ts`

作業:

1. `ReviewEvent` 型を追加する。
2. `buildReviewEvents()` を追加する。
3. grouping key を実装する。
4. kind / title / checkPoints / timeRange を実装する。
5. `reviewEventStatus()` を実装する。
6. unit test を追加する。

テスト:

- annotation の複数 field hunk が 1 event になる。
- caption text hunk が `字幕文言を変更` になる。
- blur add が `ぼかしを追加` になる。
- id 無し配列 hunk が `json` ではなく対応 kind の event になる。
- timeRange が start/end から作られる。
- resolution 全 theirs が `use`。
- resolution 全 mine が `skip`。
- mixed resolution が `mixed`。

この phase では UI を触らない。

### Phase 2: AiVisualReview skeleton

触るファイル:

- 追加: `editor/client/AiVisualReview.tsx`
- 更新: `editor/client/index.html`

作業:

1. props 型を定義する。
2. 3ペイン layout を作る。
3. 左に event list を出す。
4. 右に選択中 event の detail を出す。
5. `使う` / `使わない` で `onSetHunks()` を呼ぶ。
6. footer に `キャンセル` / `この内容で確定` を出す。
7. still preview はまだ placeholder でよい。

確認:

- `npm run typecheck`
- UI が表示されるところまで App 接続せず、TypeScript compile を優先する。

### Phase 3: App 接続

触るファイル:

- 更新: `editor/client/App.tsx`

作業:

1. `buildReviewEvents` と `AiVisualReview` を import する。
2. AI proposal review だけ `DiffReview` から `AiVisualReview` に差し替える。
3. resolution 更新 helper を追加する。
4. hunk 採否変更時に `reviewStale` を立てる。
5. `generateAiReview(options?: { withVlm?: boolean })` に変更する。
6. proposal review 開始時に deterministic 比較を自動生成する。
7. `比較を更新` から `generateAiReview({ withVlm: false })` を呼べるようにする。

確認:

- AI 提案の hunk を `使わない` にすると保存 candidate に入らない。
- `この内容で確定` は既存保存経路を通る。
- 外部変更 conflict review は従来の `DiffReview` のまま。

### Phase 4: still preview

触るファイル:

- 更新: `editor/client/AiVisualReview.tsx`
- 必要なら更新: `editor/client/index.html`

作業:

1. `PreviewMode` state を追加する。
2. selected event に近い still を選ぶ関数を追加する。
3. `after` を既定表示する。
4. `Before` / `左右比較` segmented buttons を追加する。
5. still が無い場合は `比較を更新` を出す。
6. `reviewStale` warning を表示する。
7. `重ねて比較` を opacity slider 付きで追加する。

画像 URL:

既存 `DiffReview` と同じ:

```tsx
`/media/${encodeURIComponent(file).replace(/%2F/g, "/")}`
```

### Phase 5: JSON diff 詳細

触るファイル:

- 更新: `editor/client/AiVisualReview.tsx`
- 更新: `editor/client/index.html`

作業:

1. `<details>` を追加する。
2. 選択中 event の hunk の `mine` / `theirs` を表示する。
3. `すべて表示` toggle を追加する。
4. hunk address label を `<code>` で表示する。

確認:

- 通常表示で JSON が主役にならない。
- 詳細を開けば従来の hunk 値を確認できる。

### Phase 6: warning summary

触るファイル:

- 更新: `src/lib/reviewEvents.ts`
- 更新: `editor/client/AiVisualReview.tsx`
- 更新: `test/reviewEvents.test.ts`

作業:

1. `warningSummary()` を実装する。
2. global warning summary を header 下に短く表示する。
3. event warning badge を出す。
4. event に紐付かない warning は global にだけ出す。

### Phase 7: AIに直させる

触るファイル:

- 更新: `editor/client/AiVisualReview.tsx`
- 更新: `editor/client/App.tsx`
- 更新: `editor/client/apiTypes.ts`
- 更新: `editor/server.ts`
- 更新: `src/stages/editorAi.ts`
- 追加または更新: `test/editorAi.test.ts`
- 更新: `test/editorServer.test.ts`

作業:

1. `AiWorkflowPhase` に `"refining"` を追加する。
2. `AiVisualReview` 右ペインに `AIに直させる` panel を追加する。
3. `postAiRefine()` client API を追加する。
4. `POST /api/ai/refine` を追加する。
5. `refineEditorAi()` を追加する。
6. deterministic review / optional VLM review を refinement context として prompt に渡す。
7. refinement 成功時は新 proposalId / proposal / diff / resolution へ差し替える。
8. refinement 失敗時は元 proposal を保持する。

確認:

- `画像を見せずに再提案` は外部画像送信なしで新 proposal になる。
- `画像を見せて再提案` は明示 button のクリック時だけ VLM を使う。
- VLM 失敗時に元 proposal が失われない。
- refinement 後も自動採用・自動保存されない。

### Phase 8: timeline marker

触るファイル:

- 更新: `editor/client/AiVisualReview.tsx`
- 更新: `editor/client/index.html`

作業:

1. 中央 preview 下に compact timeline を追加する。
2. `ReviewEvent.timeRange` から marker 位置を計算する。
3. marker click で selected event を切り替える。
4. selected event の marker を強調する。
5. warning のある marker に小さい warning style を付ける。

この phase では既存 main timeline component へ差し込まない。
review modal 内の local timeline として実装する。

### Phase 9: before / after clip 同期再生

触るファイル:

- 更新: `editor/client/AiVisualReview.tsx`
- 更新: `editor/client/index.html`

作業:

1. `ReviewBundle.clips.beforeFile` / `afterFile` が両方ある場合に clip compare を表示する。
2. before video を主 clock とし、play / pause / seek を after video へ同期する。
3. 大きな drift があれば after を before currentTime に合わせる。
4. `side-by-side` mode で clip 同期再生を使う。
5. clip が無ければ still compare へ fallback する。

同期の最小実装:

- `onPlay`, `onPause`, `onSeeked`, `onTimeUpdate` で after video を追従させる。
- drift 閾値は 0.12 秒。
- ループや高度な playback controller は作らない。

---

## 10. 具体的な関数設計

### 10.1 `buildReviewEvents()`

擬似コード:

```ts
export function buildReviewEvents(args: {
  hunks: Hunk[];
  reviewBundle?: ReviewBundle;
  aiNotes?: string[];
  applyWarnings?: string[];
}): ReviewEvent[] {
  const groups = new Map<string, { indexes: number[]; hunks: Hunk[] }>();

  args.hunks.forEach((hunk, index) => {
    const key = groupKey(hunk);
    const group = groups.get(key) ?? { indexes: [], hunks: [] };
    group.indexes.push(index);
    group.hunks.push(hunk);
    groups.set(key, group);
  });

  const events = [...groups.values()].map((group) => eventOfGroup(group, args));
  return events.sort(compareEvents);
}
```

`compareEvents()`:

1. timeRange.startSec がある event を先にする。
2. startSec 昇順。
3. kind label 昇順。
4. title 昇順。
5. id 昇順。

### 10.2 `eventOfGroup()`

擬似コード:

```ts
function eventOfGroup(
  group: { indexes: number[]; hunks: Hunk[] },
  args: BuildArgs,
): ReviewEvent {
  const first = group.hunks[0];
  const kind = kindOf(first);
  const timeRange = timeRangeOf(group.hunks);
  const jsonPaths = group.hunks.map((h) => h.address.label);
  const title = titleOf(kind, group.hunks);
  const subtitle = subtitleOf(group.hunks, timeRange);
  const warnings = warningsForGroup(group.hunks, args);
  const reviewFrameReasons = frameReasonsFor(timeRange, args.reviewBundle);

  return {
    id: stableEventId({ kind, jsonPaths, timeRange }),
    kind,
    title,
    subtitle,
    timeRange,
    hunkLabels: group.hunks.map((h) => h.address.label),
    hunkIndexes: group.indexes,
    jsonPaths,
    checkPoints: checkPointsOf(kind),
    warnings,
    reviewFrameReasons,
  };
}
```

### 10.3 `timeRangeOf()`

実装は過剰に汎用化しない。

```ts
function timeRangeOf(hunks: Hunk[]): ReviewEventTimeRange | undefined {
  const start = numberField(hunks, "start") ?? numberFromObject(hunks, "start");
  const end = numberField(hunks, "end") ?? numberFromObject(hunks, "end");
  if (start === undefined && end === undefined) return undefined;
  if (start !== undefined && end !== undefined) return normalizeRange(start, end);
  if (start !== undefined) return normalizeRange(start, start + 2);
  return normalizeRange(Math.max(0, end! - 2), end!);
}
```

`numberField()` は `hunk.address.field === field` の hunk で `typeof hunk.theirs === "number"` を見る。

`numberFromObject()` は `hunk.theirs` が object で key を持つ場合だけ見る。

### 10.4 event hunk の取得

`AiVisualReview.tsx`:

```ts
function hunksOfEvent(event: ReviewEvent, hunks: Hunk[]): Hunk[] {
  return event.hunkIndexes.flatMap((index) => hunks[index] ? [hunks[index]] : []);
}
```

index が不正なら捨てる。throw しない。

---

## 11. AI / VLM 操作設計

### 11.1 比較を更新

`比較を更新` は deterministic review を作る。

- 呼び出し: `generateAiReview({ withVlm: false })`
- 表示中: `比較を準備中`
- 失敗: global warning に `比較の生成に失敗しました: ...`
- 成功: `ReviewBundle` を preview に反映

### 11.2 AIに直させる

`AIに直させる` は proposal refinement を作る。

- 画像なし: `refineAiWorkflow({ withVlm: false, instruction })`
- 画像あり: `refineAiWorkflow({ withVlm: true, instruction })`
- 画像ありの場合だけ外部送信注記を出す。
- 成功時は新 proposal として review 全体を差し替える。
- 失敗時は元 proposal を維持する。
- refinement 結果は自動採用しない。
- refinement 結果は自動保存しない。

### 11.3 VLM の扱い

VLM は `AIに直させる` 内の `画像を見せて再提案` でだけ明示実行する。

守ること:

- config だけで自動送信しない。
- review 画面を開いただけで自動送信しない。
- `比較を更新` では VLM を使わない。
- `この内容で確定` では VLM を使わない。
- VLM observation は二次観測であり、deterministic checks を上書きしない。
- VLM observation は patch ではなく、text model に渡す補助 context とする。

---

## 12. テスト計画

### 12.1 unit: `test/reviewEvents.test.ts`

追加する test 名:

```ts
test("buildReviewEvents: annotation の field hunks を 1 event にまとめる", () => {});
test("buildReviewEvents: caption text hunk に字幕文言タイトルを付ける", () => {});
test("buildReviewEvents: blur add に確認ポイントを付ける", () => {});
test("buildReviewEvents: id 無し配列 hunk も event にする", () => {});
test("buildReviewEvents: start/end field から source timeRange を作る", () => {});
test("reviewEventStatus: 全 theirs は use", () => {});
test("reviewEventStatus: 全 mine は skip", () => {});
test("reviewEventStatus: 採否が混ざると mixed", () => {});
test("warningSummary: event warning を件数要約する", () => {});
```

fixture は最小の `Hunk` object を手で作る。

注意:

- `Hunk` object identity が Map key になるので、test では同じ object 参照を使う。
- `ReviewBundle` の巨大 fixture は不要。warning 紐付け test は Phase 6 で足せばよい。

### 12.2 existing tests

必ず実行:

```sh
npm run typecheck
node --test test/reviewEvents.test.ts test/docDiff.test.ts test/editorAi.test.ts test/editorServer.test.ts
```

refinement 実装後に追加で必ず実行:

```sh
node --test test/editorAi.test.ts test/editorServer.test.ts test/review.test.ts
```

最終確認:

```sh
npm test
```

### 12.3 manual check

開発者が GUI で確認するシナリオ:

1. 保存済み project を開く。
2. AI 一発編集を実行する。
3. review 画面が `AiVisualReview` で開く。
4. 変更リストに event が表示される。
5. event を選ぶと右ペインが変わる。
6. `使わない` を押すと status が `使わない` になる。
7. `比較を更新` で before / after still が表示される。
8. `Before` / `AI編集後` / `左右比較` / `重ねて比較` を切り替えられる。
9. `AIに直させる` から画像なし再提案ができ、新 proposal として review に戻る。
10. `AIに直させる` から画像あり再提案を押すまで VLM が実行されない。
11. `詳細: JSON diff` を開くと hunk 値が見える。
12. `この内容で確定` で保存される。
13. `node src/cli.ts validate <dir>` が通る。

---

## 13. 受け入れ条件

完了条件:

- AI proposal review の初期画面で JSON hunk が主役ではない。
- 左に変更リスト、中央に AI 編集後 preview / comparison、右に選択中変更が表示される。
- 変更単位で `使う` / `使わない` を選べる。
- 選択は既存 `applyProposalResolution()` に反映される。
- JSON diff は詳細として残っている。
- review 開始後に deterministic 比較が自動生成される。
- `比較を更新` は stale / 失敗時の補助操作として動く。
- `AI編集後` / `Beforeを見る` / `左右比較` / `重ねて比較` がある。
- `AIに直させる` から画像なし再提案と画像あり再提案を選べる。
- 画像あり再提案は明示 button を押したときだけ VLM を使う。
- refinement 後は新 proposal として review に戻り、自動採用されない。
- `この内容で確定` は保存まで行い、既存 validate gate を通る。
- 外部変更 conflict review は壊れていない。
- `npm run typecheck` と関連 test が通る。

---

## 14. 実装上の注意

### 14.1 `Hunk.address.label` を正にしすぎない

label は表示・対応用に便利だが、完全な一意性を保証する設計ではない。
event grouping には `file / arrayKey / elementId / field` を使う。

### 14.2 hunk object identity を壊さない

`resolution` は `Map<Hunk, Side>` なので、hunk を clone すると採否が読めなくなる。

禁止:

```ts
const hunks = aiWorkflowReview.diff.hunks.map((h) => ({ ...h }));
```

許可:

```ts
const hunks = aiWorkflowReview.diff.hunks;
```

### 14.3 event は保存しない

`ReviewEvent` は render 時に作る表示用データ。proposal store や disk に保存しない。

### 14.4 CSS は既存設計に寄せる

- border radius は 8px 以下。
- button は既存 `.primary` を使う。
- 画面内説明文を増やしすぎない。
- JSON は details 内だけにする。

### 14.5 generated artifact を編集しない

次は編集禁止:

- `review.probe/`
- `frames/`
- `render.chunks/`
- `manifest.json`
- `preview.mp4`

---

## 15. 今回の範囲外

次はセカンドオピニオン全採用の範囲には含めない。別設計で扱う。

### 15.1 GUI editable docs の拡張

`chapters` / `meta` / `thumbnail` を AI review の対象に含めるには、まず GUI の
`ReviewDocs` / save body / editor UI がそれらを扱う必要がある。

今回の検品モードでは既存 GUI 対象の docs に限定する。

### 15.2 proposal 永続化

proposal history を disk に残す場合、次を決める必要がある。

- generated / editable / approval のどれに分類するか
- `AGENTS_CONTRACT.md` と `src/lib/files.ts` の更新
- 期限切れ proposal の削除 policy
- 個人情報や画像観測 text の保存可否

今回の実装では proposal store は memory のままにする。

### 15.3 本格的な pixel diff

`重ねて比較` は opacity overlay までとする。

次は今回やらない。

- pixel 差分 heatmap
- motion vector 差分
- object tracking
- annotation / blur の自動追跡補正
- VLM による座標生成

---

## 16. 実装者向けの最短手順

弱い実装モデルは、次の順に小さい PR として進める。

1. `src/lib/reviewEvents.ts` と `test/reviewEvents.test.ts` だけ作る。
2. `AiVisualReview.tsx` を作り、props を受けて event list と右ペインだけ出す。
3. `App.tsx` の AI proposal review だけ `AiVisualReview` に差し替える。
4. `使う` / `使わない` が保存結果へ反映されることを確認する。
5. still preview を足す。
6. JSON diff details を足す。
7. review 開始時の自動 deterministic 比較を足す。
8. `重ねて比較` と review modal 内 timeline marker を足す。
9. VLM checkbox を削除し、`AIに直させる` panel を足す。
10. `/api/ai/refine` と `refineEditorAi()` を足す。
11. before / after clip の同期再生を足す。
12. `npm run typecheck` と関連 test を通す。

途中で迷った場合は、`docDiff.ts` と保存経路を変えない。UX 表示レイヤだけで解決する。
